import {
  type Dirent,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ScheduleStore, TERMINAL_STATUSES } from "../core/store.js";
import { SessionRecords } from "../hosts/sessions.js";

/**
 * Keeping Rewake's state folder small. Every hook reads every schedule and session record, so
 * thousands of old ones slow each hook down, and a write that failed (a full disk) leaves its
 * temporary file behind. Run by the sweep, at most once a day, it removes:
 *
 * - finished resumes and scheduled messages (sent, failed, stopped, cancelled) not touched for 30 days;
 * - the record of a session that is closed, not touched for 30 days, and that no resume still
 *   waiting needs (a resume reads the record for the session's settings);
 * - daily log files older than 30 days;
 * - temporary files left by a failed write, older than an hour.
 *
 * Anything still planned, paused, waiting for you or recent is never touched.
 */
export const KEEP_DAYS = 30;
/** A temporary file this old isn't a write in progress. */
export const TEMP_MAX_AGE_MS = 60 * 60_000;
/** The folder is looked over at most this often. */
const EVERY_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MARKER = ".pruned";
/** The temporary names `writeFileAtomic` and `writeTempExclusive` make. */
const TEMP_NAME = /^\..+\.tmp$/;
/** Folders that hold other programs' files: never entered. */
const SKIP_DIRS = new Set(["agents", "node_modules"]);
const MAX_DEPTH = 5;

export interface PruneResult {
  schedules: number;
  sessions: number;
  logs: number;
  temp: number;
}

/**
 * Prune the state folder. Returns undefined when it was done recently (or there is no folder
 * yet); `force` skips that check.
 */
export function pruneState(
  stateDir: string,
  now: number,
  opts: { keepDays?: number; force?: boolean } = {},
): PruneResult | undefined {
  if (!existsSync(stateDir)) return undefined;
  const marker = join(stateDir, MARKER);
  if (!opts.force)
    try {
      if (now - statSync(marker).mtimeMs < EVERY_MS) return undefined;
    } catch {
      // Never pruned: now is the time.
    }
  const cutoff = now - (opts.keepDays ?? KEEP_DAYS) * DAY_MS;
  const result: PruneResult = {
    schedules: 0,
    sessions: 0,
    logs: pruneLogs(stateDir, cutoff),
    temp: pruneTemp(stateDir, now - TEMP_MAX_AGE_MS),
  };
  const store = new ScheduleStore(stateDir);
  const needed = new Set<string>();
  for (const s of store.list()) {
    if (!TERMINAL_STATUSES.has(s.status)) needed.add(`${s.host ?? "acp"}:${s.sessionId}`);
    else if (s.updatedAt < cutoff && store.remove(s.scheduleId)) result.schedules++;
  }
  result.sessions = pruneSessions(stateDir, cutoff, needed);
  try {
    writeFileSync(marker, `${now}\n`, { mode: 0o600 });
    // The file's own time is what the next run compares, so it is set to the time given.
    utimesSync(marker, new Date(now), new Date(now));
  } catch {
    // Read-only or full: tried again at the next run.
  }
  return result;
}

function pruneSessions(stateDir: string, cutoff: number, needed: ReadonlySet<string>): number {
  let hosts: string[];
  try {
    hosts = readdirSync(join(stateDir, "hosts"));
  } catch {
    return 0;
  }
  let n = 0;
  for (const host of hosts) {
    const records = new SessionRecords(stateDir, host);
    for (const r of records.list()) {
      const last = Math.max(r.updatedAt, r.closedAt ?? 0, r.lastPromptAt ?? 0);
      if (r.open || last >= cutoff || needed.has(`${host}:${r.sessionId}`)) continue;
      if (records.remove(r.sessionId)) n++;
    }
  }
  return n;
}

function pruneLogs(stateDir: string, cutoff: number): number {
  const dir = join(stateDir, "logs");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  // By the date in the name (the day the file is for), not by its modified time.
  const oldest = new Date(cutoff).toISOString().slice(0, 10);
  let n = 0;
  for (const f of names) {
    const m = /^rewake-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (!m || (m[1] as string) >= oldest) continue;
    try {
      rmSync(join(dir, f), { force: true });
      n++;
    } catch {
      // In use or protected: left for next time.
    }
  }
  return n;
}

function pruneTemp(dir: string, before: number, depth = 0): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) n += pruneTemp(path, before, depth + 1);
    } else if (e.isFile() && TEMP_NAME.test(e.name)) {
      try {
        if (statSync(path).mtimeMs < before) {
          rmSync(path, { force: true });
          n++;
        }
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  }
  return n;
}
