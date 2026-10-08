import type { ChildProcess } from "node:child_process";
import type { Schedule } from "../core/store.js";
import { errorLine } from "../util/error-line.js";

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
      /** "failed": the agent's own last error line, cleaned (`errorLine`), for the person. */
      message?: string;
      /** "limited": the next reset the agent's output gave, when it gave one. */
      resetsAt?: number;
    };

/** The agent's last error line as a failed result's `message`, when it said anything. */
export function withMessage(output: string): { message?: string } {
  const message = errorLine(output);
  return message === undefined ? {} : { message };
}

/**
 * The longest a headless resume run may take before Rewake stops it: long enough for a night's
 * work, short enough that a run stuck on something never ends up holding the session for days.
 */
export const RESUME_TIMEOUT_MS = 3 * 60 * 60_000;

let runStarted: ((pid: number) => void) | undefined;

/** `fire`: hear when a host starts its headless run, with the agent's process id. */
export function onResumeRun(listener: ((pid: number) => void) | undefined): void {
  runStarted = listener;
}

/**
 * Stop a resume run that is still going after `ms` (hung). Returns a check, read when the child
 * exits, of whether it was stopped this way. Also reports the run's start (`onResumeRun`).
 */
export function resumeDeadline(child: ChildProcess, ms = RESUME_TIMEOUT_MS): () => boolean {
  if (child.pid !== undefined) runStarted?.(child.pid);
  let stopped = false;
  const timer = setTimeout(() => {
    stopped = true;
    child.kill();
  }, ms);
  child.once("exit", () => clearTimeout(timer));
  child.once("error", () => clearTimeout(timer));
  return () => stopped;
}

/**
 * Hand the scheduled message to a headless run on its stdin, and close it.
 *
 * A command line is readable by every process on the machine (`ps`, `/proc/<pid>/cmdline`, the
 * Windows process list), so a message passed as an argument is public for as long as the agent
 * runs. Rewake's own log holds metadata only (util/log.ts, SECURITY.md) and nothing it schedules
 * is meant to leave the computer: stdin is private to the two processes, so the message goes
 * that way wherever the agent's CLI reads one.
 *
 * A write error is ignored: an agent that exits before reading stdin (signed out, no such
 * session) would otherwise raise EPIPE, and its exit code and output already say what went wrong.
 */
export function sendPromptOnStdin(child: ChildProcess, text: string): void {
  if (!child.stdin) return;
  child.stdin.on("error", () => {
    // The agent exited before reading it; the exit code says why.
  });
  child.stdin.end(text);
}
