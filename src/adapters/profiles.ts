import type { JsonRpcMessage } from "../acp/ndjson.js";
import {
  type Classification,
  classifyPromptError,
  type LimitType,
  type RateLimitInfo,
  resumableReset,
} from "./claude/limits.js";
import { parseDuration, parseResetHint } from "./reset.js";
import { errorText, httpStatus, normalize, withoutUrls } from "./text.js";

export { parseResetHint } from "./reset.js";

type RpcError = NonNullable<JsonRpcMessage["error"]>;

/**
 * What differs between agents when a usage limit hits. ACP has no standard error for a usage limit,
 * a rate limit or spent credits, so each agent reports them its own way: a JSON-RPC error with the
 * text in `message` or `data`, a code of its own, or plain text at the end of a normal turn.
 *
 * Profiles are picked by the agent's id in Zed's registry. Agents not listed here get "generic":
 * the shared rules on the error alone, never on the agent's prose.
 */
export type AgentProfile =
  | "claude"
  | "codex"
  | "gemini"
  | "qwen"
  | "qoder"
  | "kimi"
  | "glm"
  | "minimax"
  | "auggie"
  | "codebuddy"
  | "antigravity"
  | "copilot"
  | "cursor"
  | "amp"
  | "droid"
  | "goose"
  | "fast-agent"
  | "cortex"
  | "autohand"
  | "opencode"
  | "cline"
  | "vibe"
  | "junie"
  | "devin"
  | "grok"
  | "generic";

const PROFILE_BY_ID: Record<string, AgentProfile> = {
  "claude-acp": "claude",
  "claude-code-acp": "claude",
  "codex-acp": "codex",
  gemini: "gemini",
  "qwen-code": "qwen",
  qoder: "qoder",
  kimi: "kimi",
  "glm-acp-agent": "glm",
  "minimax-code": "minimax",
  auggie: "auggie",
  "codebuddy-code": "codebuddy",
  "antigravity-acp": "antigravity",
  "github-copilot-cli": "copilot",
  cursor: "cursor",
  "amp-acp": "amp",
  "factory-droid": "droid",
  goose: "goose",
  "fast-agent": "fast-agent",
  "cortex-code": "cortex",
  autohand: "autohand",
  opencode: "opencode",
  kilo: "opencode",
  cline: "cline",
  "mistral-vibe": "vibe",
  junie: "junie",
  devin: "devin",
  "grok-build": "grok",
};

/** The profile for an agent: by its id in Zed's settings first, then by the name it reports. */
export function profileFor(agentId: string | undefined, agentName: unknown): AgentProfile {
  const byId = agentId ? PROFILE_BY_ID[agentId] : undefined;
  if (byId) return byId;
  const name = typeof agentName === "string" ? agentName : "";
  if (/claude/i.test(name)) return "claude";
  if (/codex/i.test(name)) return "codex";
  if (/gemini/i.test(name)) return "gemini";
  return "generic";
}

/** A usage-limit classification may carry the reset time the error's own text gives. */
export type LimitClassification = Classification & { resetAt?: number };

/** What else Rewake saw during the turn, for agents that report limits outside the error. */
export interface TurnContext {
  /** Claude's latest `rate_limit_event` of this turn. */
  rateLimit?: RateLimitInfo | undefined;
}

/** Agents that report a limit as the turn's last message (see `classifyTurnEnd`). */
const TURN_END_PROFILES: ReadonlySet<AgentProfile> = new Set([
  "cursor",
  "copilot",
  "amp",
  "droid",
  "antigravity",
  "goose",
  "fast-agent",
  "cortex",
  "autohand",
]);

const DAY_MS = 86_400_000;

/** A limit with less than this left is a short-term rate limit: the agent retries those itself. */
const SHORT_WAIT_MS = 15 * 60_000;

const SESSION_LOST =
  /\bsession\b(?:\s+\S+)?\s+not found|unknown session|no such session|no ACP session found|\bthread not found\b/i;

const CONTEXT =
  /context window|context length|context_length_exceeded|maximum context|prompt is too long|prompt too long|ran out of room in the model's context|context limit exceeded|context overflow|exceeded model token limit|prompt token count|input token count[^\n]{0,200}exceeds/i;

/** A reply cut at the model's output limit: not a usage limit (Cline). */
const OUTPUT_LIMIT = /maximum output token limit/i;

/** Words that make an error a limit of some kind at all. */
const LIMIT =
  /usage limit|rate[ _-]?limit|quota|limit (?:reached|exceeded|exhausted)|(?:reached|hit) (?:your|the) [\w '-]{0,60}limit|too many (?:requests|tokens)|resource[_ ]exhausted|allowance|throttl|Project budget exceeded/i;

/**
 * Words that make a limit the plan's, not a short-term rate limit. A bare "rate limit exceeded" or
 * "429 Too Many Requests" without any of these is short-term: agents and SDKs retry those.
 */
const PLAN =
  /usage limit|quota|allowance|(?:reached|hit) (?:your|the) [\w '-]{0,60}limit|(?<!rate[ _-]?)limit (?:reached|exceeded|exhausted)|\bfree\b|Project budget exceeded/i;

/** A plan window: these reset on a schedule, whatever the retry hint says. */
const WINDOW =
  /\b(?:5|five)[- ]hours?\b|\bweekly\b|\b7-day\b|\bper day\b|\bdaily\b|\b(?:RPD|TPD)\b|tokens per day|free-models-per-day|PerDay|ByDay|86400\s*s|\bnext hour\b|\bsession limit\b|\bmonthly\b/i;

/** Short-term limits and overload: the agent's own retries deal with these. */
const SHORT =
  /per min(?:ute)?\b|\b(?:RPM|TPM)\b|per-minute|try again shortly|retry shortly|try again in a (?:few )?moments?|a moment and try again|please wait before trying again|would exceed your (?:organization's|account's) rate limit|too (?:quickly|frequently)|overloaded|high demand|high traffic|at capacity|no capacity|out of capacity|capacity (?:exceeded|unavailable)|temporarily (?:unavailable|limiting|overloaded)|concurren(?:t request|cy)/i;

/**
 * Money that waiting won't bring back. Phrases, not single words: "billing details" and "Add 10
 * credits to unlock…" appear in limits that do reset, and links are removed before matching.
 */
const MONEY =
  /insufficient[ _](?:account[ _])?(?:balance|credits?|funds|quota)|out of (?:usage )?credits|credit balance|no credits|not enough credits|requires? (?:more )?credits|used all (?:available|your) credits|add credits|add funds|top up|recharge|payment (?:is )?(?:past due|required|method)|billing or payment information|billing (?:hard )?limit|billing_error|spend(?:ing)? (?:limit|cap)|(?<!Project )budget (?:exhausted|exceeded)|out of budget|maximum budget exceeded|credit limit|exceeded (?:your )?current quota|subscription (?:has )?(?:ended|expired)|not subscribed|package has expired|plan expired|account (?:is )?(?:suspended|deactivated|on hold)|credits_exhausted/i;

/** Gemini words its per-minute and per-day quotas with OpenAI's billing sentence. */
const GEMINI_QUOTA = /RESOURCE_EXHAUSTED|generativelanguage/;

/** Gemini's "this tier has no quota for the model": no wait brings it. */
const NO_QUOTA = /limit:\s*0(?!\d|\.\d)/i;

/** Sign-in failures, including the provider's own wording passed through. */
const AUTH =
  /Unable to import @langchain|MODEL_AUTHENTICATION|authentication_error|invalid API Key/i;

export interface TextOptions {
  /** The zone for a reset time given without one. */
  zone?: string;
}

/**
 * The shared rules, in order: session lost, context, a reset time or plan window (which wins over
 * money words: "buy credits or wait until…" is a limit that resets), short-term limits, money, and
 * any other limit wording.
 */
export function classifyText(
  input: string,
  now: number,
  options: TextOptions = {},
): LimitClassification {
  const text = normalize(input);
  if (SESSION_LOST.test(text)) return { kind: "session_lost", text };
  if (CONTEXT.test(text)) return { kind: "not_recoverable", text, reason: "context" };
  if (OUTPUT_LIMIT.test(text)) return { kind: "other", text };
  const status = httpStatus(text);
  const plain = withoutUrls(text);
  if (AUTH.test(plain) || status === 401) return { kind: "not_recoverable", text, reason: "auth" };
  const money =
    (MONEY.test(plain) &&
      !(/exceeded (?:your )?current quota/i.test(plain) && GEMINI_QUOTA.test(text))) ||
    (NO_QUOTA.test(plain) && /Quota exceeded for metric|RESOURCE_EXHAUSTED/i.test(text)) ||
    status === 402;
  if (!LIMIT.test(plain) && status !== 429 && !money)
    return SHORT.test(plain) || (status !== undefined && status >= 500)
      ? { kind: "transient", text }
      : { kind: "other", text };

  const window = WINDOW.test(plain);
  let resetAt = parseResetHint(text, now, options);
  if (resetAt !== undefined && resetAt - now < SHORT_WAIT_MS) {
    // A short hint on a plan window is a token bucket refilling, not the window's reset.
    if (!window && !money) return { kind: "transient", text };
    resetAt = undefined;
  }
  const limitType = typeOf(plain);
  if (resetAt !== undefined) return { kind: "usage_limit", text, limitType, resetAt };
  if (SHORT.test(plain) && !window && !money) return { kind: "transient", text };
  if (money) return { kind: "not_recoverable", text, reason: "billing" };
  if (!window && !PLAN.test(plain)) return { kind: "transient", text };
  return { kind: "usage_limit", text, limitType };
}

function typeOf(text: string): LimitType {
  if (/weekly|7-day/i.test(text)) return "weekly";
  if (/(?:5|five)[- ]hours?|session/i.test(text)) return "session";
  return "other";
}

function usage(text: string, resetAt?: number, limitType?: LimitType): LimitClassification {
  return {
    kind: "usage_limit",
    text,
    limitType: limitType ?? typeOf(text),
    ...(resetAt !== undefined && { resetAt }),
  };
}

/** A retry hint: transient when short, a usage limit with that reset when long. */
function byWait(text: string, ms: number, now: number): LimitClassification {
  return ms < SHORT_WAIT_MS ? { kind: "transient", text } : usage(text, now + ms);
}

/**
 * Structured fields some agents send with the error; more reliable than any text. Kimchi `kind`,
 * Harn `terminalClass`, Devin `cognition.ai/errorKind`, goose and Junie `reason`, OpenCode `errorName`.
 */
function structured(
  data: Record<string, unknown>,
  text: string,
  now: number,
): LimitClassification | undefined {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const kind = data.kind;
  if (typeof kind === "string") {
    const at = num(data.retryAtMs);
    if (kind === "rate_limit")
      return at !== undefined ? byWait(text, at - now, now) : { kind: "transient", text };
    if (kind === "budget_exhausted") return { kind: "not_recoverable", text, reason: "billing" };
    if (kind === "context_window_exceeded")
      return { kind: "not_recoverable", text, reason: "context" };
    if (kind === "provider_5xx" || kind === "transport_failure" || kind === "stream_interrupted")
      return { kind: "transient", text };
  }
  const terminal = data.terminalClass;
  if (typeof terminal === "string") {
    const wait = num(data.retryAfterMs);
    if (terminal === "rate_limited")
      return wait !== undefined ? byWait(text, wait, now) : { kind: "transient", text };
    if (terminal === "provider_billing")
      return { kind: "not_recoverable", text, reason: "billing" };
    if (terminal === "provider_misconfigured") return { kind: "not_recoverable", text };
    if (terminal === "context_overflow")
      return { kind: "not_recoverable", text, reason: "context" };
    if (["provider_unavailable", "timeout", "resource_busy"].includes(terminal))
      return { kind: "transient", text };
  }
  const devin = data["cognition.ai/errorKind"];
  if (typeof devin === "string") {
    const wait = num(data["cognition.ai/retryAfterSeconds"]);
    if (devin === "resource_exhausted") {
      if (/admin paused usage/i.test(text)) return { kind: "not_recoverable", text };
      if (wait !== undefined) return byWait(text, wait * 1000, now);
      if (/^Rate limited:/i.test(text)) return { kind: "transient", text };
      return usage(text, parseResetHint(text, now));
    }
    if (devin === "unavailable" || devin === "deadline_exceeded")
      return { kind: "transient", text };
  }
  const reason = data.reason;
  if (reason === "credits_exhausted" || reason === "insufficient_account_balance")
    return { kind: "not_recoverable", text, reason: "billing" };
  if (reason === "rate_limit_exceeded") return { kind: "transient", text };
  if (reason === "unknown_session") return { kind: "session_lost", text };
  if (data.errorName === "ContextOverflowError")
    return { kind: "not_recoverable", text, reason: "context" };
  return undefined;
}

/**
 * The agent no longer knows the session, so Rewake re-opens it and sends the message again. Agents
 * say it as "Session not found" (Claude's `data.details`), "Session <id> not found", "Session not
 * found: <id>", "Resource not found: Session <id> not found" or JSON-RPC `-32002` (goose, Cline).
 */
export function isSessionLost(error: RpcError): boolean {
  const data =
    error.data && typeof error.data === "object" ? (error.data as Record<string, unknown>) : {};
  return (
    error.code === -32002 ||
    data.details === "Session not found" ||
    data.session_id === "Session not found" ||
    data.reason === "unknown_session" ||
    SESSION_LOST.test(errorText(error))
  );
}

/**
 * Classify a failed `session/prompt` for this agent. Only the error itself is trusted, never the
 * agent's own messages, which can contain the same words (see `classifyTurnEnd` for the agents that
 * report limits only as text).
 */
export function classifyLimit(
  profile: AgentProfile,
  error: RpcError,
  now: number,
  context: TurnContext = {},
): LimitClassification {
  if (profile === "claude") {
    if (error.code === -32000)
      return { kind: "not_recoverable", text: errorText(error), reason: "auth" };
    const c = classifyPromptError(error, context.rateLimit);
    if (c.kind === "transient") {
      // A gateway in front of Claude ("spend limit reached (daily; resets 00:00 UTC)") gives its
      // own reset. A long one is a limit to resume after; a short one the SDK already retried; one
      // more than a day away is a spending cap.
      const resetAt = /\bresets?\b/i.test(c.text) ? parseResetHint(c.text, now) : undefined;
      if (resetAt !== undefined && resetAt - now > DAY_MS)
        return { kind: "not_recoverable", text: c.text, reason: "billing" };
      if (resetAt !== undefined && resetAt - now >= SHORT_WAIT_MS)
        return { kind: "usage_limit", text: c.text, limitType: typeOf(c.text), resetAt };
      return c;
    }
    if (c.kind !== "usage_limit") return c;
    const resetAt = resumableReset(context.rateLimit) ?? parseResetHint(c.text, now);
    return resetAt === undefined ? c : { ...c, resetAt };
  }
  const data =
    error.data && typeof error.data === "object" ? (error.data as Record<string, unknown>) : {};
  const text = errorText(error);
  if (isSessionLost(error)) return { kind: "session_lost", text };
  const found = structured(data, text, now) ?? byProfile(profile, error, data, text, now);
  if (found) return found;
  if (error.code === -32000) return { kind: "not_recoverable", text, reason: "auth" };
  const c = classifyText(text, now, zoneFor(profile));
  // Credit-based agents have no plan window that resets: their quota errors are rate limits.
  if (c.kind === "usage_limit" && (profile === "auggie" || profile === "codebuddy"))
    return { kind: "transient", text };
  return c;
}

function zoneFor(profile: AgentProfile): TextOptions {
  // Z.AI prints its reset times without a zone, in its own (UTC+8).
  if (profile === "glm") return { zone: "Asia/Shanghai" };
  // Copilot prints a reset date in UTC without saying so.
  if (profile === "copilot") return { zone: "UTC" };
  return {};
}

/** Codex's `codexErrorInfo` kinds that aren't the plan's usage limit (codex-acp). */
const CODEX_TRANSIENT = new Set(["rateLimitExceeded", "serverOverloaded", "flexUnavailable"]);
const CODEX_NOT_RECOVERABLE = new Set([
  "sessionBudgetExceeded",
  "contextWindowExceeded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "tooManyDenials",
]);

/** CodeBuddy business codes (`data.code`). */
const CODEBUDDY_TRANSIENT = new Set([6000, 6001, 6002, 6005, 6006, 14003]);
const CODEBUDDY_USAGE = new Set([6003, 6004, 6007, 6008]);
const CODEBUDDY_NOT_RECOVERABLE = new Set([
  14001, 14012, 14013, 14014, 14015, 14016, 14017, 14018, 14019,
]);

function byProfile(
  profile: AgentProfile,
  error: RpcError,
  data: Record<string, unknown>,
  text: string,
  now: number,
): LimitClassification | undefined {
  switch (profile) {
    case "codex": {
      const info = data.codexErrorInfo;
      if (typeof info !== "string") return undefined;
      if (info === "usageLimitExceeded") {
        // Codex uses one kind for its plan limit and for credits, spend caps and plan checks.
        const message = typeof data.message === "string" ? normalize(data.message) : text;
        if (/^You've hit your usage limit/.test(message))
          return usage(
            text,
            parseResetHint(text, now),
            /^You've hit your usage limit for /.test(message) ? "model" : "other",
          );
        if (
          /^Quota exceeded\.|upgrade to Plus: |workspace is out of credits|^You hit your spend cap/.test(
            message,
          )
        )
          return { kind: "not_recoverable", text, reason: "billing" };
        return usage(text, parseResetHint(text, now));
      }
      if (CODEX_TRANSIENT.has(info)) return { kind: "transient", text };
      if (CODEX_NOT_RECOVERABLE.has(info))
        return {
          kind: "not_recoverable",
          text,
          ...(info === "contextWindowExceeded" && { reason: "context" as const }),
        };
      return { kind: "other", text };
    }
    case "gemini":
    case "qwen":
    case "qoder": {
      if (profile === "qwen" && /free tier has been discontinued/i.test(text))
        return { kind: "not_recoverable", text, reason: "billing" };
      if (profile === "qwen" && /^Quota exhausted: /m.test(text))
        return usage(text, parseResetHint(text, now));
      if (profile === "qoder" && /^Maximum budget exceeded/m.test(text))
        return { kind: "not_recoverable", text, reason: "billing" };
      if (/Validation required to continue/i.test(text))
        return { kind: "not_recoverable", text, reason: "auth" };
      if (error.code !== 429) return undefined;
      // Gemini CLI's own tests, and the quota words that mean a daily or plan limit.
      if (NO_QUOTA.test(text)) return { kind: "not_recoverable", text };
      if (/No capacity available|capacity exceeded|MODEL_CAPACITY/i.test(text))
        return { kind: "transient", text };
      if (/daily quota|per ?day|PerDay|Individual quota reached/i.test(text)) return usage(text);
      const go = /reset after ((?:\d+(?:\.\d+)?(?:h|m|s|ms))+)/i.exec(text)?.[1];
      const retry =
        /(?:Please retry in|Suggested retry after|retry after)\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(
          text,
        );
      // "reset after 0s" is a duration too, of nothing.
      const ms =
        go !== undefined
          ? (parseDuration(go) ?? 0)
          : retry
            ? Number(retry[1]) * (retry[2] === "ms" ? 1 : 1000)
            : undefined;
      if (ms !== undefined)
        return ms <= 300_000 ? { kind: "transient", text } : usage(text, now + ms);
      if (/exhausted your capacity/i.test(text)) return usage(text);
      // "Rate limit exceeded. Try again later.": the CLI dropped the server's reason and time.
      return usage(text);
    }
    case "kimi":
      if (data.session_id === "Session not found") return { kind: "session_lost", text };
      // Kimi Code's error reference: what each status and sentence means.
      if (/^Error code: 401\b/m.test(text))
        return { kind: "not_recoverable", text, reason: "auth" };
      if (
        /concurrent request limit|too many requests|engine is currently overloaded|engine_overloaded_error/i.test(
          text,
        )
      )
        return { kind: "transient", text };
      if (/monthly usage limit/i.test(text))
        return { kind: "not_recoverable", text, reason: "billing" };
      return undefined;
    case "glm":
      if (/Rate limit reached for requests|temporarily overloaded/i.test(text))
        return { kind: "transient", text };
      if (
        /Insufficient balance or no resource package|does not yet include access|Fair Usage Policy|limited to enterprise coding package/i.test(
          text,
        ) &&
        !/(?:Your limit will reset at|Resets at) \d{4}-/i.test(text)
      )
        return { kind: "not_recoverable", text, reason: "billing" };
      return undefined;
    case "minimax":
      if (
        /\b(?:1004|2049)\b|invalid API Key|not authorized|log in again|authentication failed/i.test(
          text,
        )
      )
        return { kind: "not_recoverable", text, reason: "auth" };
      if (
        /\b(?:2056|2067)\b|usage limit (?:exceeded|reached)|package quota has reached/i.test(text)
      )
        return usage(text, parseResetHint(text, now));
      if (/\b(?:1008|1400010161)\b|insufficient balance|credits? exhausted|hibernation/i.test(text))
        return { kind: "not_recoverable", text, reason: "billing" };
      if (
        /\b(?:1002|1039|1041|2045|2046|2047)\b|rate limit|too frequent|overloaded|token limit|conn limit|rate growth limit/i.test(
          text,
        )
      )
        return { kind: "transient", text };
      return undefined;
    case "auggie": {
      const api = data.apiStatus;
      if (api === "resourceExhausted") return { kind: "transient", text };
      if (
        api === "permissionDenied" ||
        api === "unauthenticated" ||
        api === "augmentUpgradeRequired"
      )
        return { kind: "not_recoverable", text };
      return undefined;
    }
    case "codebuddy": {
      const code = typeof data.code === "number" ? data.code : Number(data.code);
      if (code === 11115) return { kind: "not_recoverable", text, reason: "context" };
      if (CODEBUDDY_TRANSIENT.has(code)) return { kind: "transient", text };
      if (CODEBUDDY_USAGE.has(code)) return usage(text, parseResetHint(text, now));
      if (CODEBUDDY_NOT_RECOVERABLE.has(code))
        return { kind: "not_recoverable", text, reason: "billing" };
      if (error.code === -32003 || data.category === "quota")
        return /credit|额度/i.test(text)
          ? { kind: "not_recoverable", text, reason: "billing" }
          : { kind: "transient", text };
      return undefined;
    }
    case "vibe":
      if (error.code === -31001) return usage(text);
      if (error.code === -31004) return { kind: "not_recoverable", text, reason: "context" };
      if (error.code === -31002) return { kind: "not_recoverable", text };
      if (error.code === -31003) return { kind: "other", text }; // the conversation's own limit
      if (/ReadError|ConnectError/.test(text)) return { kind: "transient", text };
      return undefined;
    case "junie":
      if (error.code === -32011) return { kind: "transient", text };
      if (error.code === -32010) return { kind: "not_recoverable", text, reason: "billing" };
      return undefined;
    case "devin":
      if (error.code === -32011) return usage(text, parseResetHint(text, now));
      return undefined;
    case "grok":
      return grokText(text);
    case "opencode":
      if (
        /Free promotion has ended|^Quota exceeded\. Check your plan and billing details|upgrade to Plus: /m.test(
          text,
        )
      )
        return { kind: "not_recoverable", text, reason: "billing" };
      // OpenCode Zen's free tier: a daily limit, though worded like a short one.
      if (/^Rate limit exceeded\. Please try again later\.$/m.test(text)) return usage(text);
      return undefined;
    case "cline":
      if (
        /No access to ClinePass|Organization accounts cannot use ClinePass|not subscribed to required model plan/i.test(
          text,
        )
      )
        return { kind: "not_recoverable", text, reason: "billing" };
      if (/Model returned empty response/i.test(text)) return { kind: "transient", text };
      return undefined;
    case "droid":
      if (/API key authentication failed|No authentication available/i.test(text))
        return { kind: "not_recoverable", text, reason: "auth" };
      return undefined;
    case "fast-agent":
      if (/Google API Error: 429/.test(text)) return { kind: "transient", text };
      return undefined;
    default:
      return undefined;
  }
}

/** Grok Build words every case differently, and none of its texts carry a reset time. */
function grokText(text: string): LimitClassification | undefined {
  if (/^You've hit your team's API rate limit|^You've hit the rate limit for your plan/m.test(text))
    return { kind: "transient", text };
  if (/^You've reached your free Grok Build usage limit/m.test(text)) return usage(text);
  if (/temporarily (?:overloaded|unavailable)/i.test(text)) return { kind: "transient", text };
  if (
    /out of credits or over your spending limit|credit limit for your plan|spending cap|requires a Grok subscription/i.test(
      text,
    )
  )
    return { kind: "not_recoverable", text, reason: "billing" };
  return undefined;
}

/**
 * Agents that end a turn normally and report the limit as its last message. Each pattern is the
 * agent's own fixed template, found in its source; it must start the turn's last message, so the
 * model's own words elsewhere in a reply never count. Returns undefined when the turn ended
 * normally as far as Rewake can tell.
 */
export function classifyTurnEnd(
  profile: AgentProfile,
  lastMessage: string,
  stopReason: unknown,
  now: number,
  chunks = 1,
): LimitClassification | undefined {
  if (!TURN_END_PROFILES.has(profile)) return undefined;
  const message = normalize(lastMessage.trim());
  if (!message) return undefined;
  // cursor-agent starts its own lines with a blank line; text the model writes doesn't.
  if (profile === "cursor" && !lastMessage.startsWith("\n\n")) return undefined;
  const c = turnEnd(profile, message, stopReason, now, chunks);
  // Only what Rewake acts on: a limit to resume after, or one that waiting won't fix.
  if (c?.kind === "usage_limit" || (c?.kind === "not_recoverable" && c.reason === "billing"))
    return c;
  return undefined;
}

function turnEnd(
  profile: AgentProfile,
  message: string,
  stopReason: unknown,
  now: number,
  chunks: number,
): LimitClassification | undefined {
  const ended = stopReason === "end_turn";
  const options = zoneFor(profile);
  switch (profile) {
    case "cursor": {
      if (!ended) return undefined;
      // cursor-agent replaces the server's text with one line per action.
      if (/^Upgrade your plan to continue$/.test(message)) return usage(message);
      if (/^Add a payment method to continue$/.test(message))
        return { kind: "not_recoverable", text: message, reason: "billing" };
      const m = /^Error: (?:\w*Error|T): ([\s\S]+)$/.exec(message);
      return m?.[1] ? classifyText(m[1], now, options) : undefined;
    }
    case "copilot": {
      if (!ended) return undefined;
      const m = /^Error: ([\s\S]+)$/.exec(message);
      if (!m?.[1]) return undefined;
      // After its own retries Copilot wraps the last error: "Failed to get response … Last error: …".
      const text = m[1].replace(
        /^(?:Execution failed: )?Failed to get response[\s\S]*?Last error: /,
        "",
      );
      if (
        /run out of your included AI credits|Copilot Free chat requests for the month/i.test(text)
      )
        return usage(text);
      // A 402 from Copilot's service is the premium-request allowance.
      if (/^402\b/.test(text)) return usage(text);
      // "You've hit your rate limit. Please wait for your limit to reset." with no time: short-term.
      if (/^You've hit your rate limit\b/i.test(text) && parseResetHint(text, now) === undefined)
        return undefined;
      if (
        /spending limit for this session|Session limits exhausted|not licensed|trials have been temporarily paused|multiple GitHub Copilot licenses/i.test(
          text,
        )
      )
        return { kind: "not_recoverable", text, reason: "billing" };
      // Copilot's own rate-limit sentences (CLI 1.0.92, older CLIs, and the raw BYOK status line).
      if (
        /^(?:\d{3} )?(?:Sorry, )?you've (?:reached your weekly|hit your session|hit the|hit your|hit a|exceeded your) rate limit/i.test(
          text,
        )
      )
        return classifyText(text, now, options);
      return undefined;
    }
    case "amp": {
      if (!ended || chunks !== 1) return undefined;
      const m = /^Error: ([\s\S]+)$/.exec(message);
      if (!m?.[1]) return undefined;
      const text = m[1];
      if (/monthly limit, and no paid credits/i.test(text)) return usage(text);
      if (/wait until the next hour starts/i.test(text))
        return usage(text, parseResetHint(text, now));
      if (
        /out of credits|workspace usage limit|in available credits to start|exceeded your usage (?:limit|quota) of/i.test(
          text,
        )
      )
        return { kind: "not_recoverable", text, reason: "billing" };
      if (/^You've reached your free usage limit|^Rate limit exceeded\b/i.test(text))
        return classifyText(text, now, options);
      return undefined;
    }
    case "droid": {
      // The daemon ends the turn with "Internal error: Agent error"; the real text is this message.
      if ((stopReason !== "error" && !ended) || chunks !== 1) return undefined;
      const m = /^Error: ([\s\S]+)$/.exec(message);
      if (!m?.[1]) return undefined;
      const text = m[1];
      if (/reached your [^"\n]{0,80}usage limit/i.test(text) && !/credit limit reached/i.test(text))
        return usage(text, parseResetHint(text, now));
      if (/extra usage balance is empty|reload your tokens|credit limit reached/i.test(text))
        return { kind: "not_recoverable", text, reason: "billing" };
      // Droid passes the provider's failure on as "<status> <body>".
      return /^(?:402|429)\b/.test(text) ? classifyText(text, now, options) : undefined;
    }
    case "antigravity": {
      if (!ended) return undefined;
      if (
        /^Usage Limit Reached\s+You have reached your current quota for this period\./.test(
          message,
        ) ||
        /^(?:Agent execution error: )?You have exhausted your (?:capacity|quota) on this model/.test(
          message,
        )
      ) {
        const resetAt = parseResetHint(message, now, { zone: "UTC" });
        // "Your quota will reset after 5s": a short wait the agent rides out itself.
        if (resetAt !== undefined && resetAt - now < SHORT_WAIT_MS) return undefined;
        return usage(message, resetAt);
      }
      return undefined;
    }
    case "goose": {
      if (!ended) return undefined;
      const m = /^Ran into this error: Rate limit exceeded:([\s\S]*)$/.exec(message);
      if (!m) return undefined;
      const rest = m[1] ?? "";
      if (/\bTPD\b|per day|daily|quota/i.test(rest)) {
        const resetAt = parseResetHint(rest, now);
        return usage(
          message,
          resetAt !== undefined && resetAt - now >= SHORT_WAIT_MS ? resetAt : undefined,
        );
      }
      return { kind: "transient", text: message };
    }
    case "fast-agent": {
      if (stopReason !== "refusal") return undefined;
      const m = /^I hit an internal error while calling the model:([\s\S]*)$/.exec(message);
      if (!m) return undefined;
      const rest = m[1] ?? "";
      if (/usage_limit_reached/.test(rest)) return usage(message, parseResetHint(rest, now));
      if (/insufficient_quota|billing|credit/i.test(rest))
        return { kind: "not_recoverable", text: message, reason: "billing" };
      if (/\(status=429\)/.test(rest)) return { kind: "transient", text: message };
      return undefined;
    }
    case "cortex":
      // A rolling 24-hour limit, despite the word "credit".
      if (
        ended &&
        /^(?:Error:\s*)*(?:API error \d{3}:\s*)?Daily credit usage limit reached\./.test(message)
      )
        return usage(message);
      return undefined;
    case "autohand": {
      if (!ended) return undefined;
      const m = /^> \*\*Error:\*\* Autohand exited with code \d+([\s\S]*)$/.exec(message);
      if (!m) return undefined;
      const rest = m[1] ?? "";
      if (/request quota reached/i.test(rest)) {
        const wait = /·\s*in\s+([\dhmsd ]+)/i.exec(rest)?.[1];
        const ms = wait ? parseDuration(wait) : undefined;
        return usage(rest.trim(), ms === undefined ? undefined : now + ms, typeOf(rest));
      }
      return classifyText(rest, now, options);
    }
    default:
      return undefined;
  }
}
