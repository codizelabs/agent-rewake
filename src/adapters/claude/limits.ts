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
  /out of usage credits|out of extra usage|spend limit|org is out of usage|seat type|allocation has been disabled|usage limit is set to \$0|requires usage credits|monthly|team's shared budget|individual usage limit/i;

/**
 * The plan's own window, appended by Claude Code to a spend, budget or credit message only when the
 * plan limit is used up too: "You've hit your individual spend limit · run /usage-credits … · your
 * session limit resets 7:50pm (Asia/Karachi)". The plan allowance comes back at that time, so
 * waiting does fix it, whatever the message says before.
 */
const PLAN_LIMIT_RESETS = /· your (?:session|weekly|opus|sonnet|fable) limit resets\b/i;

/**
 * Accounts billed by usage: Claude Code never continues these on its own, and the message has no
 * reset ("You've hit your usage limit · contact your admin to increase it").
 */
const USAGE_BASED = /^You've hit your usage limit(?! · resets)/i;

/** Not in the SDK's prefix list, but never fixed by waiting either. */
const OTHER_NOT_FIXED =
  /This service is disabled for your org|Usage credits required for 1M context|out of extra usage|specified (?:workspace )?API usage limits|error_max_budget_usd/i;

const NOT_RECOVERABLE_KINDS = new Set([
  "billing_error",
  "account_on_hold",
  "authentication_failed",
  "oauth_org_not_allowed",
  "invalid_request",
  "model_not_found",
  "max_output_tokens",
  "verification_required",
  "cloud_credential_error",
]);

const SESSION_LOST_KINDS = new Set(["transport_lost", "worker_shutdown"]);

const SESSION_ENDED =
  /The Claude Agent session has ended|The Claude Agent process exited unexpectedly/;

export type LimitType = "session" | "weekly" | "model" | "other";

/** Why waiting won't help: shown to the user only for "billing". */
export type NotRecoverableReason = "billing" | "context" | "auth";

export type Classification =
  | { kind: "usage_limit"; text: string; limitType: LimitType }
  | { kind: "not_recoverable"; text: string; reason?: NotRecoverableReason }
  | { kind: "transient"; text: string }
  | { kind: "session_lost"; text: string }
  | { kind: "other"; text: string };

/**
 * The SDK's `rate_limit_event` info, as claude-agent-acp passes it on (raw SDK message, or
 * `usage_update._meta["_claude/rateLimit"]`).
 */
export interface RateLimitInfo {
  status?: unknown;
  resetsAt?: unknown;
  rateLimitType?: unknown;
  isUsingOverage?: unknown;
  overageInUse?: unknown;
}

/**
 * Claude Code's own test for continuing after a limit: the plan window is rejected, it has a reset
 * time and no overage is being used. It doesn't look at why overage is unavailable, so a spent
 * credit or spend cap doesn't stop it. Returns the reset in ms, or undefined.
 */
export function resumableReset(info: RateLimitInfo | undefined): number | undefined {
  if (info?.status !== "rejected") return undefined;
  if (typeof info.resetsAt !== "number" || !Number.isFinite(info.resetsAt)) return undefined;
  if (info.isUsingOverage === true || info.overageInUse === true) return undefined;
  return info.resetsAt * 1000;
}

/** "five_hour", "seven_day_opus" … as a limit type. */
export function limitTypeOf(rateLimitType: unknown, text = ""): LimitType {
  const t = typeof rateLimitType === "string" ? rateLimitType : "";
  if (/opus|sonnet|fable/i.test(t)) return "model";
  if (/seven_day|weekly/i.test(t)) return "weekly";
  if (/five_hour|session/i.test(t)) return "session";
  return /session limit|5-hour|five.hour/i.test(text)
    ? "session"
    : /weekly/i.test(text)
      ? "weekly"
      : /opus|sonnet|fable|haiku/i.test(text)
        ? "model"
        : "other";
}

/**
 * Classify a failed `session/prompt` from claude-agent-acp: `-32603` with `data.errorKind` and the
 * limit text as the message. Only the error itself is trusted, never Claude's prose, which can
 * contain the same words. `rateLimit` is the latest `rate_limit_event` of this turn, if any.
 */
export function classifyPromptError(
  error: NonNullable<JsonRpcMessage["error"]>,
  rateLimit?: RateLimitInfo,
): Classification {
  const data = (error.data ?? {}) as { errorKind?: unknown; details?: unknown };
  const raw = error.message.replace(/^Internal error:\s*/, "").trim();
  // Clients with typed session failures get no text in `message`; Zed shows `details` instead.
  const text = (raw === "Internal error" && typeof data.details === "string" ? data.details : raw)
    .slice(0, 16_000)
    .replace(/[\u2018\u2019]/g, "'");
  const errorKind = typeof data.errorKind === "string" ? data.errorKind : undefined;

  if (
    data.details === "Session not found" ||
    (errorKind && SESSION_LOST_KINDS.has(errorKind)) ||
    SESSION_ENDED.test(text)
  ) {
    return { kind: "session_lost", text };
  }
  if (errorKind && NOT_RECOVERABLE_KINDS.has(errorKind))
    return {
      kind: "not_recoverable",
      text,
      ...(errorKind === "billing_error" && { reason: "billing" as const }),
      ...(errorKind === "invalid_request" &&
        /prompt is too long|request too large/i.test(text) && { reason: "context" as const }),
      ...(/authentication|oauth|credential|verification/.test(errorKind) && {
        reason: "auth" as const,
      }),
    };
  // Whatever the error kind says (often "unknown" for these), waiting never fixes them.
  if (OTHER_NOT_FIXED.test(text)) return { kind: "not_recoverable", text, reason: "billing" };
  if (errorKind !== "rate_limit" && errorKind !== undefined) {
    return errorKind === "overloaded" || errorKind === "server_error"
      ? { kind: "transient", text }
      : { kind: "other", text };
  }

  const isLimitText = USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.startsWith(p));
  // The plan's reset suffix wins over whatever comes before it.
  const planResets = PLAN_LIMIT_RESETS.test(text);
  if (
    isLimitText &&
    !planResets &&
    (USAGE_BASED.test(text) || /team's shared budget|individual usage limit/i.test(text))
  )
    return { kind: "not_recoverable", text, reason: "billing" };

  // The structured event decides first, as it does for Claude Code.
  if (errorKind === "rate_limit" && resumableReset(rateLimit) !== undefined)
    return {
      kind: "usage_limit",
      text,
      limitType: limitTypeOf(rateLimit?.rateLimitType, text),
    };

  if (errorKind === "rate_limit" && isLimitText) {
    if (NOT_FIXED_BY_WAITING.test(text) && !planResets)
      return { kind: "not_recoverable", text, reason: "billing" };
    return { kind: "usage_limit", text, limitType: limitTypeOf(undefined, text) };
  }
  if (errorKind === "rate_limit") return { kind: "transient", text };
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
    /resets\s+(?:on\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?!\d)(?!\s*(?:hrs?|hours?|h|mins?|minutes?|m|days?|d)\b)(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\)|\b(UTC|GMT)\b)?/i.exec(
      text,
    );
  if (!m) return undefined;
  let hour = Number(m[5]);
  const minute = m[6] ? Number(m[6]) : 0;
  const ampm = m[7]?.toLowerCase();
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const named = m[8] ?? m[9];
  const zone = named && isValidZone(named) ? named : undefined;
  const tz = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekday = m[1] ? WEEKDAYS.indexOf(m[1].toLowerCase()) : -1;
  const month = m[2] ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  const day = m[3] ? Number(m[3]) : undefined;
  const year = m[4] ? Number(m[4]) : undefined;
  // A day the month never has ("Feb 30") would otherwise be looked for all year.
  if (month >= 0 && day !== undefined && (day < 1 || day > (DAYS_IN_MONTH[month] ?? 31)))
    return undefined;

  // Walk forward day by day (at most ~a year) in the zone until the wall time is after `after`.
  for (let i = 0; i <= 370; i++) {
    const p = zonedParts(after + i * 86_400_000, tz);
    if (weekday >= 0 && p.weekday !== weekday) continue;
    if (month >= 0 && (p.month !== month || p.day !== day)) continue;
    if (year !== undefined && p.year !== year) continue;
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

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** One formatter per zone: building one costs far more than using it. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zonedParts(t: number, timeZone: string) {
  let format = FORMATTERS.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    if (FORMATTERS.size < 50) FORMATTERS.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(t).map((x) => [x.type, x.value]));
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
