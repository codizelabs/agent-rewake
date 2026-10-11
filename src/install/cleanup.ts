import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { devinFile } from "../hosts/devin/install.js";
import { jetbrainsFile } from "../hosts/jetbrains/install.js";
import { installedPreviews, PREVIEW_NAMES } from "../hosts/previews.js";
import { planUninstall } from "../install.js";
import { launcherPath } from "../timers/launcher.js";
import { nodeShimPath } from "../timers/node-shim.js";
import { cancelTimer, defaultTimerHost, type TimerHost, timerIds } from "../timers/timers.js";
import { rewake } from "../util/command.js";
import { stateDir, zedConfigDir } from "../util/paths.js";

/**
 * What `uninstall` leaves, and what it cleans up once Rewake is out of every place.
 *
 * Rewake writes into its state folder, and a few files there are run by other programs: each hook
 * runs the launcher (`bin/agent-rewake.mjs`) through the Node.js finder (`bin/rewake-node`), timers
 * are files and system jobs, and the login item runs the launcher at every sign-in. While any
 * place still has Rewake set up, all of those stay: deleting them breaks that place's hooks. Once
 * none does, they go. What the person made or may want (their scheduled messages and settings, the
 * logs, backups of their own files, agents Rewake downloaded) is never deleted: it is listed, with
 * where it is.
 */

/** Whether `<dir>` holds anything (a folder that doesn't exist holds nothing). */
const hasFiles = (dir: string): boolean => {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};

/**
 * Remove the timers and the files that hooks, timers and the login item ran. Only call this when
 * no place is set up. Timers are cancelled through the system first (launchd, systemd, at, tasks),
 * so no job is left pointing at a file that is gone.
 */
export function removeHelpers(stateDir: string, timers: TimerHost): void {
  for (const id of timerIds(timers)) {
    try {
      cancelTimer(id, timers);
    } catch {
      // A job that is already gone.
    }
  }
  rmSync(join(stateDir, "timers"), { recursive: true, force: true });
  for (const file of [launcherPath(stateDir), nodeShimPath(stateDir)])
    rmSync(file, { force: true });
  rmSync(join(stateDir, "bin", "agent-rewake.version"), { force: true });
  try {
    // Only if empty: anything else in there isn't Rewake's to delete.
    rmdirSync(join(stateDir, "bin"));
  } catch {
    // Not empty, or not there.
  }
  rmSync(join(stateDir, "locks"), { recursive: true, force: true });
  rmSync(join(stateDir, ".pruned"), { force: true });
}

/** Rewake's backups of files it changed, next to those files, in these folders. */
export function findBackups(dirs: readonly string[]): string[] {
  const found = new Set<string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) if (n.includes(".agent-rewake-backup-")) found.add(join(dir, n));
  }
  return [...found].sort();
}

export interface LeftoverFacts {
  stateDir: string;
  /** Places Rewake is still set up in, by name (empty: it is out of all of them). */
  stillIn: string[];
  /** Backups of the person's files that Rewake made. */
  backups: string[];
  /** Codex was one of the places removed this time. */
  codex: boolean;
}

/**
 * The last words of `uninstall`: what is gone, and exactly what is still on the computer and why.
 * Undefined when there is nothing to say (Rewake never wrote a state folder here).
 */
export function leftoverText(f: LeftoverFacts): string | undefined {
  if (f.stillIn.length > 0)
    return `\nRewake is still set up in ${list(f.stillIn)}, so its folder and the files those places run stay where they are: deleting them would break ${f.stillIn.length === 1 ? "it" : "them"}. To take Rewake out of ${f.stillIn.length === 1 ? "it" : "them"} too, run: ${rewake("uninstall")}\n`;
  const kept: string[] = [];
  const mine = [
    hasFiles(join(f.stateDir, "schedules")) && "your scheduled messages",
    hasFiles(join(f.stateDir, "threads")) && "your thread settings",
    existsSync(join(f.stateDir, "settings.json")) && "your settings",
    hasFiles(join(f.stateDir, "logs")) && "logs (no message text)",
    hasFiles(join(f.stateDir, "agents")) && "agents Rewake downloaded",
  ].filter((x): x is string => typeof x === "string");
  if (mine.length > 0) kept.push(`Rewake's folder, with ${list(mine)}: ${f.stateDir}`);
  for (const b of f.backups) kept.push(`A copy Rewake made of a file before changing it: ${b}`);
  if (f.codex)
    kept.push(
      "Codex's own note that it trusted Rewake's hooks (Codex keeps it; Rewake can't remove it)",
    );
  if (kept.length === 0) return undefined;
  return `\nRewake is out of every place, and its timers, login item and helper files are removed. Still on your computer, because they're yours:\n${kept.map((k) => `  ${k}`).join("\n")}\nNothing runs from that folder any more, so you can delete it, and the copies, when you don't need them.\n`;
}

/**
 * After `uninstall` has run: if Rewake is out of every place, remove the timers and helper files
 * (`removeHelpers`); say what stays. Reads the places afresh, so a place whose uninstall failed
 * still counts as set up. Returns what to print and whether any place still has Rewake.
 */
export function finishUninstall(o: {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** The places this uninstall covered. */
  chosen: readonly string[];
}): { text: string | undefined; remains: boolean } {
  const state = stateDir(o.env);
  const zedDir = zedConfigDir(o.env);
  const stillIn = [
    ...(planUninstall(zedDir).changes.length > 0 ? ["Zed"] : []),
    ...installedPreviews(o.env, o.home, state).map((id) => PREVIEW_NAMES[id] ?? id),
  ];
  if (stillIn.length === 0 && existsSync(state))
    // Cancelling a timer needs only the state folder and the system's own tools, not Rewake's files.
    removeHelpers(state, defaultTimerHost(state, "node", launcherPath(state)));
  const backups = findBackups([
    zedDir,
    join(o.home, ".cursor"),
    dirname(jetbrainsFile(o.env, o.home)),
    dirname(devinFile(o.env, o.home, o.platform)),
  ]);
  const text = existsSync(state)
    ? leftoverText({ stateDir: state, stillIn, backups, codex: o.chosen.includes("codex") })
    : undefined;
  return { text, remains: stillIn.length > 0 };
}

function list(xs: readonly string[]): string {
  return xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}
