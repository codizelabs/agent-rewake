import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { fsyncDir, renameWithRetry } from "../util/fs.js";
import { ensurePrivateDir } from "../util/paths.js";
import { parseCron } from "./cron.js";
import { SessionLock } from "./lock.js";

/** For short synchronous pauses (Atomics.wait). */
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** Lifecycle states of a scheduled message. */
export type ScheduleStatus =
  | "scheduled"
  | "paused"
  | "queued"
  | "waiting_for_limit"
  | "sending"
  | "sent"
  | "failed"
  | "missed"
  | "stopped"
  | "cancelled"
  | "needs_attention";

export const TERMINAL_STATUSES: ReadonlySet<ScheduleStatus> = new Set([
  "sent",
  "failed",
  "stopped",
  "cancelled",
]);

export interface Attempt {
  n: number;
  idempotencyKey: string;
  startedAt: number;
  outcome?: string;
}

/** One scheduled message. Stored as schedules/<scheduleId>.json. */
export interface Schedule {
  schemaVersion: 1;
  scheduleId: string;
  sessionId: string;
  cwd: string;
  kind: "user" | "limit_resume" | "auto_limit_resume";
  text: string;
  dueAt: number;
  createdBy: "command" | "form" | "tui" | "cli" | "auto" | "agent";
  /**
   * Repeating schedule: `dueAt` is the next run; a cron expression, local time.
   * Optional end: no run after `until`, and at most `remaining` more runs.
   */
  repeat?: Repeat;
  status: ScheduleStatus;
  attempts: Attempt[];
  createdAt: number;
  updatedAt: number;
  failureReason?: string;
  /** A failed run's last error line from the agent, cleaned of paths and keys. */
  failureMessage?: string;
  /** A repeating message's previous run: when it was due and how it ended. */
  lastRun?: { at: number; outcome: ScheduleStatus | "skipped" };
  /**
   * Messages to send after this one, in order, each when the reply before it finishes
   *. Used for resumes: they wait with the resume if the limit moves.
   */
  followUps?: string[];
  /**
   * The integration that owns this schedule. Missing means the ACP add-on (every schedule written
   * so far). Records from an integration this version doesn't know are ignored entirely: see
   * `KNOWN_HOSTS`.
   */
  host?: string;
  /** What the owning integration needs to reach the session again (thread id, session file, cwd). */
  sessionRef?: Record<string, string>;
  /** Times a resume was put back after the agent was still limited (missing = 0). */
  rearms?: number;
}

/**
 * Integrations this version can deliver for. A record naming any other host was written by a
 * newer Rewake (for example before a rollback) and is skipped like an invalid file, so this
 * version never sends, changes or deletes it.
 */
const knownHosts = new Set(["acp"]);
export const KNOWN_HOSTS: ReadonlySet<string> = knownHosts;

/** Called by each integration this version ships (src/hosts/), so its records are read. */
export function registerHost(id: string): void {
  knownHosts.add(id);
}
/** Bounds on `sessionRef`, so a hand-edited or hostile file stays small. */
const MAX_SESSION_REF_KEYS = 8;
const MAX_SESSION_REF_BYTES = 4096;

function validSessionRef(r: unknown): boolean {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return false;
  const entries = Object.entries(r);
  return (
    entries.length <= MAX_SESSION_REF_KEYS &&
    entries.every(([, v]) => typeof v === "string") &&
    Buffer.byteLength(JSON.stringify(r)) <= MAX_SESSION_REF_BYTES
  );
}

export interface Repeat {
  cron: string;
  until?: number;
  remaining?: number;
}

function validRepeat(r: unknown): boolean {
  if (typeof r !== "object" || r === null) return false;
  const x = r as Record<string, unknown>;
  return (
    typeof x.cron === "string" &&
    parseCron(x.cron).ok &&
    (x.until === undefined || (typeof x.until === "number" && Number.isFinite(x.until))) &&
    (x.remaining === undefined ||
      (typeof x.remaining === "number" && Number.isInteger(x.remaining) && x.remaining >= 1))
  );
}

/** Limits that keep a hand-edited or hostile file from doing harm. */
export const MAX_TEXT_BYTES = 16 * 1024;
/** At most this many messages wait after one scheduled message (`followUps`). */
export const MAX_FOLLOW_UPS = 20;

function validFollowUps(t: unknown): boolean {
  return (
    Array.isArray(t) &&
    t.length <= MAX_FOLLOW_UPS &&
    t.every(
      (x) => typeof x === "string" && x.trim().length > 0 && Buffer.byteLength(x) <= MAX_TEXT_BYTES,
    )
  );
}
const STATUSES = new Set<string>([
  "scheduled",
  "paused",
  "queued",
  "waiting_for_limit",
  "sending",
  "sent",
  "failed",
  "missed",
  "stopped",
  "cancelled",
  "needs_attention",
]);

export function validateSchedule(value: unknown): Schedule | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const s = value as Record<string, unknown>;
  const ok =
    s.schemaVersion === 1 &&
    typeof s.scheduleId === "string" &&
    /^[0-9a-f-]{36}$/.test(s.scheduleId) &&
    typeof s.sessionId === "string" &&
    s.sessionId.length > 0 &&
    typeof s.cwd === "string" &&
    (s.kind === "user" || s.kind === "limit_resume" || s.kind === "auto_limit_resume") &&
    typeof s.text === "string" &&
    s.text.trim().length > 0 &&
    Buffer.byteLength(s.text) <= MAX_TEXT_BYTES &&
    typeof s.dueAt === "number" &&
    Number.isFinite(s.dueAt) &&
    typeof s.status === "string" &&
    STATUSES.has(s.status) &&
    Array.isArray(s.attempts) &&
    typeof s.createdAt === "number" &&
    typeof s.updatedAt === "number" &&
    (s.repeat === undefined || validRepeat(s.repeat)) &&
    (s.followUps === undefined || validFollowUps(s.followUps)) &&
    (s.host === undefined || (typeof s.host === "string" && KNOWN_HOSTS.has(s.host))) &&
    (s.sessionRef === undefined || validSessionRef(s.sessionRef)) &&
    (s.rearms === undefined ||
      (typeof s.rearms === "number" && Number.isInteger(s.rearms) && s.rearms >= 0));
  return ok ? (value as Schedule) : undefined;
}

/**
 * Write a file atomically: temp file, fsync, rename, then fsync the directory
 *. A crash leaves either the old file or the new one, never a torn file.
 */
export function writeFileAtomic(dir: string, name: string, data: string): void {
  const tmp = join(dir, `.${name}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameWithRetry(tmp, join(dir, name));
  fsyncDir(dir);
}

/** One file per schedule, so the TUI, the CLI and Rewake processes never rewrite each other's data. */
export class ScheduleStore {
  readonly dir: string;

  constructor(private readonly stateDir: string) {
    this.dir = join(stateDir, "schedules");
  }

  private ensure(): string {
    return ensurePrivateDir(this.dir);
  }

  create(input: {
    sessionId: string;
    cwd: string;
    text: string;
    dueAt: number;
    kind?: Schedule["kind"];
    createdBy: Schedule["createdBy"];
    now: number;
    repeat?: Repeat;
    followUps?: string[];
  }): Schedule {
    const schedule: Schedule = {
      schemaVersion: 1,
      scheduleId: randomUUID(),
      sessionId: input.sessionId,
      cwd: input.cwd,
      kind: input.kind ?? "user",
      text: input.text,
      dueAt: input.dueAt,
      createdBy: input.createdBy,
      status: "scheduled",
      ...(input.repeat && { repeat: { ...input.repeat } }),
      ...(input.followUps && input.followUps.length > 0 && { followUps: [...input.followUps] }),
      attempts: [],
      createdAt: input.now,
      updatedAt: input.now,
    };
    if (!validateSchedule(schedule))
      throw new Error("Invalid scheduled message (empty or too long).");
    this.put(schedule);
    return schedule;
  }

  put(schedule: Schedule): void {
    writeFileAtomic(
      this.ensure(),
      `${schedule.scheduleId}.json`,
      `${JSON.stringify(schedule, null, 2)}\n`,
    );
  }

  get(scheduleId: string): Schedule | undefined {
    if (!/^[0-9a-f-]{36}$/.test(scheduleId)) return undefined;
    try {
      return validateSchedule(
        JSON.parse(readFileSync(join(this.dir, `${scheduleId}.json`), "utf8")),
      );
    } catch {
      return undefined;
    }
  }

  /** All valid schedules. Invalid or unreadable files are skipped, never trusted. */
  list(): Schedule[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: Schedule[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const s = this.get(name.slice(0, -".json".length));
      if (s) out.push(s);
    }
    return out.sort((a, b) => a.dueAt - b.dueAt);
  }

  /**
   * One session's schedules, for the integration that owns them: the Zed add-on (`acp`, also
   * records without a host) by default. Codex in Zed and Codex's own hooks can share a thread id,
   * so each sees only its own records and a message is never delivered twice.
   */
  listForSession(sessionId: string, host = "acp"): Schedule[] {
    return this.list().filter((s) => s.sessionId === sessionId && (s.host ?? "acp") === host);
  }

  remove(scheduleId: string): boolean {
    if (!this.get(scheduleId)) return false;
    rmSync(join(this.dir, `${scheduleId}.json`), { force: true });
    return true;
  }

  /**
   * Update a schedule if it still exists. Returns the updated copy, or the current one when
   * `change` returns undefined (nothing to change). The read and the write hold a short lock, so a
   * change made by another process at the same moment (a cancel while `fire` decides) isn't lost.
   */
  update(
    scheduleId: string,
    change: (s: Schedule) => Schedule | undefined,
    now: number,
  ): Schedule | undefined {
    const lock = new SessionLock(this.stateDir);
    const key = `write:${scheduleId}`;
    // Held only for a read and a write; after about two seconds, a stuck holder is ignored.
    let held = lock.acquire(key);
    for (let i = 0; !held && i < 200; i++) {
      Atomics.wait(PAUSE, 0, 0, 10);
      held = lock.acquire(key);
    }
    try {
      const current = this.get(scheduleId);
      if (!current) return undefined;
      const changed = change(current);
      if (!changed) return current;
      const next = { ...changed, updatedAt: now };
      if (!validateSchedule(next)) throw new Error("Invalid scheduled message after update.");
      this.put(next);
      return next;
    } finally {
      if (held) lock.release(key);
    }
  }

  /**
   * Cancel a planned message. One already being sent, or finished, is left as it is: returns
   * whether it was cancelled.
   */
  cancel(scheduleId: string, now: number): boolean {
    let done = false;
    this.update(
      scheduleId,
      (x) => {
        if (x.status === "sending" || TERMINAL_STATUSES.has(x.status)) return undefined;
        done = true;
        return { ...x, status: "cancelled" };
      },
      now,
    );
    return done;
  }
}
