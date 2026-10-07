import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/store.js";
import { ensurePrivateDir } from "../util/paths.js";

/**
 * What Rewake's hooks remember about an agent's session, one small file per session:
 * `<stateDir>/hosts/<host>/sessions/<sessionId>.json`. Metadata only: never prompt, reply or error
 * text. Used by the hosts whose sessions Rewake resumes after they're closed (Copilot CLI, Grok,
 * Gemini CLI, Antigravity CLI): whether the session is open, when the person last typed, and the
 * last usage limit seen with its reset time.
 */
export interface SessionRecord {
  schemaVersion: 1;
  host: string;
  sessionId: string;
  cwd: string;
  open: boolean;
  /** The agent's program, as found from the session's own PATH (a timer's PATH is minimal). */
  program?: string;
  openedAt?: number;
  closedAt?: number;
  /** When the person last sent a prompt (Rewake's own resume runs aren't counted). */
  lastPromptAt?: number;
  limit?: SessionLimit;
  updatedAt: number;
}

export interface SessionLimit {
  seenAt: number;
  /** "session", "weekly", "model", "other", or "billing". */
  kind: string;
  /** Credits, spending caps: waiting doesn't fix them, so they're never resumed. */
  billing: boolean;
  resetsAt?: number;
}

/** Session ids become file names: only the shapes agents use. */
export const safeSessionId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);

function valid(v: unknown, host: string): v is SessionRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.schemaVersion === 1 &&
    r.host === host &&
    safeSessionId(r.sessionId) &&
    typeof r.cwd === "string" &&
    typeof r.open === "boolean" &&
    typeof r.updatedAt === "number"
  );
}

export class SessionRecords {
  private readonly dir: string;

  constructor(
    stateDir: string,
    private readonly host: string,
  ) {
    this.dir = join(stateDir, "hosts", host, "sessions");
  }

  get(sessionId: string): SessionRecord | undefined {
    if (!safeSessionId(sessionId)) return undefined;
    try {
      const v: unknown = JSON.parse(readFileSync(join(this.dir, `${sessionId}.json`), "utf8"));
      return valid(v, this.host) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  put(record: SessionRecord): void {
    if (!safeSessionId(record.sessionId) || record.host !== this.host) return;
    writeFileAtomic(
      ensurePrivateDir(this.dir),
      `${record.sessionId}.json`,
      `${JSON.stringify(record)}\n`,
    );
  }

  /** Change one session's record (created on first use). */
  update(
    sessionId: string,
    cwd: string,
    now: number,
    change: (r: SessionRecord) => SessionRecord,
  ): SessionRecord | undefined {
    if (!safeSessionId(sessionId)) return undefined;
    const current: SessionRecord = this.get(sessionId) ?? {
      schemaVersion: 1,
      host: this.host,
      sessionId,
      cwd,
      open: false,
      updatedAt: now,
    };
    const next = { ...change({ ...current, cwd: cwd || current.cwd }), updatedAt: now };
    this.put(next);
    return next;
  }

  list(): SessionRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .map((n) => this.get(n.slice(0, -".json".length)))
      .filter((r): r is SessionRecord => r !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** The agent no longer has the session ("Session <id> not found", "unknown session"). */
export const SESSION_GONE = /\bsession\b(?:\s+\S+)?\s+not found|unknown session|no such session/i;
