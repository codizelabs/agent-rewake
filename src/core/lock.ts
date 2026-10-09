import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { renameWithRetry } from "../util/fs.js";
import { ensurePrivateDir } from "../util/paths.js";

/**
 * Who holds a lock. Staleness is never decided by file age. A lock is held while its owner's PID
 * runs and is still the same process: the PID alone can be reused after a crash or a restart, so
 * the process's start time is recorded too. The host name is kept for people reading the file but
 * never decides anything: macOS changes it with the network.
 */
interface Owner {
  pid: number;
  hostname: string;
  token: string;
  createdAt: number;
  /** When the owner's process started, as the system reports it (absent where it can't). */
  start?: string;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads a process's start time as text, or undefined where the system can't say. */
export type StartOf = (pid: number) => string | undefined;

/**
 * Field 22 of Linux's `/proc/<pid>/stat` (start time in clock ticks since boot). The program name
 * (field 2) may hold spaces and brackets, so fields count from after its closing bracket.
 */
export function linuxStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close === -1) return undefined;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const start = fields[19];
  return start !== undefined && /^\d+$/.test(start) ? start : undefined;
}

/**
 * When `pid` started: `/proc` on Linux, `ps -o lstart=` on macOS and other POSIX systems. Windows
 * and anything unreadable give undefined, and the lock then relies on the PID alone.
 */
export const processStartTime: StartOf = (pid) => {
  if (process.platform === "win32") return undefined;
  try {
    if (process.platform === "linux")
      return linuxStartTime(readFileSync(`/proc/${pid}/stat`, "utf8"));
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      env: { ...process.env, LC_ALL: "C" },
    });
    const text = (r.stdout ?? "").trim();
    return r.status === 0 && text ? text : undefined;
  } catch {
    return undefined;
  }
};

let ownStart: { value: string | undefined } | undefined;
/** This process's own start time, read once. */
function myStart(startOf: StartOf): string | undefined {
  if (startOf !== processStartTime) return startOf(process.pid);
  ownStart ??= { value: startOf(process.pid) };
  return ownStart.value;
}

/**
 * Whether the lock's owner still runs: its PID is alive and, where both start times are known, it
 * started when the lock was taken (otherwise the PID was reused by another process).
 */
function ownerRuns(owner: Owner, alive: (pid: number) => boolean, startOf: StartOf): boolean {
  if (!alive(owner.pid)) return false;
  if (owner.start === undefined) return true;
  const now = startOf(owner.pid);
  return now === undefined || now === owner.start;
}

/**
 * Per-thread ownership lock: only the process holding a session's lock delivers that session's
 * scheduled messages. An O_EXCL file holds the owner; a lock whose owner is gone
 * is taken over by renaming it aside first, so two contenders can't both win.
 */
export class SessionLock {
  private readonly dir: string;
  private readonly token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  private readonly held = new Set<string>();

  constructor(
    stateDir: string,
    private readonly alive: (pid: number) => boolean = isProcessAlive,
    private readonly startOf: StartOf = processStartTime,
  ) {
    this.dir = join(stateDir, "locks");
  }

  private path(sessionId: string): string {
    const h = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    return join(this.dir, `${h}.lock`);
  }

  holds(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  acquire(sessionId: string): boolean {
    if (this.held.has(sessionId)) return true;
    ensurePrivateDir(this.dir);
    const path = this.path(sessionId);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        const start = myStart(this.startOf);
        const owner: Owner = {
          pid: process.pid,
          hostname: hostname(),
          token: this.token,
          createdAt: Date.now(),
          ...(start !== undefined && { start }),
        };
        writeSync(fd, JSON.stringify(owner));
        closeSync(fd);
        this.held.add(sessionId);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const owner = readOwner(path);
        if (owner && ownerRuns(owner, this.alive, this.startOf)) return false;
        // Empty or half-written: its owner may be between creating and writing it. Only a file
        // that has stayed unreadable for a while counts as stale.
        if (!owner && youngerThan(path, UNREADABLE_GRACE_MS)) return false;
        // Stale: claim by renaming aside; whoever renames first wins, the other retries and loses.
        try {
          renameWithRetry(path, `${path}.stale.${this.token}`);
          rmSync(`${path}.stale.${this.token}`, { force: true });
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  release(sessionId: string): void {
    if (!this.held.delete(sessionId)) return;
    const path = this.path(sessionId);
    if (readOwner(path)?.token === this.token) rmSync(path, { force: true });
  }

  releaseAll(): void {
    for (const s of [...this.held]) this.release(s);
  }
}

/** How long an unreadable lock file is presumed to be mid-write rather than abandoned. */
const UNREADABLE_GRACE_MS = 10_000;

function youngerThan(path: string, ms: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs < ms;
  } catch {
    return false;
  }
}

function readOwner(path: string): Owner | undefined {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as Owner;
    return typeof o.pid === "number" ? o : undefined;
  } catch {
    return undefined;
  }
}
