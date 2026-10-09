import { classifyLimit, classifyText, classifyTurnEnd, grokText } from "../../adapters/profiles.js";
import { parseResetHint } from "../../adapters/reset.js";
import { normalize } from "../../adapters/text.js";
import type { HostLimit } from "./types.js";

/**
 * Each agent's usage-limit rules for the signals its hooks and files give outside Zed (plan §3.4).
 * They sit on the same per-agent rules Zed's add-on uses (src/adapters/profiles.ts), so an agent's
 * limit reads the same in Zed and in its own terminal. `recognise()` (./recognise.ts) is the one way
 * in; these stay exported for their tests.
 */

type SessionLimit = HostLimit;

const str = (v: unknown) => (typeof v === "string" ? v : "");

// ---- GitHub Copilot CLI -------------------------------------------------------------------------
/**
 * GitHub Copilot CLI's usage limits, from the error text its `errorOccurred` hook receives. The
 * hook carries no reset field, so the reset comes from the text.
 *
 * Texts seen (Copilot CLI 1.0.92 strings; github/copilot-cli issues #2828, #2696, #2385):
 *   "You've reached your weekly rate limit. Please wait for your limit to reset on April 20, 2026
 *    at 2:00 AM or switch to auto model to continue."
 *   "… Please try again in 58 hours."
 *   "You've hit your session rate limit." / "You've hit the rate limit for this model."
 * Billing (never resumed): "You've run out of your AI credits", "included AI credits for the
 * month", "spending limit for this session", "additional usage limit".
 * Whether `errorOccurred` carries exactly these texts is experiment E-C1.
 */

/**
 * A usage limit in Copilot CLI's error text, or undefined for any other error, a short-term rate
 * limit Copilot rides out itself, or an error it recovered from. The hook's text is what the ACP
 * client gets after "Error: ", so the rules are the shared ones (`classifyTurnEnd("copilot", …)`):
 * Copilot's own sentences, "reset in 2 hours", and reset dates printed in UTC.
 */
/**
 * A usage limit from the error code Copilot's service sends. The hook's message is that error as
 * JSON, with the code at the top (`{"code": …}`) or inside an `error` object
 * (`{"error": {"code": …}}`; VS Code's Copilot Chat reads `error.code`, per the community-autoresume
 * research note C1, not read directly here).
 *
 * The rate-limit codes are `user_weekly_rate_limited`, `user_global_rate_limited` (which Copilot
 * shows as the session limit), `user_model_rate_limited`, `integration_rate_limited` and
 * `rate_limited`; `session_quota_exceeded` is a quota code (github/copilot-sdk @503bc70,
 * `nodejs/src/generated/session-events.ts:2014`; the "session limit" wording and the `:pro`-style
 * suffix are from the research note, citing VS Code's `commonTypes.ts`). A code may carry a suffix
 * after a colon, so only the part before it counts. A bare `rate_limited` names no window and
 * Copilot rides it out itself: it is no limit here. Undefined: no code it knows.
 */
export function copilotCode(text: string): SessionLimit | undefined {
  let e: { code?: unknown; type?: unknown; error?: { code?: unknown; type?: unknown } | null };
  try {
    e = JSON.parse(text) as typeof e;
  } catch {
    return undefined;
  }
  const first = [e?.code, e?.type, e?.error?.code, e?.error?.type].find(
    (v): v is string => typeof v === "string" && v !== "",
  );
  switch (first?.split(":")[0]) {
    case "user_weekly_rate_limited":
      return { kind: "weekly", billing: false };
    case "user_session_rate_limited":
    case "user_global_rate_limited":
    case "session_quota_exceeded":
      return { kind: "session", billing: false };
    case "user_model_rate_limited":
      return { kind: "model", billing: false };
    case "integration_rate_limited":
      return { kind: "other", billing: false };
    default:
      return undefined;
  }
}

/** `{"message": "…"}` (or `{"error": {"message": "…"}}`) as its message; anything else as is. */
function innerMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: { message?: unknown } };
    const m = j?.message ?? j?.error?.message;
    return typeof m === "string" ? m : text;
  } catch {
    return text;
  }
}

export function classifyCopilotError(
  text: unknown,
  now: number,
  recoverable = false,
): SessionLimit | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  // Copilot's hook carries the provider's error as a JSON string: its code says which limit.
  const coded = copilotCode(text);
  if (coded) return coded;
  // Copilot marks every retry "recoverable", a weekly limit too (1.0.92, tested offline): the flag
  // only excuses what the text calls short-term.
  if (recoverable) return undefined;
  // The text inside the provider's JSON body, when the hook carries one.
  const t = innerMessage(text).slice(0, 4096);
  const c = classifyTurnEnd("copilot", `Error: ${t}`, "end_turn", now);
  if (c?.kind === "not_recoverable") return { kind: "billing", billing: true };
  if (c?.kind === "usage_limit")
    return {
      kind: c.limitType,
      billing: false,
      ...(c.resetAt !== undefined && { resetsAt: c.resetAt }),
    };
  // Wordings the shared rules don't name, kept as billing: waiting doesn't bring them back.
  if (/run out of your AI credits|additional usage limit/i.test(t))
    return { kind: "billing", billing: true };
  return undefined;
}

// ---- Gemini CLI ---------------------------------------------------------------------------------

// Gemini CLI writes `[API Error: <message>]` without the status name, so a 429 often carries only
// the server's words ("You exceeded your current quota…", "Resource has been exhausted…") or the
// suffix it adds for API-key sign-ins (googleQuotaErrors.ts, errorParsing.ts).
export const GEMINI_LIMIT =
  /RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|Usage limit reached|exhausted your (daily quota|capacity)|Individual quota reached|quota will reset|You exceeded your current quota|Resource has been exhausted|request a quota increase through AI Studio/i;

/** "1h2m3s", "16h39m20s", "0s" → milliseconds. */
export function durationMs(d: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(d);
  if (!m || !d) return undefined;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** A usage limit in Gemini's error text, with its reset when the text says. */
export function classifyGeminiError(text: string, now: number): SessionLimit | undefined {
  if (!GEMINI_LIMIT.test(text)) return undefined;
  // Gemini CLI's own rules (shared with Zed): no quota on this tier, no capacity, a short retry.
  const g = classifyLimit("gemini", { code: 429, message: text }, now);
  if (g.kind === "transient") return undefined;
  if (g.kind === "not_recoverable") return { kind: "billing", billing: true };
  // Money, unless a reset time is given. Gemini words every quota error with "please check your
  // plan and billing details", so that sentence says nothing about money.
  const money = classifyText(
    text.replace(
      /(?:You exceeded your current quota,?\s*)?please check your plan and billing details\.?/i,
      "",
    ),
    now,
  );
  if (money.kind === "not_recoverable" && money.reason === "billing")
    return { kind: "billing", billing: true };
  const after = /(?:reset after|resets in)\s+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i.exec(text);
  const ms = after?.[1] ? durationMs(after[1]) : undefined;
  let resetsAt = ms !== undefined ? now + ms : undefined;
  // "Suggested retry after 3600s." / "Please retry in 1234.5s.": the shared rules read these.
  if (resetsAt === undefined && g.kind === "usage_limit") resetsAt = g.resetAt;
  if (resetsAt === undefined) {
    const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/.exec(
      text,
    );
    const t = iso ? Date.parse(iso[0]) : Number.NaN;
    if (Number.isFinite(t) && t > now) resetsAt = t;
  }
  return {
    kind: /daily/i.test(text) ? "daily" : "other",
    billing: false,
    ...(resetsAt && { resetsAt }),
  };
}

// ---- Antigravity CLI ----------------------------------------------------------------------------

/**
 * "Individual quota reached" and the gRPC codes are the CLI's own (research impl-google L3).
 * "Model quota limit exceeded" is the IDE's and app's wording, from a Google forum post
 * (discuss.ai.google.dev, 2026-01-24) and a community tool (saaranshM/unsnooze), not from Google's
 * documentation: the CLI may not print it.
 */
export const ANTIGRAVITY_QUOTA =
  /Individual quota reached|Model quota limit exceeded|RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/;

const DAY_MS = 24 * 3_600_000;

/**
 * The wait in "Resets in 16h39m20s" or "Refreshes in 2h30m" (a Go-style duration), or in
 * "Refreshes in 6 days and 18 hours" (the app's wording, same community sources as above).
 * Undefined when the text names no wait.
 */
export function antigravityWaitMs(text: string): number | undefined {
  const compact = /(?:Resets|Refreshes) in ((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)(?!\w)/i.exec(
    text,
  )?.[1];
  const ms = compact ? durationMs(compact) : undefined;
  if (ms !== undefined) return ms;
  const w =
    /(?:Resets|Refreshes) in (?:(\d+) days?)?(?:,? ?(?:and )?(\d+) hours?)?(?:,? ?(?:and )?(\d+) minutes?)?/i.exec(
      text,
    );
  if (!w || (!w[1] && !w[2] && !w[3])) return undefined;
  return Number(w[1] ?? 0) * DAY_MS + Number(w[2] ?? 0) * 3_600_000 + Number(w[3] ?? 0) * 60_000;
}

export function classifyAntigravityStop(
  input: Record<string, unknown>,
  now: number,
): SessionLimit | undefined {
  const error = typeof input.error === "string" ? input.error : "";
  if (input.terminationReason !== "error" || !ANTIGRAVITY_QUOTA.test(error)) return undefined;
  // Shared rules: a reset time wins over money words ("… enable overages. Resets in 16h39m20s"),
  // a reset only seconds away is a wait Antigravity rides out itself.
  const c = classifyText(error, now);
  if (c.kind === "transient") return undefined;
  if (c.kind === "not_recoverable" && c.reason === "billing")
    return { kind: "billing", billing: true };
  const ms = antigravityWaitMs(error);
  const resetsAt =
    c.kind === "usage_limit" && c.resetAt !== undefined
      ? c.resetAt
      : ms !== undefined
        ? now + ms
        : undefined;
  return { kind: "other", billing: false, ...(resetsAt !== undefined && { resetsAt }) };
}

// ---- Grok Build ---------------------------------------------------------------------------------

/** A usage limit in a Grok `StopFailure`, or undefined for any other failure. */
export function classifyGrokFailure(
  input: Record<string, unknown>,
  billing: { resetsAt?: number; full: boolean; seen?: boolean },
): SessionLimit | undefined {
  const error = str(input.error);
  const text = normalize(
    `${str(input.errorDetails ?? input.error_details)} ${str(input.lastAssistantMessage ?? input.last_assistant_message)}`,
  );
  // The weekly period's end is the reset only when the weekly pool is what ran out.
  const weekly =
    billing.full && billing.resetsAt !== undefined ? { resetsAt: billing.resetsAt } : {};
  if (error === "rate_limit") {
    // Grok's own sentences: team or plan rate limits and overloads are short-term, the free
    // usage limit isn't (shared rules, src/adapters/profiles.ts).
    const c = grokText(text.trim());
    if (c?.kind === "transient") return undefined;
    if (c?.kind === "not_recoverable") return { kind: "billing", billing: true };
    if (c?.kind === "usage_limit") return { kind: "other", billing: false, ...weekly };
    return billing.full ? { kind: "weekly", billing: false, ...weekly } : undefined;
  }
  if (
    error !== "invalid_request" ||
    !/\b402\b|weekly limit|credit|spending cap|usage balance exhausted/i.test(text)
  )
    return undefined;
  // A 402: the weekly pool (wait for the reset) or a spending cap or credit limit (billing).
  const cap = /spending (?:cap|limit)|credit limit|out of credits/i.test(text);
  if (!cap && billing.full && (/weekly limit/i.test(text) || /\b402\b/.test(text)))
    return { kind: "weekly", billing: false, ...weekly };
  // "Grok Build usage balance exhausted" is Grok's own wording for the usage pool running out, a
  // 402 its screen heads "You hit your weekly limit." under unified credits (xai-org/grok-build
  // @2bdd1d6: xai-grok-pager/src/app/dispatch/tests/billing.rs:569 for the text,
  // dispatch/billing.rs:106 for the heading). The log line that says the pool is full may be
  // missing or older than 30 minutes after a long turn, so the text alone is enough; the reset
  // is then unknown and the person picks a time.
  if (!cap && /usage balance exhausted/i.test(text))
    return { kind: "weekly", billing: false, ...weekly };
  // Grok says "weekly limit" and its log has no recent billing line to say otherwise: still a
  // limit that resets, so the person is asked for a time rather than told nothing. (A recent line
  // whose pool isn't used up means the 402 was about money.)
  if (!cap && !billing.seen && /weekly limit/i.test(text))
    return { kind: "weekly", billing: false };
  return { kind: "billing", billing: true };
}

// ---- Qwen Code ----------------------------------------------------------------------------------

/**
 * A usage limit in a Qwen Code `StopFailure` (hooks.md at QwenLM/qwen-code 6788c03): `error` is
 * `rate_limit` for an HTTP 429, and `error_details` is the error's message. A plan quota that ran
 * out reads, from the OpenAI SDK, "429 Your token-plan 1-week quota has been exhausted. The quota
 * will reset at 07-27 09:25:00 UTC." (packages/core/src/utils/quotaErrorDetection.ts:161-165); Qwen
 * itself recognises it (isQuotaExhaustedError, 168-178) by "quota", "exhausted" or "exceeded", and "will reset" or "reset at", and
 * puts "Quota exhausted: " before the message it shows. The text carries no year: the reset is the
 * next such time. One within the last RESET_GRACE_MS counts as now; an impossible date (29 February
 * in a year without one) is unknown, never rolled into March. Any other 429 is a short throttle Qwen retries itself.
 * `billing_error` (HTTP 402 or 403, or "billing" or "quota" with another status) is money: never resumed.
 */
export function classifyQwenFailure(
  input: { error?: unknown; errorDetails?: unknown },
  now: number,
): SessionLimit | undefined {
  if (input.error === "billing_error") return { kind: "billing", billing: true };
  if (input.error !== "rate_limit") return undefined;
  const text = normalize(str(input.errorDetails)).slice(0, 4096);
  const spent = /\bquota\b/i.test(text) && /\b(?:exhausted|exceeded)\b/i.test(text);
  if (!spent || !(/will reset|reset at/i.test(text) || /^Quota exhausted: /m.test(text)))
    return undefined;
  const at = qwenReset(text, now);
  return {
    kind: /\b1-week\b|weekly/i.test(text) ? "weekly" : "other",
    billing: false,
    ...(at !== undefined && { resetsAt: at }),
  };
}

/** A reset this far in the past is the one just now passed, not next year's. */
const RESET_GRACE_MS = 10 * 60_000;

/** "reset at MM-DD HH:MM:SS UTC" as the next such time; unknown if the date doesn't exist. */
function qwenReset(text: string, now: number): number | undefined {
  const m = /reset at (\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC/i.exec(text);
  if (!m) return parseResetHint(text, now);
  const [mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number];
  const year = new Date(now).getUTCFullYear();
  for (const y of [year, year + 1]) {
    const at = Date.UTC(y, mo - 1, d, h, mi, s);
    const t = new Date(at);
    if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) continue;
    if (at >= now - RESET_GRACE_MS) return Math.max(at, now);
  }
  return undefined;
}

// ---- Cursor's own agent (its hooks and transcript) -------------------------------------------

/**
 * Cursor's own agent: the error its transcript records when a turn ends at a limit (the `stop`
 * hook gives no text; Cursor 3.23 writes `{"type":"turn_ended","status":"error","error":…}`).
 * Seen on a Free plan: "You've hit your usage limit Get Cursor Pro…". It never says when the
 * limit resets, so the person picks a time. That one, payment and spend messages are billing:
 * waiting hours won't lift them.
 */
/**
 * Cursor messages that waiting hours won't lift: payment, a spend limit, a free plan's allowance
 * ("… Get Cursor Pro for more Agent usage …"), and a plan's monthly allowance ("Switch to Auto for
 * more usage or set a Spend Limit", "Your usage limits will reset when your monthly cycle ends on
 * <date>": real texts from Cursor 3.x, as captured in unsnooze's tests, 2026-10-08).
 */
export const CURSOR_WAITING_WONT_HELP =
  /add a payment method|spend(ing)? limit|out of credits|on-demand usage|get cursor pro|switch to auto|monthly cycle/i;

export function classifyCursorError(text: unknown): SessionLimit | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  const t = text.slice(0, 4096);
  if (CURSOR_WAITING_WONT_HELP.test(t)) return { kind: "billing", billing: true };
  if (/hit your (usage|rate) limit|usage limit|rate limit|upgrade your plan to continue/i.test(t))
    return { kind: "other", billing: false };
  return undefined;
}
