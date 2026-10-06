import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIN_CLAUDE_CODE,
  modDir,
  modInstalled,
  pickClaude,
  type Run,
  runClaudeInstall,
} from "../src/hosts/claude-code/install.js";

let dir: string;
let bundle: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-claude-"));
  // A packaged Rewake: the bundle with the mod beside it.
  bundle = join(dir, "pkg", "dist", "agent-rewake.js");
  mkdirSync(join(dir, "pkg", "dist", "hosts", "claude-code", ".claude-plugin"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "pkg", "dist", "hosts", "claude-code", ".claude-plugin", "plugin.json"),
    "{}",
  );
  writeFileSync(bundle, "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake `claude` that answers the way 2.1.291 does (research note §A.2.1), and records calls. */
function fake(o: { blocked?: boolean; fail?: boolean; installed?: () => void } = {}) {
  const calls: string[] = [];
  const run: Run = async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "test")
      return o.blocked
        ? {
            status: 1,
            stdout: "",
            stderr:
              "claude plugin test: hooks modules are turned off here (disableAllHooks, allowManagedHooksOnly or a policy)",
          }
        : { status: 1, stdout: "", stderr: "claude plugin test: no hooks module to load" };
    if (args[1] === "install") {
      if (o.fail)
        return {
          status: 1,
          stdout: '{"command":"install","outcome":"failed","message":"blocked by policy"}',
          stderr: "",
        };
      o.installed?.();
      return {
        status: 0,
        stdout: 'Installing…\n{"command":"install","outcome":"ok","plugin":"rewake@agent-rewake"}',
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

async function install(
  o: Partial<Parameters<typeof runClaudeInstall>[0]> & { claude?: ReturnType<typeof fake> } = {},
) {
  const claude = o.claude ?? fake();
  let output = "";
  const state = join(dir, "state");
  const code = await runClaudeInstall({
    uninstall: false,
    yes: true,
    dryRun: false,
    env: { HOME: join(dir, "home") },
    stateDir: state,
    node: process.execPath,
    bundle,
    interactive: false,
    out: (t) => {
      output += t;
    },
    ask: async () => true,
    programs: [{ path: "/usr/local/bin/claude", surface: "terminal", version: "2.1.292" }],
    runner: () => claude.run,
    ...o,
  });
  return { code, output, calls: claude.calls, state };
}

describe("install --only claude-code", () => {
  it("copies the mod to Rewake's folder, tells it where state lives, and installs it with Claude Code's commands", async () => {
    const r = await install();
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      expect.stringMatching(/^plugin test /),
      `plugin marketplace add ${modDir(r.state)}`,
      "plugin install rewake@agent-rewake --scope user --json",
    ]);
    expect(JSON.parse(readFileSync(join(modDir(r.state), "rewake.json"), "utf8"))).toEqual({
      stateDir: r.state,
    });
    expect(r.output).toContain("Agent Rewake (preview) will add its plugin to Claude Code 2.1.292");
    expect(r.output).toContain("restart Claude Code, or type /reload-plugins");
  });

  it("refreshes the recorded version when it's already installed", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      '{"plugins":{"rewake@agent-rewake":[]}}',
    );
    expect(modInstalled({}, home)).toBe(true);
    const r = await install();
    expect(r.output).toContain("will update its plugin in");
    expect(r.calls.at(-1)).toBe("plugin update rewake@agent-rewake --json");
  });

  it("changes nothing when mods are turned off by a setting or a policy", async () => {
    const r = await install({ claude: fake({ blocked: true }) });
    expect(r.code).toBe(1);
    expect(r.output).toContain("Plugins with hooks are turned off in this Claude Code");
    expect(r.calls).toEqual([expect.stringMatching(/^plugin test /)]);
  });

  it("undoes the marketplace and the folder when the plugin can't be installed", async () => {
    const r = await install({ claude: fake({ fail: true }) });
    expect(r.code).toBe(1);
    expect(r.calls.slice(-1)).toEqual(["plugin marketplace remove agent-rewake"]);
    expect(r.output).toContain(
      "Claude Code couldn't add the plugin, so nothing was changed. blocked by policy",
    );
  });

  it("refuses a Claude Code that's too old for mods, with the fix", async () => {
    const r = await install({
      programs: [{ path: "/c", surface: "terminal", version: "2.1.285" }],
    });
    expect(r.code).toBe(1);
    expect(r.output).toContain(`needs ${MIN_CLAUDE_CODE} or newer`);
    expect(r.calls).toEqual([]);
  });

  it("changes nothing on a dry run or without a terminal", async () => {
    expect(
      (await install({ dryRun: true })).calls.filter((c) => !c.startsWith("plugin test")),
    ).toEqual([]);
    const r = await install({ yes: false, interactive: false });
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => !c.startsWith("plugin test"))).toEqual([]);
  });

  it("picks the newest Claude Code", () => {
    expect(
      pickClaude([
        { path: "/a", surface: "terminal", version: "2.1.282" },
        { path: "/b", surface: "terminal", version: "2.1.292" },
      ])?.path,
    ).toBe("/b");
  });
});
