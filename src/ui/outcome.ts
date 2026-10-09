import type { Schedule } from "../core/store.js";

/** Why a message wasn't sent, in plain words, by the reason Rewake recorded. */
const WHY: Record<string, string> = {
  typed: "you typed in the session first",
  native: "the agent continued by itself",
  you: "you stopped it",
  "too-late": "it was too late to send",
  late: "the time had passed when Rewake could send it",
  expired: "it was still limited after several tries",
  "far-reset": "the limit resets too far away to wait for",
  reset_far_away: "the limit resets too far away to wait for",
  still_limited: "the agent was still limited",
  open: "the session was open, so Rewake didn't write to it",
  unconfirmed: "Rewake couldn't confirm it arrived",
  interrupted: "it was cut off before it finished",
  "signed-out": "the agent was signed out",
  archived: "the session was archived",
  deleted: "the session was deleted",
  timeout: "the run took too long",
  "missing-key": "the agent's key was missing",
  "window-closed": "its window was closed",
};

/** Reasons that mean the agent was still at its limit. */
const LIMITED = new Set(["expired", "still_limited"]);

const short = (s: string, max = 80) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * What happened to a message and why, as one phrase: "Sent", "Cancelled: you typed in the session
 * first", "Failed: the agent was signed out". Only what Rewake recorded; never the message text.
 */
export function outcomeText(s: Schedule): string {
  const reason = s.failureReason;
  const why = reason ? WHY[reason] : undefined;
  switch (s.status) {
    case "sent":
      return "Sent";
    case "cancelled":
      return "Cancelled";
    case "stopped":
      if (reason === "typed") return `Cancelled: ${WHY.typed}`;
      if (reason === "native") return `Not needed: ${WHY.native}`;
      return reason === "you" ? "Stopped by you" : "Stopped";
    case "missed":
      return `Too late: ${WHY.late}`;
    case "failed":
      if (reason && LIMITED.has(reason)) return `Still limited: ${why}`;
      if (why) return `Failed: ${why}`;
      if (s.failureMessage) return `Failed: ${short(s.failureMessage)}`;
      return reason && reason !== "failed" && reason !== "error"
        ? `Failed: ${short(reason)}`
        : "Failed";
    case "needs_attention":
      if (reason && LIMITED.has(reason)) return `Still limited: ${why}`;
      return why ? `Needs you: ${why}` : "Needs you";
    case "scheduled":
      return (s.rearms ?? 0) > 0 ? "Still limited: Rewake will try again later" : "Planned";
    case "waiting_for_limit":
      return "Waiting for the limit to reset";
    case "sending":
      return "Sending now";
    case "paused":
      return "Paused";
    case "queued":
      return "Queued";
  }
}

/**
 * When it happened: for a message that's settled, when it was last changed; for one still planned,
 * when it's due.
 */
export function eventTime(s: Schedule): number {
  switch (s.status) {
    case "scheduled":
    case "paused":
    case "queued":
    case "waiting_for_limit":
      return s.dueAt;
    default:
      return s.lastRun?.at ?? s.updatedAt;
  }
}
