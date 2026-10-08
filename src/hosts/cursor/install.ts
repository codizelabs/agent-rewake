import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyPlan, type FileChange, type Plan } from "../../install.js";
import { ensureLauncher, launcherPath } from "../../timers/launcher.js";
import { rewake } from "../../util/command.js";

/**
 * `agent-rewake install --only cursor` (a preview): Cursor's own agent (the Agent panel, the Agents
 * window) runs hooks listed in `~/.cursor/hooks.json` (Cursor 3.23; research
 * cursor-agent-2026-10-08). Rewake adds two entries and keeps the person's own:
 *
 * - `beforeSubmitPrompt`: notes that the person typed in a chat (a planned continue is then
 *   dropped, and a waiting one stays silent: Cursor would otherwise submit it after their turn).
 * - `stop`: at a turn that ended in a usage limit, records it and waits, up to `WAIT_SECONDS`, for
 *   the time the person chooses (`agent-rewake continue`), then answers with Cursor's
 *   `followup_message`, which Cursor submits into the same chat (tested: E-C3). Other turns end it
 *   at once. Its long timeout is what lets it wait.
 *
 * Uninstall removes only Rewake's entries (they run `… hook cursor …`).
 */

/** How long Rewake's `stop` hook may wait in Cursor for the chosen time. */
export const WAIT_SECONDS = 4 * 60 * 60;

export const CURSOR_EVENTS = ["beforeSubmitPrompt", "stop"] as const;

export function cursorHooksFile(home: string): string {
  return join(home, ".cursor", "hooks.json");
}

/** Cursor on this computer: its app, or its command on PATH (never its settings folder alone). */
export function cursorFound(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): boolean {
  const apps =
    platform === "darwin"
      ? ["/Applications/Cursor.app", join(home, "Applications", "Cursor.app")]
      : platform === "win32"
        ? env.LOCALAPPDATA
          ? [join(env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe")]
          : []
        : ["/usr/share/cursor", "/opt/Cursor", "/opt/cursor"];
  if (apps.some((a) => existsSync(a))) return true;
  const sep = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? ["cursor.cmd", "cursor.exe"] : ["cursor"];
  return (env.PATH ?? "")
    .split(sep)
    .filter(Boolean)
    .some((d) => names.some((n) => existsSync(join(d, n))));
}

const OURS = /\bhook cursor\b/;
type Entry = Record<string, unknown> & { command?: unknown };

function readHooks(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether Rewake's entries are in Cursor's hooks file. */
export function cursorInstalled(home: string): boolean {
  const hooks = readHooks(cursorHooksFile(home))?.hooks;
  if (typeof hooks !== "object" || hooks === null) return false;
  return Object.values(hooks).some(
    (list) => Array.isArray(list) && list.some((e: Entry) => OURS.test(String(e?.command ?? ""))),
  );
}

// As for Gemini CLI and Grok: Windows paths can't contain double quotes; others are refused below.
const quote = (s: string) => `"${s}"`;

/** The change to hooks.json: Rewake's entries added or replaced (or removed), the rest kept. */
export function planCursor(
  file: string,
  node: string,
  launcher: string,
  uninstall: boolean,
): Plan | { error: string } {
  if (`${node}${launcher}`.includes('"'))
    return {
      error: `Rewake couldn't set up Cursor: the path to Node.js or to Rewake contains a double quote (${node}, ${launcher}). Rewake didn't change anything.`,
    };
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  const parsed = existed ? readHooks(file) : { version: 1, hooks: {} };
  if (!parsed)
    return {
      error: `Rewake couldn't set up Cursor: its hooks file (${file}) isn't valid JSON. Rewake didn't change it. Fix or remove the file, then run this again.`,
    };
  const hooks: Record<string, unknown> =
    typeof parsed.hooks === "object" && parsed.hooks !== null
      ? { ...(parsed.hooks as Record<string, unknown>) }
      : {};
  // Take out Rewake's own entries everywhere, then put the current ones back.
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e: Entry) => !OURS.test(String(e?.command ?? "")));
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!uninstall)
    for (const event of CURSOR_EVENTS) {
      const mine: Entry = {
        command: `${quote(node)} ${quote(launcher)} hook cursor ${event}`,
        timeout: event === "stop" ? WAIT_SECONDS : 10,
      };
      const list = Array.isArray(hooks[event]) ? (hooks[event] as Entry[]) : [];
      hooks[event] = [...list, mine];
    }
  const after = `${JSON.stringify({ ...parsed, version: parsed.version ?? 1, hooks }, null, 2)}\n`;
  if (after === before) return { changes: [], notes: [] };
  const summary = [
    uninstall
      ? "Remove Rewake's hooks from Cursor's agent"
      : "Add Rewake's hooks to Cursor's agent",
  ];
  const change: FileChange = { file, existed, before, after, summary };
  return { changes: [change], notes: [] };
}

export interface CursorInstallOptions {
  uninstall: boolean;
  yes: boolean;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  node: string;
  bundle: string;
  interactive: boolean;
  out: (text: string) => void;
  ask: (question: string) => Promise<boolean>;
  home?: string;
  /** Whether Cursor is here (tests). */
  found?: boolean;
}

export async function runCursorInstall(o: CursorInstallOptions): Promise<number> {
  const home = o.home ?? (o.env.HOME || o.env.USERPROFILE || homedir());
  const file = cursorHooksFile(home);
  if (!o.uninstall && !(o.found ?? cursorFound(o.env, home, process.platform))) {
    o.out("Cursor wasn't found on this computer, so there's nothing to set up for it.\n");
    return 1;
  }
  const launcher = o.dryRun
    ? launcherPath(o.stateDir)
    : (ensureLauncher(o.stateDir, o.bundle) ?? launcherPath(o.stateDir));
  const plan = planCursor(file, o.node, launcher, o.uninstall);
  if ("error" in plan) {
    o.out(`${plan.error}\n`);
    return 1;
  }
  if (plan.changes.length === 0) {
    o.out(
      o.uninstall
        ? "Rewake isn't set up in Cursor: nothing to remove.\n"
        : "Rewake is already set up in Cursor: nothing to change.\n",
    );
    return 0;
  }
  o.out(
    o.uninstall
      ? `Agent Rewake will remove its hooks from Cursor's agent:\n  ${file}\nYour own hooks stay. Rewake keeps a backup of the file.\n`
      : [
          "Agent Rewake (preview) will add its hooks to Cursor's own agent:",
          `  ${file}`,
          "",
          `When a Cursor chat stops at its usage limit, run "${rewake("continue")}" and pick a time within 4 hours. Rewake then continues that chat, as long as its window stays open. Typing in the chat cancels it. A limit that waiting won't lift (one that needs a paid plan or a new month) gets a notification instead. Your own hooks stay; Rewake keeps a backup of the file.`,
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
      ? "Done. Rewake is out of Cursor.\n"
      : '\nDone.\nNext, reload Cursor\'s window so its agent loads the hooks: in Cursor, run "Developer: Reload Window" from the Command Palette (or restart Cursor).\n',
  );
  return 0;
}
