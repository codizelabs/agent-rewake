import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../core/store.js";
import { claudePrograms, compareVersions, type Program } from "../../install/detect.js";
import { ensurePrivateDir } from "../../util/paths.js";
import { codexProgram as nodeAware } from "../codex/cli.js";

/**
 * `agent-rewake install --only claude-code` (a preview, until the real-account checks of plan
 * §9.1.5 pass): Rewake's mod for Claude Code, installed with Claude Code's own plugin commands
 * from a local marketplace in Rewake's folder (observed on 2.1.291, research note §A.2):
 *
 *   claude plugin marketplace add <stateDir>/hosts/claude-code
 *   claude plugin install rewake@agent-rewake --scope user --json
 *
 * No prompt and no trust question for a local folder. Claude Code records it in its own settings;
 * Rewake never edits them. The plugin loads in place, so updating Rewake updates the mod at the
 * next session start.
 */

/** Mods load from Claude Code 2.1.287 in a terminal (2.1.286 in the desktop app). */
export const MIN_CLAUDE_CODE = "2.1.287";
export const PLUGIN = "rewake@agent-rewake";
export const MARKETPLACE = "agent-rewake";

export function modDir(stateDir: string): string {
  return join(stateDir, "hosts", "claude-code");
}

/** Where the package keeps the mod: `dist/hosts/claude-code` beside the bundle. */
export function shippedMod(bundle: string): string {
  // npx and global installs start Rewake through a link in a bin folder: follow it to the package.
  let real = bundle;
  try {
    real = realpathSync(bundle);
  } catch {
    // Not a file (tests pass a folder that may not exist yet): use it as given.
  }
  return join(dirname(real), "hosts", "claude-code");
}

/** Claude Code's settings folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

/** Whether Claude Code lists Rewake's plugin, from its own record of installed plugins. */
export function modInstalled(env: NodeJS.ProcessEnv, home: string): boolean {
  try {
    return readFileSync(
      join(claudeConfigDir(env, home), "plugins", "installed_plugins.json"),
      "utf8",
    ).includes(`"${PLUGIN}"`);
  } catch {
    return false;
  }
}

export type Run = (args: string[]) => Promise<{ status: number; stdout: string; stderr: string }>;

/** Run `claude <args>` with stdin closed and a minute's timeout. */
export function claudeRunner(path: string, env: NodeJS.ProcessEnv, node: string): Run {
  const program = nodeAware(path, node);
  return (args) =>
    new Promise((resolve) => {
      const child = execFile(
        program.command,
        [...program.args, ...args],
        { env, timeout: 60_000, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => {
          const code = (err as { code?: unknown } | null)?.code;
          resolve({
            status: err ? (typeof code === "number" ? code : 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
      child.stdin?.end();
    });
}

/** The JSON result Claude Code prints as the last line of a `--json` plugin command. */
function outcome(stdout: string): { outcome?: string; message?: string } {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(last) as { outcome?: string; message?: string };
  } catch {
    return {};
  }
}

/**
 * Whether mods can load here. `claude plugin test` on an empty folder says "hooks modules are
 * turned off here" under disableAllHooks, allowManagedHooksOnly or a policy (observed 2.1.291).
 */
export async function modsBlocked(run: Run): Promise<boolean> {
  const empty = mkdtempSync(join(tmpdir(), "rewake-probe-"));
  try {
    const r = await run(["plugin", "test", empty]);
    return /turned off here/i.test(`${r.stdout}\n${r.stderr}`);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

export interface ClaudeInstallOptions {
  uninstall: boolean;
  yes: boolean;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  node: string;
  /** The running Rewake bundle; the mod ships beside it. */
  bundle: string;
  interactive: boolean;
  out: (text: string) => void;
  ask: (question: string) => Promise<boolean>;
  /** Overridable for tests. */
  programs?: Program[];
  runner?: (path: string) => Run;
}

export function pickClaude(programs: Program[]): Program | undefined {
  return [...programs].sort((a, b) => compareVersions(b.version ?? "0", a.version ?? "0"))[0];
}

export async function runClaudeInstall(o: ClaudeInstallOptions): Promise<number> {
  const home = o.env.HOME || o.env.USERPROFILE || homedir();
  const programs = o.programs ?? claudePrograms({ env: o.env, home, platform: process.platform });
  const claude = pickClaude(programs);
  if (!claude) {
    o.out(
      "Claude Code wasn't found in a terminal on this computer, so there's nothing to set up for it.\n",
    );
    return 1;
  }
  const label = `Claude Code${claude.version ? ` ${claude.version}` : ""}`;
  const run = (o.runner ?? ((p) => claudeRunner(p, o.env, o.node)))(claude.path);
  const installed = modInstalled(o.env, home);

  if (o.uninstall) {
    if (!installed) {
      o.out("Rewake isn't set up in Claude Code: nothing to remove.\n");
      return 0;
    }
    o.out(
      `Agent Rewake will remove its plugin from ${label}, with Claude Code's own commands:\n  claude plugin uninstall ${PLUGIN}\n  claude plugin marketplace remove ${MARKETPLACE}\n`,
    );
  } else {
    if (claude.version && compareVersions(claude.version, MIN_CLAUDE_CODE) < 0) {
      o.out(
        `${label} is too old for Rewake (it needs ${MIN_CLAUDE_CODE} or newer). Update Claude Code, then run this again: claude update (or brew upgrade claude-code@latest).\n`,
      );
      return 1;
    }
    const source = shippedMod(o.bundle);
    if (!existsSync(join(source, ".claude-plugin", "plugin.json"))) {
      o.out("This copy of Agent Rewake doesn't include its Claude Code plugin.\n");
      return 1;
    }
    if (await modsBlocked(run)) {
      o.out(
        "Plugins with hooks are turned off in this Claude Code (by its settings or your organisation's), so Rewake can't run there. Nothing was changed.\n",
      );
      return 1;
    }
    o.out(
      [
        `Agent Rewake (preview) will ${installed ? "update its plugin in" : "add its plugin to"} ${label}, with Claude Code's own commands:`,
        `  claude plugin marketplace add "${modDir(o.stateDir)}"`,
        `  claude plugin install ${PLUGIN} --scope user`,
        "",
        "Claude Code records this in its own settings; Rewake doesn't edit them.",
        "",
      ].join("\n"),
    );
  }
  if (o.dryRun) {
    o.out("Dry run: nothing was changed.\n");
    return 0;
  }
  if (!o.yes) {
    if (!o.interactive) {
      o.out("Not a terminal, so nothing was changed. Run again with --yes to apply.\n");
      return 1;
    }
    if (!(await o.ask("\nApply these changes? [y/N] "))) {
      o.out("Nothing was changed.\n");
      return 1;
    }
  }

  if (o.uninstall) {
    await run(["plugin", "uninstall", PLUGIN, "--json"]);
    await run(["plugin", "marketplace", "remove", MARKETPLACE]);
    rmSync(modDir(o.stateDir), { recursive: true, force: true });
    if (modInstalled(o.env, home)) {
      o.out(
        "Claude Code couldn't remove the plugin. Try: claude plugin uninstall rewake@agent-rewake\n",
      );
      return 1;
    }
    o.out("Done. Rewake is out of Claude Code.\n");
    return 0;
  }

  // The mod, and where Rewake's state folder is (the mod has no other way to know).
  const dir = modDir(o.stateDir);
  rmSync(dir, { recursive: true, force: true });
  cpSync(shippedMod(o.bundle), ensurePrivateDir(dir), { recursive: true });
  writeFileAtomic(dir, "rewake.json", `${JSON.stringify({ stateDir: o.stateDir })}\n`);

  const add = await run(["plugin", "marketplace", "add", dir]);
  const inst =
    add.status === 0 ? await run(["plugin", "install", PLUGIN, "--scope", "user", "--json"]) : add;
  const ok = inst.status === 0 && outcome(inst.stdout).outcome === "ok";
  if (!ok) {
    if (add.status === 0) await run(["plugin", "marketplace", "remove", MARKETPLACE]);
    rmSync(dir, { recursive: true, force: true });
    const why = outcome(inst.stdout).message ?? inst.stderr.trim().slice(0, 300);
    o.out(`Claude Code couldn't add the plugin, so nothing was changed. ${why}\n`);
    return 1;
  }
  // Loaded in place already; this only refreshes the version Claude Code shows in /plugin.
  if (installed) await run(["plugin", "update", PLUGIN, "--json"]);
  o.out(
    [
      "",
      "Done.",
      "Next, restart Claude Code, or type /reload-plugins in a session that's open.",
      "When a session hits its usage limit and Claude Code won't continue it by itself, Rewake asks there whether to continue it when the limit resets.",
      "",
    ].join("\n"),
  );
  return 0;
}
