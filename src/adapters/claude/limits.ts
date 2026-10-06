import type { JsonRpcMessage } from "../../acp/ndjson.js";

/**
 * The Claude Agent SDK's own list of usage-limit message prefixes (`USAGE_LIMIT_ERROR_PREFIXES`
 * in @anthropic-ai/claude-agent-sdk, marked @alpha). Vendored rather than imported so the bundle
 * never contains SDK code; test/limits.test.ts fails if the installed SDK's list changes.
 */
export const USAGE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage · add funds to continue",
  "Your org is out of usage · contact your admin",
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
] as const;

/** Limits that waiting won't fix: credits, spend caps, seats, admin settings. */
const NOT_FIXED_BY_WAITING =
  /out of usage credits|out of extra usage|spend limit|org is out of usage|seat type|allocation has been disabled|usage limit is set to \$0|requires usage credits|monthly/i;

const NOT_RECOVERABLE_KINDS = new Set([
  "billing_error",
  "account_on_hold",
  "authentication_failed",
  "oauth_org_not_allowed",
  "invalid_request",
  "model_not_found",
  "max_output_tokens",
]);

export type Classification =
  | { kind: "usage_limit"; text: string; limitType: "session" | "weekly" | "model" | "other" }
  | { kind: "not_recoverable"; text: string }
  | { kind: "transient"; text: string }
  | { kind: "session_lost"; text: string }
  | { kind: "other"; text: string };

/**
 * Classify a failed `session/prompt` from claude-agent-acp: `-32603` with `data.errorKind` and the
 * limit text as the message. Only the error itself is trusted, never Claude's
 * prose, which can contain the same words.
 */
export function classifyPromptError(error: NonNullable<JsonRpcMessage["error"]>): Classification {
  const text = error.message.replace(/^Internal error:\s*/, "").trim();
  const data = (error.data ?? {}) as { errorKind?: unknown; details?: unknown };
  const errorKind = typeof data.errorKind === "string" ? data.errorKind : undefined;

  if (data.details === "Session not found" || errorKind === "transport_lost") {
    return { kind: "session_lost", text };
  }
  if (errorKind && NOT_RECOVERABLE_KINDS.has(errorKind)) return { kind: "not_recoverable", text };

  const isLimitText = USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.startsWith(p));
  if (errorKind === "rate_limit" && isLimitText) {
    if (NOT_FIXED_BY_WAITING.test(text)) return { kind: "not_recoverable", text };
    const limitType = /session limit|5-hour|five.hour/i.test(text)
      ? "session"
      : /weekly/i.test(text)
        ? "weekly"
        : /opus|sonnet|fable|haiku/i.test(text)
          ? "model"
          : "other";
    return { kind: "usage_limit", text, limitType };
  }
  if (errorKind === "rate_limit" || errorKind === "overloaded" || errorKind === "server_error") {
    return { kind: "transient", text };
  }
  return { kind: "other", text };
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Parse "resets 4:50pm (Europe/Samara)", "resets Mon 12:00am", "resets Aug 21 at 3pm" into the next
 * matching instant after `after`, in the named IANA zone (or the local zone). Last-resort source:
 * the text has no date and no year.
 */
export function parseResetText(
  text: string,
  after: number,
): { resetAt: number; confidence: "medium" | "low" } | undefined {
  const m =
    /resets\s+(?:on\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(
      text,
    );
  if (!m) return undefined;
  let hour = Number(m[4]);
  const minute = m[5] ? Number(m[5]) : 0;
  const ampm = m[6]?.toLowerCase();
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const zone = m[7] && isValidZone(m[7]) ? m[7] : undefined;
  const tz = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekday = m[1] ? WEEKDAYS.indexOf(m[1].toLowerCase()) : -1;
  const month = m[2] ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  const day = m[3] ? Number(m[3]) : undefined;

  // Walk forward day by day (at most ~a year) in the zone until the wall time is after `after`.
  for (let i = 0; i <= 370; i++) {
    const p = zonedParts(after + i * 86_400_000, tz);
    if (weekday >= 0 && p.weekday !== weekday) continue;
    if (month >= 0 && (p.month !== month || p.day !== day)) continue;
    const at = zonedToEpoch(p.year, p.month, p.day, hour, minute, tz);
    if (at > after) return { resetAt: at, confidence: zone ? "medium" : "low" };
  }
  return undefined;
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function zonedParts(t: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    weekday: WEEKDAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Epoch ms for a wall-clock time in a zone. In a DST gap the later instant wins. */
export function zonedToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  let guess = Date.UTC(year, month, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute);
    const wanted = Date.UTC(year, month, day, hour, minute);
    guess += wanted - asUtc;
  }
  return guess;
}
