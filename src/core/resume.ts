/**
 * The host-neutral decisions behind every resume, whichever agent or integration delivers it: whether
 * to arm a resume when a usage limit is seen, and what to do when its time comes. Pure: no I/O and no
 * Node APIs, so plugins that run inside other tools can share it.
 *
 * Rules (product rules in the plan, §2):
 *  - Billing and credit limits are never resumed: only limits a wait fixes.
 *  - A reset more than a day away is always asked about, even when the person chose "always".
 *  - A resume more than 30 minutes past its time is never sent on its own: the person is told.
 *  - A session that is open in a UI is never written to by a second process: the person is told.
 *  - One send per resume; nothing is sent if the person typed after the limit, or if the agent's own
 *    auto-continue already continued.
 */

/** How long after its time a resume may still be sent without asking. */
export const LATE_MS = 30 * 60_000;
/** Resets further away than this are asked about, even with "always". */
export const FAR_RESET_MS = 24 * 3_600_000;
/** Added after a reset before sending, so the agent's own clock has rolled over. */
export const RESET_MARGIN_MS = 60_000;
/** Re-arms after finding the agent still limited, before giving up and telling the person. */
export const MAX_REARMS = 4;
/** Waits when still limited and no new reset time is known: 2, 5, 10, then 20 minutes. */
const BACKOFF_MS = [2, 5, 10, 20].map((m) => m * 60_000);

export function backoffMs(rearms: number): number {
  const i = Math.max(0, Math.min(BACKOFF_MS.length - 1, Math.floor(rearms)));
  return BACKOFF_MS[i] as number;
}

/** What the person chose for resuming after a limit. */
export type AutoResume = "ask" | "always" | "never";

export interface ArmContext {
  now: number;
  /** When the limit resets, if the agent said. */
  resetsAt?: number;
  /** A credit, spend or billing limit: waiting doesn't fix it. */
  isBilling: boolean;
  auto: AutoResume;
}

export type ArmDecision =
  | { action: "arm"; fireAt: number }
  | { action: "offer"; why: "ask" | "far-reset" | "no-reset-time" }
  | { action: "none"; why: "billing" | "never" | "passed" };

/** Decide what to do when a usage limit is seen. */
export function decideArm(c: ArmContext): ArmDecision {
  if (c.isBilling) return { action: "none", why: "billing" };
  if (c.auto === "never") return { action: "none", why: "never" };
  if (c.resetsAt === undefined) return { action: "offer", why: "no-reset-time" };
  if (c.resetsAt + RESET_MARGIN_MS <= c.now) return { action: "none", why: "passed" };
  if (c.resetsAt - c.now > FAR_RESET_MS) return { action: "offer", why: "far-reset" };
  if (c.auto === "ask") return { action: "offer", why: "ask" };
  return { action: "arm", fireAt: c.resetsAt + RESET_MARGIN_MS };
}

/** The parts of a stored resume that the decision needs. */
export interface ResumeState {
  /** When it was due to be sent. */
  dueAt: number;
  status: string;
  /** Times re-armed after finding the agent still limited (missing = 0). */
  rearms?: number;
}

export interface FireContext {
  resume: ResumeState;
  now: number;
  /** From the host's usage check, when it has one: false = still limited. */
  usageAllowed?: boolean;
  /** A later reset the usage check reported (for example a weekly window). */
  newResetsAt?: number;
  /** The person typed in the session after the limit. */
  userTypedSince?: boolean;
  /** The agent's own auto-continue already continued. */
  nativeContinued?: boolean;
  /** Headless hosts: the session is open in a UI, so no second writer. */
  sessionOpen?: boolean;
  /** This resume's idempotency key was already sent. */
  alreadySent: boolean;
}

export type FireDecision =
  | { action: "send" }
  | { action: "wait"; until: number; why: "still-limited" }
  | { action: "notify"; why: "late" | "open" | "far-reset" }
  | { action: "skip"; why: "typed" | "native" | "sent" | "cancelled" | "expired" };

/** Decide what to do when a resume's time comes. */
export function decideFire(c: FireContext): FireDecision {
  const r = c.resume;
  const rearms = r.rearms ?? 0;
  if (c.alreadySent) return { action: "skip", why: "sent" };
  if (r.status === "cancelled") return { action: "skip", why: "cancelled" };
  if (c.nativeContinued) return { action: "skip", why: "native" };
  if (c.userTypedSince) return { action: "skip", why: "typed" };
  if (c.sessionOpen) return { action: "notify", why: "open" };
  if (c.now - r.dueAt > LATE_MS) return { action: "notify", why: "late" };
  if (c.usageAllowed === false) {
    if (rearms >= MAX_REARMS) return { action: "skip", why: "expired" };
    if (c.newResetsAt !== undefined && c.newResetsAt > c.now) {
      if (c.newResetsAt - c.now > FAR_RESET_MS) return { action: "notify", why: "far-reset" };
      return { action: "wait", until: c.newResetsAt + RESET_MARGIN_MS, why: "still-limited" };
    }
    return { action: "wait", until: c.now + backoffMs(rearms), why: "still-limited" };
  }
  return { action: "send" };
}
