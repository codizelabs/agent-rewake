import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { renameWithRetry } from "../util/fs.js";
import { ensurePrivateDir } from "../util/paths.js";

/** Who holds a lock. Staleness is decided by the PID only, never by file age. */
interface Owner {
  pid: number;
  hostname: string;
  token: string;
  createdAt: number;
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

/**
 * Per-thread ownership lock: only the process holding a session's lock delivers that session's
 * scheduled messages. An O_EXCL file holds the owner; a lock whose PID is dead
 * is taken over by renaming it aside first, so two contenders can't both win.
 */
export class SessionLock {
  private readonly dir: string;
  private readonly token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  private readonly held = new Set<string>();

  constructor(
    stateDir: string,
    private readonly alive: (pid: number) => boolean = isProcessAlive,
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
        const owner: Owner = {
          pid: process.pid,
          hostname: hostname(),
          token: this.token,
          createdAt: Date.now(),
        };
        writeSync(fd, JSON.stringify(owner));
        closeSync(fd);
        this.held.add(sessionId);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const owner = readOwner(path);
        if (owner && owner.hostname === hostname() && this.alive(owner.pid)) return false;
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
