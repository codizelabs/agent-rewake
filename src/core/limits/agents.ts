import { classifyLimit, classifyText, classifyTurnEnd, grokText } from "../../adapters/profiles.js";
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
 * A usage limit from the error code Copilot's service sends (`user_weekly_rate_limited`,
 * `user_session_rate_limited`, `session_quota_exceeded`; research impl-claude-copilot B.3.2,
 * testing-harness §2.4). The hook's message is that error as JSON. Undefined: no code it knows.
 */
export function copilotCode(text: string): SessionLimit | undefined {
  let e: { code?: unknown; type?: unknown };
  try {
    e = JSON.parse(text) as { code?: unknown; type?: unknown };
  } catch {
    return undefined;
  }
  const code = typeof e?.code === "string" ? e.code : typeof e?.type === "string" ? e.type : "";
  if (code === "user_weekly_rate_limited") return { kind: "weekly", billing: false };
  if (code === "user_session_rate_limited" || code === "session_quota_exceeded")
    return { kind: "session", billing: false };
  return undefined;
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

export const ANTIGRAVITY_QUOTA = /Individual quota reached|RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/;

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
  const d = /Resets in ((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/.exec(error)?.[1];
  const ms = d ? durationMs(d) : undefined;
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
  if (error !== "invalid_request" || !/\b402\b|weekly limit|credit|spending cap/i.test(text))
    return undefined;
  // A 402: the weekly pool (wait for the reset) or a spending cap or credit limit (billing).
  const cap = /spending (?:cap|limit)|credit limit|out of credits/i.test(text);
  if (!cap && billing.full && (/weekly limit/i.test(text) || /\b402\b/.test(text)))
    return { kind: "weekly", billing: false, ...weekly };
  // Grok says "weekly limit" and its log has no recent billing line to say otherwise: still a
  // limit that resets, so the person is asked for a time rather than told nothing. (A recent line
  // whose pool isn't used up means the 402 was about money.)
  if (!cap && !billing.seen && /weekly limit/i.test(text))
    return { kind: "weekly", billing: false };
  return { kind: "billing", billing: true };
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
