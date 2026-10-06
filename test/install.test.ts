import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadStore } from "../src/core/threads.js";
import {
  AGENT_NAME,
  applyPlan,
  keyChord,
  type LaunchCommand,
  launchCommand,
  pinnedVersion,
  planInstall,
  planUninstall,
  runInstall,
  TASK_LABEL,
} from "../src/install.js";
import { canSymlink } from "./support.js";

const launch: LaunchCommand = {
  command: "/usr/local/bin/node",
  args: ["/opt/rewake/agent-rewake.js"],
};
const wrapped = (id: string) => [...launch.args, "--wrap-registry", id];

// Shaped like a real Zed settings file: comments, a trailing comma, several agents.
const SETTINGS = `// Zed settings
{
  "theme": "One Dark", // keep me
  "agent_servers": {
    "claude-acp": {
      "type": "registry",
      "default_config_options": { "model": "opus", "mode": "bypassPermissions" },
    },
    "codex-acp": { "type": "registry" },
  },
}
`;

// Zed's cached copy of the ACP Registry (external_agents/registry/registry.json).
const REGISTRY = {
  version: "1.0.0",
  agents: [
    {
      id: "claude-acp",
      name: "Claude Agent",
      distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.85.1" } },
    },
    {
      id: "codex-acp",
      name: "Codex CLI",
      distribution: { npx: { package: "@agentclientprotocol/codex-acp@2.1.1" } },
    },
    { id: "cursor", name: "Cursor", distribution: { binary: {} } },
    {
      id: "opencode",
      name: "OpenCode",
      version: "1.18.34",
      distribution: {
        binary: {
          "linux-x86_64": {
            archive: "https://example.test/o.tar.gz",
            cmd: "./opencode",
            args: ["acp"],
          },
        },
      },
    },
  ],
};

let dir: string;
let data: string;
let env: NodeJS.ProcessEnv;
const file = (name: string) => join(dir, name);
const json = (name: string) =>
  parse(readFileSync(file(name), "utf8"), [], { allowTrailingComma: true });
const plan = (o: { keybinding?: boolean; only?: string[] } = {}) =>
  planInstall({
    dir,
    launch,
    keybinding: o.keybinding ?? false,
    env,
    ...(o.only && { only: o.only }),
  });
const run = (args: Partial<Parameters<typeof runInstall>[0]>) => {
  let output = "";
  return runInstall({
    uninstall: false,
    yes: true,
    dryRun: false,
    keybinding: false,
    env,
    agents: [],
    out: (t) => {
      output += t;
    },
    ...args,
  }).then((code) => ({ code, output }));
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-zed-")));
  data = join(dir, "data");
  mkdirSync(join(data, "external_agents", "registry"), { recursive: true });
  writeFileSync(
    join(data, "external_agents", "registry", "registry.json"),
    JSON.stringify(REGISTRY),
  );
  env = { AGENT_REWAKE_ZED_CONFIG_DIR: dir, AGENT_REWAKE_ZED_DATA_DIR: data };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("agent-rewake install", () => {
  it("adds Rewake to each agent under its own id, keeping its settings, comments and threads", () => {
    writeFileSync(file("settings.json"), SETTINGS);
    const p = plan();
    expect(p.changes.map((c) => c.file)).toEqual([file("settings.json"), file("tasks.json")]);
    expect(p.changes[0]?.summary.join("\n")).toContain('Add Rewake to "claude-acp" (Claude Agent)');
    const backups = applyPlan(p, new Date("2026-10-04T10:00:00Z"));

    const text = readFileSync(file("settings.json"), "utf8");
    expect(text).toContain("// Zed settings");
    expect(text).toContain('"theme": "One Dark", // keep me');
    const servers = json("settings.json").agent_servers;
    expect(Object.keys(servers)).toEqual(["claude-acp", "codex-acp"]);
    expect(servers["claude-acp"]).toEqual({
      default_config_options: { model: "opus", mode: "bypassPermissions" },
      type: "custom",
      command: launch.command,
      args: wrapped("claude-acp"),
    });
    expect(servers["codex-acp"]).toEqual({
      type: "custom",
      command: launch.command,
      args: wrapped("codex-acp"),
    });
    expect(json("tasks.json")).toEqual([
      expect.objectContaining({ label: TASK_LABEL, args: [...launch.args, "ui"] }),
    ]);
    expect(backups).toEqual([`${file("settings.json")}.agent-rewake-backup-20261004-100000`]);
    expect(readFileSync(backups[0] ?? "", "utf8")).toBe(SETTINGS);
    expect(existsSync(file("keymap.json"))).toBe(false);
  });

  it("wraps custom agents with their own command, and leaves agents it can't wrap alone", () => {
    writeFileSync(
      file("settings.json"),
      JSON.stringify({
        agent_servers: {
          mine: { type: "custom", command: "/bin/my-agent", args: ["--acp"], env: { A: "1" } },
          cursor: { type: "registry" },
          opencode: { type: "registry" },
        },
      }),
    );
    env = { ...env, AGENT_REWAKE_PLATFORM: "linux-x86_64" };
    const p = plan();
    expect(p.notes.join("\n")).toMatch(
      /"cursor" \(Cursor\) left as is: it has no build for this computer/,
    );
    applyPlan(p);
    const servers = json("settings.json").agent_servers;
    expect(servers.mine).toEqual({
      env: { A: "1" },
      type: "custom",
      command: launch.command,
      args: [
        ...launch.args,
        "--wrap-command",
        JSON.stringify({ command: "/bin/my-agent", args: ["--acp"], id: "mine" }),
      ],
    });
    expect(servers.cursor).toEqual({ type: "registry" });
    // Binary registry agents are wrapped too, like npx ones.
    expect(servers.opencode).toEqual({
      type: "custom",
      command: launch.command,
      args: wrapped("opencode"),
    });
  });

  it("is idempotent: a second run changes nothing", () => {
    writeFileSync(file("settings.json"), SETTINGS);
    applyPlan(plan({ keybinding: true }));
    const again = plan({ keybinding: true });
    expect(again.changes).toEqual([]);
    expect(again.notes).toHaveLength(4);
  });

  it("sets up Claude Agent when Zed has no agents yet, and appends to an existing task list", () => {
    writeFileSync(
      file("tasks.json"),
      '[\n  // mine\n  { "label": "build", "command": "make" }\n]\n',
    );
    applyPlan(plan());
    expect(json("settings.json").agent_servers["claude-acp"].args).toEqual(wrapped("claude-acp"));
    const tasks = json("tasks.json");
    expect(tasks.map((t: { label: string }) => t.label)).toEqual(["build", TASK_LABEL]);
    expect(readFileSync(file("tasks.json"), "utf8")).toContain("// mine");
  });

  it("keeps the separate agent from earlier versions, so its threads open, and updates an out-of-date wrap", () => {
    writeFileSync(
      file("settings.json"),
      JSON.stringify({
        agent_servers: {
          [AGENT_NAME]: { type: "custom", command: "old" },
          "claude-acp": {
            type: "custom",
            command: "old-node",
            args: ["/old.js", "--wrap-registry", "claude-acp"],
          },
        },
      }),
    );
    applyPlan(plan());
    const servers = json("settings.json").agent_servers;
    // Zed ties threads to agent ids: removing it would leave them unopenable.
    expect(servers[AGENT_NAME]).toEqual({
      type: "custom",
      command: launch.command,
      args: wrapped("claude-acp"),
    });
    expect(servers["claude-acp"]).toEqual({
      type: "custom",
      command: launch.command,
      args: wrapped("claude-acp"),
    });
  });

  it("restores the separate agent an earlier install removed when threads were started with it", () => {
    writeFileSync(file("settings.json"), SETTINGS);
    const state = join(dir, "state");
    // A thread recorded by the earlier build: no agent id.
    new ThreadStore(state).update("old-thread", "/work", { title: "Old" }, Date.now());
    const p = planInstall({ dir, launch, keybinding: false, env, stateDir: state });
    expect(p.changes[0]?.summary.join("\n")).toContain('Restore "Agent Rewake"');
    applyPlan(p);
    expect(json("settings.json").agent_servers[AGENT_NAME].args).toEqual(wrapped("claude-acp"));
    // Without such threads, nothing is added back.
    rmSync(state, { recursive: true });
    expect(planInstall({ dir, launch, keybinding: false, env, stateDir: state }).changes).toEqual(
      [],
    );
  });

  it("wraps only the agents named with --agent", () => {
    writeFileSync(file("settings.json"), SETTINGS);
    applyPlan(plan({ only: ["codex-acp"] }));
    const servers = json("settings.json").agent_servers;
    expect(servers["claude-acp"].type).toBe("registry");
    expect(servers["codex-acp"].args).toEqual(wrapped("codex-acp"));
  });

  it("leaves a file it can't parse alone and says why", () => {
    writeFileSync(file("settings.json"), '{ "theme": ');
    const p = plan();
    expect(p.changes.map((c) => c.file)).toEqual([file("tasks.json")]);
    expect(p.notes.join("\n")).toMatch(/settings\.json: left alone/);
  });

  it("never takes a key the user already bound", () => {
    writeFileSync(
      file("keymap.json"),
      `[{ "bindings": { "${keyChord()}": "editor::Something" } }]`,
    );
    const p = plan({ keybinding: true });
    expect(p.changes.some((c) => c.file === file("keymap.json"))).toBe(false);
    expect(p.notes.join("\n")).toContain("already bound");
  });

  it.skipIf(!canSymlink)("writes through a symlinked settings file (dotfiles setups)", () => {
    const real = join(dir, "dotfiles");
    mkdirSync(real);
    writeFileSync(join(real, "settings.json"), SETTINGS);
    symlinkSync(join(real, "settings.json"), file("settings.json"));
    applyPlan(plan());
    expect(readFileSync(join(real, "settings.json"), "utf8")).toContain("--wrap-registry");
  });

  it("asks first, and writes nothing on no or without a terminal", async () => {
    writeFileSync(file("settings.json"), SETTINGS);
    expect((await run({ yes: false, interactive: true, ask: async () => false })).code).toBe(1);
    expect((await run({ yes: false, interactive: false })).code).toBe(1);
    expect((await run({ dryRun: true })).code).toBe(0);
    expect(readFileSync(file("settings.json"), "utf8")).toBe(SETTINGS);
    expect(readdirSync(dir).sort()).toEqual(["data", "settings.json"]);

    const yes = await run({ yes: false, interactive: true, ask: async () => true });
    expect(yes.code).toBe(0);
    expect(yes.output).toContain("Backup:");
    expect(yes.output).toContain('"Rewake" menu');
    expect(json("settings.json").agent_servers["claude-acp"].type).toBe("custom");
  });

  it("names other coding agents on this computer before asking, and says Rewake doesn't reach them", async () => {
    writeFileSync(file("settings.json"), SETTINGS);
    const agents = [
      { id: "codex" as const, name: "Codex", version: "0.160.1", surfaces: ["terminal"] },
    ];
    let output = "";
    let beforeQuestion = "";
    await run({
      yes: false,
      interactive: true,
      agents,
      out: (t) => {
        output += t;
      },
      ask: async () => {
        beforeQuestion = output;
        return false;
      },
    });
    expect(beforeQuestion).toContain(
      "Rewake works only in Zed's Agent Panel. It doesn't work with Zed's own agent, or with Codex used on its own in a terminal, another editor or a desktop app.",
    );
    // Without other agents, nothing is added.
    expect((await run({ dryRun: true })).output).not.toContain("used on their own");
    // Not when taking Rewake out.
    expect((await run({ uninstall: true, dryRun: true, agents })).output).not.toContain(
      "used on their own",
    );
  });

  it("says where Rewake works once: the next steps leave out the general line after the specific one", async () => {
    writeFileSync(file("settings.json"), SETTINGS);
    const agents = [
      { id: "codex" as const, name: "Codex", version: "0.160.1", surfaces: ["terminal"] },
    ];
    const specific = await run({ agents });
    expect(specific.output).toContain("or with Codex used on its own");
    expect(specific.output).not.toContain("It can't reach Zed's own agent");
    writeFileSync(file("settings.json"), SETTINGS);
    expect((await run({})).output).toContain("It can't reach Zed's own agent");
  });
});

describe("agent-rewake uninstall", () => {
  it("puts every agent back the way it was and removes only Rewake's entries", async () => {
    const custom = { type: "custom", command: "/bin/my-agent", args: ["--acp"], env: { A: "1" } };
    writeFileSync(
      file("settings.json"),
      SETTINGS.replace(
        '"codex-acp": { "type": "registry" },',
        `"codex-acp": { "type": "registry" },\n    "mine": ${JSON.stringify(custom)},`,
      ),
    );
    const userKey = keyChord() === "cmd-alt-r" ? "cmd-k" : "ctrl-k";
    writeFileSync(file("keymap.json"), `[{ "bindings": { "${userKey}": "editor::Mine" } }]`);
    writeFileSync(file("tasks.json"), '[{ "label": "build", "command": "make" }]');
    await run({ keybinding: true });
    expect(json("keymap.json")).toHaveLength(2);
    // Zed saves the last pick in Rewake's menu as a default; uninstall drops it again.
    const text = readFileSync(file("settings.json"), "utf8").replace(
      '"model": "opus",',
      '"model": "opus", "rewake": "abc.new",',
    );
    writeFileSync(file("settings.json"), text);

    const { code } = await run({ uninstall: true });
    expect(code).toBe(0);
    const servers = json("settings.json").agent_servers;
    expect(servers["claude-acp"]).toEqual({
      type: "registry",
      default_config_options: { model: "opus", mode: "bypassPermissions" },
    });
    expect(servers["codex-acp"]).toEqual({ type: "registry" });
    expect(servers.mine).toEqual(custom);
    expect(readFileSync(file("settings.json"), "utf8")).toContain("// keep me");
    expect(json("tasks.json")).toEqual([{ label: "build", command: "make" }]);
    expect(json("keymap.json")).toEqual([{ bindings: { [userKey]: "editor::Mine" } }]);
    expect(planUninstall(dir).changes).toEqual([]);
  });

  it("removes the separate agent from earlier versions", () => {
    writeFileSync(
      file("settings.json"),
      JSON.stringify({ agent_servers: { [AGENT_NAME]: { type: "custom", command: "x" } } }),
    );
    applyPlan(planUninstall(dir));
    expect(json("settings.json").agent_servers).toEqual({});
  });

  it("removes only the binding from a block the user shares", () => {
    writeFileSync(
      file("keymap.json"),
      `[{ "bindings": { "ctrl-k": "editor::Mine", "${keyChord()}": ["task::Spawn", { "task_name": "${TASK_LABEL}" }] } }]`,
    );
    applyPlan(planUninstall(dir));
    expect(json("keymap.json")).toEqual([{ bindings: { "ctrl-k": "editor::Mine" } }]);
  });
});

describe("launchCommand", () => {
  it("uses absolute paths normally, and a pinned npx command from npx's cache", () => {
    expect(launchCommand("/n/node", "/x/agent-rewake.js")).toEqual({
      command: "/n/node",
      args: ["/x/agent-rewake.js"],
    });
    const npx = launchCommand("/n/node", "/home/u/.npm/_npx/abc/node_modules/.bin/agent-rewake");
    expect(npx.args[0]).toBe("--yes");
    expect(npx.args[1]).toMatch(/^@codizelabs\/agent-rewake@/);
  });
});

describe("updating", () => {
  it("says which version it updates from and to", () => {
    const pinned = (v: string): LaunchCommand => ({
      command: "/usr/bin/node",
      args: ["/usr/lib/node_modules/npm/bin/npx-cli.js", "--yes", `@codizelabs/agent-rewake@${v}`],
    });
    const old = planInstall({ dir, launch: pinned("0.1.0"), keybinding: false, env });
    applyPlan(old);
    const next = planInstall({ dir, launch: pinned("0.1.2"), keybinding: false, env });
    expect(next.changes[0]?.summary.join("\n")).toContain("(from 0.1.0 to 0.1.2)");
    expect(pinnedVersion({ args: ["--yes", "@codizelabs/agent-rewake@0.1.2"] })).toBe("0.1.2");
    expect(pinnedVersion({ args: ["/x/agent-rewake.js"] })).toBeUndefined();
  });
});
