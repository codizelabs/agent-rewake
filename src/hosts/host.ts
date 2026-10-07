import type { ChildProcess } from "node:child_process";
import type { Schedule } from "../core/store.js";

/**
 * What an integration outside Zed (Codex, Copilot CLI, Grok, Gemini CLI, Antigravity) provides so
 * `fire` can resume one of its sessions. `fire` makes every decision (src/core/resume.ts); a host
 * only reports facts and delivers.
 */
export interface HostAdapter {
  /** The `host` value its records carry, e.g. "codex". */
  id: string;
  /** As people know it, for notifications: "Codex". */
  name: string;
  /** What the agent calls a conversation: "thread" (Codex) or "session" (Copilot, Grok). */
  noun: string;
  /** How the person gets back to it, when "open the <noun>" isn't enough. */
  reopen?: string;
  /**
   * How the person asks Rewake again: for `at` ("at 3:00 PM today") when the agent reported its
   * next reset, otherwise with a time of their own.
   */
  again?: (at: string | undefined) => string;
  /** Facts at fire time, from the agent's own files or commands. Anything unknown is left out. */
  check(resume: Schedule, now: number): Promise<HostFacts>;
  /**
   * Deliver the message into the same session, once. On failure, `detail` may name a cause the
   * person can fix: "signed-out", "archived" or "deleted".
   */
  send(resume: Schedule, idempotencyKey: string): Promise<SendResult>;
  /**
   * After a send was cut off (a crash, a restart): whether the agent's own files show the message
   * arrived. True only when they do; undefined when they can't say.
   */
  delivered?(resume: Schedule): boolean | undefined;
}

export interface HostFacts {
  /** From the agent's usage check, when it has one: false = still limited. */
  usageAllowed?: boolean;
  /** A later reset the usage check reported. */
  newResetsAt?: number;
  /** The person typed in the session after the limit. */
  userTypedSince?: boolean;
  /** The agent's own auto-continue already continued. */
  nativeContinued?: boolean;
  /** The session is open in a UI, so Rewake mustn't write to it (one writer). */
  sessionOpen?: boolean;
}

export type SendResult =
  | { ok: true }
  | {
      ok: false;
      reason: "busy" | "closed" | "limited" | "unsupported" | "failed";
      detail?: string;
    };

/** The longest a headless resume run may take before Rewake stops it. */
export const RESUME_TIMEOUT_MS = 30 * 60_000;

/**
 * Stop a resume run that is still going after `ms` (waiting on an approval, hung). Returns a check,
 * read when the child exits, of whether it was stopped this way.
 */
export function resumeDeadline(child: ChildProcess, ms = RESUME_TIMEOUT_MS): () => boolean {
  let stopped = false;
  const timer = setTimeout(() => {
    stopped = true;
    child.kill();
  }, ms);
  child.once("exit", () => clearTimeout(timer));
  child.once("error", () => clearTimeout(timer));
  return () => stopped;
}
