import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIN_CLAUDE_CODE,
  modDir,
  modInstalled,
  modVersion,
  pickClaude,
  type Run,
  refreshMod,
  runClaudeInstall,
  shippedMod,
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

describe("shippedMod", () => {
  it.skipIf(process.platform === "win32")(
    "follows the bin link npx and global installs start Rewake through",
    () => {
      mkdirSync(join(dir, "bin"));
      const link = join(dir, "bin", "agent-rewake");
      symlinkSync(bundle, link);
      expect(shippedMod(link)).toBe(
        join(realpathSync(join(dir, "pkg", "dist")), "hosts", "claude-code"),
      );
    },
  );
});

describe("several Claude Codes", () => {
  it("installs with the newest, and says when another is too old to load the plugin", async () => {
    const r = await install({
      programs: [
        { path: "/usr/local/bin/claude", surface: "terminal", version: "2.1.282" },
        {
          path: "/Claude/claude.app/Contents/MacOS/claude",
          surface: "desktop app",
          version: "2.1.289",
        },
      ],
    });
    expect(r.code).toBe(0);
    expect(r.output).toContain("will add its plugin to Claude Code 2.1.289");
    expect(r.output).toContain(
      'Claude Code in your terminal is 2.1.282, too old to load the plugin (it needs 2.1.287). Update it with "claude update" so Rewake works there too.',
    );
  });
});

describe("keeping the mod current", () => {
  const writePlugin = (root: string, version: string) => {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version }));
    writeFileSync(join(root, "hooks", "register.js"), `// ${version}\n`);
  };

  it("a newer Rewake refreshes the installed mod's files and keeps its state link", () => {
    const state = join(dir, "state");
    writePlugin(modDir(state), "0.1.0");
    writeFileSync(join(modDir(state), "rewake.json"), '{"stateDir":"x"}\n');
    writePlugin(join(dir, "pkg", "dist", "hosts", "claude-code"), "0.2.0");
    refreshMod(state, bundle, "0.2.0");
    expect(modVersion(modDir(state))).toBe("0.2.0");
    expect(readFileSync(join(modDir(state), "hooks", "register.js"), "utf8")).toBe("// 0.2.0\n");
    expect(readFileSync(join(modDir(state), "rewake.json"), "utf8")).toBe('{"stateDir":"x"}\n');
    // An older Rewake never replaces it.
    writePlugin(join(dir, "pkg", "dist", "hosts", "claude-code"), "0.1.5");
    refreshMod(state, bundle, "0.1.5");
    expect(modVersion(modDir(state))).toBe("0.2.0");
  });

  it("does nothing where the mod isn't installed", () => {
    const state = join(dir, "state");
    refreshMod(state, bundle, "9.9.9");
    expect(modVersion(modDir(state))).toBeUndefined();
  });

  it("installing again refreshes the files and never removes a working install", async () => {
    const home = join(dir, "home");
    const first = await install({
      claude: fake({
        installed: () => {
          mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
          writeFileSync(
            join(home, ".claude", "plugins", "installed_plugins.json"),
            '{"plugins":{"rewake@agent-rewake":[]}}',
          );
        },
      }),
    });
    expect(first.code).toBe(0);
    const again = await install({ claude: fake({ fail: true }) });
    expect(again.code).toBe(0);
    expect(again.calls.filter((c) => !c.startsWith("plugin test"))).toEqual([
      "plugin update rewake@agent-rewake --json",
    ]);
    expect(existsSync(join(modDir(again.state), ".claude-plugin", "plugin.json"))).toBe(true);
  });
});
