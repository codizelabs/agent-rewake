import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnose, type Finding } from "../src/doctor.js";
import { zedLaunch } from "../src/install/zed-launch.js";
import { applyPlan, planInstall, planUninstall, runInstall } from "../src/install.js";
import { ensureLauncher, launcherPath, launcherVersion } from "../src/timers/launcher.js";
import { nodeShimPath } from "../src/timers/node-shim.js";

let dir: string;
let state: string;
let zed: string;
let bundle: string;
let env: NodeJS.ProcessEnv;

const SETTINGS =
  '// mine\n{ "agent_servers": { "claude-acp": { "type": "registry" }, "custom-one": { "type": "custom", "command": "/opt/x/run", "args": ["--acp"], "env": { "A": "1" } } } }\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-zedlaunch-"));
  state = join(dir, "state");
  zed = join(dir, "zed");
  mkdirSync(zed);
  bundle = join(dir, "agent-rewake.js");
  writeFileSync(bundle, "console.log('v-built');\n");
  env = {
    AGENT_REWAKE_ZED_CONFIG_DIR: zed,
    AGENT_REWAKE_ZED_DATA_DIR: join(dir, "data"),
    AGENT_REWAKE_STATE_DIR: state,
    HOME: dir,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entries = () =>
  (
    JSON.parse(readFileSync(join(zed, "settings.json"), "utf8").replace(/^\/\/.*\n/, "")) as {
      agent_servers: Record<string, { command: string; args: string[] }>;
    }
  ).agent_servers;

describe("Zed's entries start Rewake from its own folder", () => {
  it("names the Node.js finder and the stable copy, not npx or one Node.js folder", () => {
    const z = zedLaunch(state, bundle, "linux");
    expect(z.launch).toEqual({
      command: join(state, "bin", "rewake-node"),
      args: [join(state, "bin", "agent-rewake.mjs")],
    });
    // Choosing it writes nothing: files appear only when install applies the change.
    expect(existsSync(join(state, "bin"))).toBe(false);
  });

  it("is made when install applies, so the entry works though the files didn't exist before", async () => {
    writeFileSync(join(zed, "settings.json"), SETTINGS);
    const z = zedLaunch(state, bundle, "linux");
    let output = "";
    const code = await runInstall({
      uninstall: false,
      yes: true,
      dryRun: false,
      keybinding: false,
      env,
      agents: [],
      previews: [],
      launch: z.launch,
      prepare: z.prepare,
      out: (t) => {
        output += t;
      },
    });
    expect(code, output).toBe(0);
    expect(readFileSync(launcherPath(state), "utf8")).toBe("console.log('v-built');\n");
    expect(existsSync(nodeShimPath(state))).toBe(true);
    const servers = entries();
    // The Claude adapter is Rewake's own dependency, found next to the package Rewake starts from:
    // Rewake's one-file copy has no node_modules beside it and could not start it. Its entry keeps
    // starting from the package; the other agents' entries use Rewake's own folder.
    expect(servers["claude-acp"]?.command).not.toBe(nodeShimPath(state));
    expect(servers["claude-acp"]?.args).not.toContain(launcherPath(state));
    expect(servers["claude-acp"]?.args.slice(-2)).toEqual(["--wrap-registry", "claude-acp"]);
    expect(servers["custom-one"]?.command).toBe(nodeShimPath(state));
    expect(servers["custom-one"]?.args[0]).toBe(launcherPath(state));
  });

  it("writes nothing on a dry run, and nothing when the files can't be made", async () => {
    writeFileSync(join(zed, "settings.json"), SETTINGS);
    const z = zedLaunch(state, bundle, "linux");
    const base = {
      uninstall: false,
      keybinding: false,
      env,
      agents: [],
      previews: [],
      launch: z.launch,
      out: () => undefined,
    };
    await runInstall({ ...base, yes: true, dryRun: true, prepare: z.prepare });
    expect(existsSync(join(state, "bin"))).toBe(false);
    const code = await runInstall({
      ...base,
      yes: true,
      dryRun: false,
      prepare: () => {
        throw new Error("cannot write");
      },
    });
    expect(code).toBe(1);
    expect(readFileSync(join(zed, "settings.json"), "utf8")).toBe(SETTINGS);
  });

  it("uninstall through runInstall never makes the files, and isn't stopped by them", async () => {
    writeFileSync(join(zed, "settings.json"), SETTINGS);
    const z = zedLaunch(state, bundle, "linux");
    z.prepare();
    applyPlan(planInstall({ dir: zed, launch: z.launch, keybinding: false, env }));
    rmSync(join(state, "bin"), { recursive: true });
    const code = await runInstall({
      uninstall: true,
      yes: true,
      dryRun: false,
      keybinding: false,
      env,
      agents: [],
      previews: [],
      prepare: () => {
        throw new Error("must not run on uninstall");
      },
      out: () => undefined,
    });
    expect(code).toBe(0);
    expect(existsSync(join(state, "bin"))).toBe(false);
    expect(parse(readFileSync(join(zed, "settings.json"), "utf8"))).toEqual(parse(SETTINGS));
  });

  it("uninstall restores the original entries and leaves the files hooks use", async () => {
    writeFileSync(join(zed, "settings.json"), SETTINGS);
    const z = zedLaunch(state, bundle, "linux");
    z.prepare();
    applyPlan(planInstall({ dir: zed, launch: z.launch, keybinding: false, env }));
    expect(readFileSync(join(zed, "settings.json"), "utf8")).not.toBe(SETTINGS);
    applyPlan(planUninstall(zed));
    const restored = readFileSync(join(zed, "settings.json"), "utf8");
    expect(restored.startsWith("// mine\n")).toBe(true);
    expect(parse(restored)).toEqual(parse(SETTINGS));
    expect(existsSync(launcherPath(state))).toBe(true);
    expect(existsSync(nodeShimPath(state))).toBe(true);
  });

  it("moves an entry from earlier versions over, and says why", () => {
    writeFileSync(
      join(zed, "settings.json"),
      JSON.stringify({
        agent_servers: {
          "claude-acp": {
            type: "custom",
            command: "/home/u/.nvm/versions/node/v24.1.0/bin/node",
            args: [
              "/x/npx-cli.js",
              "--yes",
              "@codizelabs/agent-rewake@0.2.0",
              "--wrap-registry",
              "claude-acp",
            ],
          },
        },
      }),
    );
    const z = zedLaunch(state, bundle, "linux");
    const plan = planInstall({ dir: zed, launch: z.launch, keybinding: false, env });
    const text = plan.changes[0]?.summary.join("\n") ?? "";
    expect(text).toContain("start from Rewake's own folder");
    applyPlan(plan);
    expect(entries()["claude-acp"]?.command).toBe(nodeShimPath(state));
    // Running it again changes nothing.
    expect(
      planInstall({ dir: zed, launch: z.launch, keybinding: false, env }).notes.join(),
    ).toContain("already has Rewake");
  });

  it("keeps today's start on Windows, and from source when there is no copy to install", () => {
    const win = zedLaunch(state, bundle, "win32");
    expect(win.launch.command).not.toBe(nodeShimPath(state));
    win.prepare();
    expect(existsSync(join(state, "bin"))).toBe(false);
    const source = zedLaunch(state, join(dir, "main.ts"), "linux");
    expect(source.launch.command).not.toBe(nodeShimPath(state));
    // With the stable copy already there, a source run can still point at it.
    ensureLauncher(state, bundle);
    expect(zedLaunch(state, join(dir, "main.ts"), "linux").launch.command).toBe(
      nodeShimPath(state),
    );
  });

  it("an older Rewake never replaces a newer copy; a newer one does", () => {
    ensureLauncher(state, bundle, "99.0.0");
    writeFileSync(bundle, "console.log('older');\n");
    zedLaunch(state, bundle, "linux").prepare();
    expect(readFileSync(launcherPath(state), "utf8")).toBe("console.log('v-built');\n");
    expect(launcherVersion(state)).toBe("99.0.0");
    // The copy on file is now older than the running Rewake: install brings it up to date.
    writeFileSync(join(state, "bin", "agent-rewake.version"), "0.0.1\n");
    zedLaunch(state, bundle, "linux").prepare();
    expect(readFileSync(launcherPath(state), "utf8")).toBe("console.log('older');\n");
    expect(launcherVersion(state)).not.toBe("0.0.1");
  });

  it("the finder starts a working Node.js when the one it recorded is gone", () => {
    if (process.platform === "win32") return;
    zedLaunch(state, bundle, "linux").prepare();
    const text = readFileSync(nodeShimPath(state), "utf8");
    const gone = join(dir, "removed-node");
    writeFileSync(nodeShimPath(state), text.replace(/^RECORDED='.*'$/m, `RECORDED='${gone}'`));
    chmodSync(nodeShimPath(state), 0o700);
    expect(existsSync(gone)).toBe(false);
    const r = spawnSync(nodeShimPath(state), ["-p", "40 + 2"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: dir },
    });
    expect(r.stdout.trim()).toBe("42");
  }, 30_000);
});

describe("doctor and the stable start", () => {
  const run = (launch = zedLaunch(state, bundle, "linux").launch): Finding[] =>
    diagnose({
      env,
      now: Date.parse("2026-10-06T12:00:00Z"),
      platform: "darwin",
      home: dir,
      zedApps: () => [{ name: "Zed", version: "1.22.0" }],
      version: "0.1.2",
      nodeVersion: "24.1.0",
      launch,
    });
  const texts = (f: Finding[], level: Finding["level"]) =>
    f.filter((x) => x.level === level).map((x) => x.text);

  it("asks for install again when an entry still goes through npm or one Node.js folder", () => {
    writeFileSync(
      join(zed, "settings.json"),
      JSON.stringify({
        agent_servers: {
          "codex-acp": {
            type: "custom",
            command: process.execPath,
            args: [bundle, "--wrap-registry", "codex-acp"],
          },
        },
      }),
    );
    const f = run();
    expect(texts(f, "todo").join()).toContain("through npm or one Node.js folder");
  });

  it("does not ask for that when only the Claude adapter's entry starts from the package", () => {
    writeFileSync(
      join(zed, "settings.json"),
      JSON.stringify({
        agent_servers: {
          "claude-acp": {
            type: "custom",
            command: process.execPath,
            args: [bundle, "--wrap-registry", "claude-acp"],
          },
        },
      }),
    );
    expect(texts(run(), "todo").join()).not.toContain("through npm or one Node.js folder");
  });

  it("says nothing of the kind for a stable entry, and names its version", () => {
    const z = zedLaunch(state, bundle, "linux");
    z.prepare();
    writeFileSync(
      join(zed, "settings.json"),
      JSON.stringify({
        agent_servers: {
          "claude-acp": {
            type: "custom",
            command: z.launch.command,
            args: [...z.launch.args, "--wrap-registry", "claude-acp"],
          },
        },
      }),
    );
    expect(texts(run(), "todo").join()).not.toContain("through npm");
    writeFileSync(join(state, "bin", "agent-rewake.version"), "0.1.0\n");
    expect(texts(run(), "todo").join()).toContain("Zed starts Rewake 0.1.0; this is Rewake 0.1.2.");
    writeFileSync(join(state, "bin", "agent-rewake.version"), "0.9.0\n");
    expect(texts(run(), "info").join()).toContain("Zed starts Rewake 0.9.0, newer than this check");
  });

  it("reports a stable entry whose files were deleted", () => {
    const z = zedLaunch(state, bundle, "linux");
    writeFileSync(
      join(zed, "settings.json"),
      JSON.stringify({
        agent_servers: {
          "claude-acp": {
            type: "custom",
            command: z.launch.command,
            args: [...z.launch.args, "--wrap-registry", "claude-acp"],
          },
        },
      }),
    );
    expect(texts(run(), "problem").join()).toContain("has moved or been removed");
  });
});
