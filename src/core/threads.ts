import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../util/paths.js";
import { MAX_TEXT_BYTES, writeFileAtomic } from "./store.js";

/**
 * The user's default resume message. Nobody is there to answer when it's sent, so it
 * tells the agent not to ask and how to decide alone. Users can change it per thread.
 */
export const DEFAULT_RESUME_PROMPT =
  "Resume the work from where you were interrupted. Agent Rewake sent this message after a usage limit reset, and nobody is here to answer questions or confirm anything until the work is done, so don't ask and don't wait: make the decisions yourself and keep going. Review the current state (latest git pull) and continue from the last completed step. Fully finish the task, including any remaining implementation, testing, fixes and verification. When something is unclear, re-read the task and the code first; otherwise choose the option that changes the least and can be undone, or skip that one item and carry on with the rest. Never invent facts or results, and don't take irreversible or outward-facing actions (deleting data, force-pushing, spending money, publishing) that weren't already asked for. Don't stop to announce your next step or to offer to continue; keep working until everything is complete and there are no known remaining issues. At the end, list the decisions you made on your own and any open questions.";

/** Per-thread settings, stored as threads/<sha256(sessionId)>.json. */
export interface ThreadSettings {
  schemaVersion: 1;
  sessionId: string;
  cwd: string;
  /** Automatic resume after usage limits, turned on from the Rewake menu. */
  autoResume: boolean;
  /** This thread's resume message; the default is used when absent. */
  resumePrompt?: string;
  /**
   * For agents that don't say when their limit resets: how long to wait
   * before an automatic resume, as chosen in the resume form.
   */
  resumeDelayMs?: number;
  /** The agent's title for the thread, for the schedules page. */
  title?: string;
  /** Zed's id for the agent this thread belongs to (e.g. "claude-acp"), for the schedules page. */
  agentId?: string;
  /** The agent's name as people know it (e.g. "Claude Agent"). */
  agentName?: string;
  /** The short "how Rewake works" note has been shown in this thread. */
  introShown?: boolean;
  updatedAt: number;
}

export class ThreadStore {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "threads");
  }

  private file(sessionId: string): string {
    return `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`;
  }

  get(sessionId: string): ThreadSettings | undefined {
    try {
      const t = JSON.parse(
        readFileSync(join(this.dir, this.file(sessionId)), "utf8"),
      ) as ThreadSettings;
      const valid =
        t.schemaVersion === 1 &&
        t.sessionId === sessionId &&
        typeof t.autoResume === "boolean" &&
        (t.resumePrompt === undefined ||
          (typeof t.resumePrompt === "string" &&
            Buffer.byteLength(t.resumePrompt) <= MAX_TEXT_BYTES));
      return valid ? t : undefined;
    } catch {
      return undefined;
    }
  }

  update(
    sessionId: string,
    cwd: string,
    change: Partial<
      Pick<
        ThreadSettings,
        | "autoResume"
        | "resumePrompt"
        | "resumeDelayMs"
        | "title"
        | "agentId"
        | "agentName"
        | "introShown"
      >
    >,
    now: number,
  ): ThreadSettings {
    const current = this.get(sessionId) ?? {
      schemaVersion: 1 as const,
      sessionId,
      cwd,
      autoResume: false,
      updatedAt: now,
    };
    const next: ThreadSettings = { ...current, ...change, cwd: cwd || current.cwd, updatedAt: now };
    writeFileAtomic(
      ensurePrivateDir(this.dir),
      this.file(sessionId),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return next;
  }

  /** Forget a thread (it was deleted in Zed). */
  remove(sessionId: string): void {
    rmSync(join(this.dir, this.file(sessionId)), { force: true });
  }

  /** Every thread Rewake has seen, most recently updated first. */
  list(): ThreadSettings[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: ThreadSettings[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      try {
        const t = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as ThreadSettings;
        const valid = typeof t.sessionId === "string" ? this.get(t.sessionId) : undefined;
        if (valid) out.push(valid);
      } catch {
        // Unreadable or hand-edited: skipped, never trusted.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  resumePrompt(sessionId: string): string {
    return this.get(sessionId)?.resumePrompt ?? DEFAULT_RESUME_PROMPT;
  }
}
