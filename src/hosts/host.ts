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
  /** Facts at fire time, from the agent's own files or commands. Anything unknown is left out. */
  check(resume: Schedule, now: number): Promise<HostFacts>;
  /** Deliver the message into the same session, once. */
  send(resume: Schedule, idempotencyKey: string): Promise<SendResult>;
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
