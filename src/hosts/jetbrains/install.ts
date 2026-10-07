import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyPlan, type FileChange, type LaunchCommand, type Plan } from "../../install.js";
import { WRAP_REGISTRY } from "../../wrap.js";

/**
 * `agent-rewake install --only jetbrains` (a preview): JetBrains IDEs' AI Assistant runs any agent
 * command listed in `~/.jetbrains/acp.json` (`agent_servers.<name>.{command,args,env}`, AI Assistant
 * 2026.2, jetbrains.com/help/ai-assistant/acp.html, research ide-surfaces-2026-10-07 §5). Rewake adds
 * its own entries, "Claude Agent (with Rewake)" and "Codex (with Rewake)", which run that agent
 * behind Rewake's ACP add-on, the same way as in Zed. Nothing else in the file changes; uninstall
 * removes only these entries. Not yet tried in a JetBrains IDE (experiment E-J1).
 *
 * After an IDE restart JetBrains starts a new session for a reopened thread (a user report,
 * 2026-07-16), so a resume planned before the restart isn't sent into it: Rewake only continues the
 * same session.
 */

/** The entries Rewake owns, by name, and the registry agent each runs. */
export const JETBRAINS_AGENTS: Record<string, string> = {
  "Claude Agent (with Rewake)": "claude-acp",
  "Codex (with Rewake)": "codex-acp",
};

export function jetbrainsFile(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return join(
    env.USERPROFILE && process.platform === "win32" ? env.USERPROFILE : home,
    ".jetbrains",
    "acp.json",
  );
}

/** JetBrains IDEs on this computer: their settings folder (any IDE, any version). */
export function jetbrainsFound(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): boolean {
  const dirs =
    platform === "darwin"
      ? [join(home, "Library", "Application Support", "JetBrains")]
      : platform === "win32"
        ? env.APPDATA
          ? [join(env.APPDATA, "JetBrains")]
          : []
        : [join(env.XDG_CONFIG_HOME || join(home, ".config"), "JetBrains")];
  return dirs.some((d) => existsSync(d)) || existsSync(join(home, ".jetbrains"));
}

/** Whether Rewake's entries are in the file. */
export function jetbrainsInstalled(env: NodeJS.ProcessEnv, home: string): boolean {
  const v = readJson(jetbrainsFile(env, home));
  const servers = v?.agent_servers;
  return (
    typeof servers === "object" &&
    servers !== null &&
    Object.keys(JETBRAINS_AGENTS).some((n) => n in (servers as object))
  );
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The change to `acp.json`: Rewake's entries added or updated (or removed), nothing else. */
export function planJetbrains(
  file: string,
  launch: LaunchCommand,
  uninstall: boolean,
): Plan | { error: string } {
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  const parsed = existed ? readJson(file) : {};
  if (!parsed)
    return {
      error: `Rewake couldn't set up JetBrains: the agent settings file (${file}) isn't valid JSON. Rewake didn't change it. Fix or remove the file, then run this again.`,
    };
  const servers =
    typeof parsed.agent_servers === "object" && parsed.agent_servers !== null
      ? { ...(parsed.agent_servers as Record<string, unknown>) }
      : {};
  const summary: string[] = [];
  for (const [name, id] of Object.entries(JETBRAINS_AGENTS)) {
    if (uninstall) {
      if (name in servers) {
        delete servers[name];
        summary.push(`Remove the agent "${name}"`);
      }
      continue;
    }
    const want = { command: launch.command, args: [...launch.args, WRAP_REGISTRY, id] };
    const had = servers[name];
    if (JSON.stringify(had) === JSON.stringify(want)) continue;
    servers[name] = want;
    summary.push(`${had ? "Update" : "Add"} the agent "${name}"`);
  }
  if (summary.length === 0) return { changes: [], notes: [] };
  const after = `${JSON.stringify({ ...parsed, agent_servers: servers }, null, 2)}\n`;
  const change: FileChange = { file, existed, before, after, summary };
  return { changes: [change], notes: [] };
}

export interface JetbrainsInstallOptions {
  uninstall: boolean;
  yes: boolean;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  launch: LaunchCommand;
  interactive: boolean;
  out: (text: string) => void;
  ask: (question: string) => Promise<boolean>;
  home?: string;
  /** Whether a JetBrains IDE is here (tests). */
  found?: boolean;
}

export async function runJetbrainsInstall(o: JetbrainsInstallOptions): Promise<number> {
  const home = o.home ?? (o.env.HOME || o.env.USERPROFILE || homedir());
  const file = jetbrainsFile(o.env, home);
  if (!o.uninstall && !(o.found ?? jetbrainsFound(o.env, home, process.platform))) {
    o.out(
      "No JetBrains IDE was found on this computer. Install one with AI Assistant, then run this again.\n",
    );
    return 1;
  }
  const plan = planJetbrains(file, o.launch, o.uninstall);
  if ("error" in plan) {
    o.out(`${plan.error}\n`);
    return 1;
  }
  if (plan.changes.length === 0) {
    o.out(
      o.uninstall
        ? "Rewake isn't set up in JetBrains IDEs: nothing to remove.\n"
        : "Rewake is already set up in JetBrains IDEs: nothing to change.\n",
    );
    return 0;
  }
  const change = plan.changes[0] as FileChange;
  o.out(
    [
      o.uninstall
        ? "Agent Rewake will remove its two agents from JetBrains AI Assistant:"
        : "Agent Rewake (preview) will add two agents to JetBrains AI Assistant:",
      ...Object.keys(JETBRAINS_AGENTS).map((n) => `  - ${n}`),
      "Your other agents stay as they are. Rewake keeps a backup of the settings file it changes.",
      "",
    ].join("\n"),
  );
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
  applyPlan(plan);
  o.out(
    o.uninstall
      ? "Done. Rewake is out of JetBrains IDEs. Restart your JetBrains IDE to see the change.\n"
      : '\nDone.\nNext, restart your JetBrains IDE, then pick "Claude Agent (with Rewake)" or "Codex (with Rewake)" as the agent in AI Assistant.\n',
  );
  return 0;
}
