import type { JsonRpcMessage } from "../acp/ndjson.js";
import { type Classification, classifyPromptError, parseResetText } from "./claude/limits.js";

/**
 * What differs between agents when a usage limit hits. Everything else in Rewake is the same for every agent and
 * is decided from what the agent advertises over ACP.
 *
 *  - claude: claude-agent-acp, `-32603` with `errorKind: "rate_limit"` and the SDK's limit text.
 *  - codex:  codex-acp 2.1.1, `-32603` with `data.codexErrorInfo: "usageLimitExceeded"`; the reset
 *            time is in the text ("Try again at 6:34 AM"), in local time.
 *  - gemini: gemini-cli 0.62.0, JSON-RPC code 429 "Rate limit exceeded. Try again later.", no time.
 *  - generic: everyone else; a cautious match on the error message only (never the agent's prose).
 */
export type AgentProfile = "claude" | "codex" | "gemini" | "generic";

const PROFILE_BY_ID: Record<string, AgentProfile> = {
  "claude-acp": "claude",
  "claude-code-acp": "claude",
  "codex-acp": "codex",
  gemini: "gemini",
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

/** Codex error kinds that aren't the plan's usage limit (codex-acp `STRING_CODEX_ERROR_CATEGORIES`). */
const CODEX_TRANSIENT = new Set(["rateLimitExceeded", "serverOverloaded", "flexUnavailable"]);
const CODEX_NOT_RECOVERABLE = new Set([
  "sessionBudgetExceeded",
  "contextWindowExceeded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "tooManyDenials",
]);

/** Limits that waiting won't fix, in any agent's words: credits, billing, budgets, context. */
const NOT_FIXED_BY_WAITING =
  /credit|billing|payment|budget|spend|context window|context length|seat|subscription (?:has )?(?:ended|expired)|upgrade your plan/i;

/** A plan or rate limit, as agents word it in their errors. */
const GENERIC_LIMIT =
  /usage limit|rate limit (?:reached|exceeded)|quota (?:exceeded|exhausted|reached)|you've (?:hit|reached) your [a-z -]*limit|too many requests|resource[_ ]exhausted/i;

const SESSION_LOST = /session not found|unknown session|no such session/i;

/**
 * Classify a failed `session/prompt` for this agent. Only the error itself is trusted, never the
 * agent's own messages, which can contain the same words.
 */
export function classifyLimit(
  profile: AgentProfile,
  error: NonNullable<JsonRpcMessage["error"]>,
  now: number,
): LimitClassification {
  if (profile === "claude") {
    const c = classifyPromptError(error);
    return c.kind === "usage_limit" ? withReset(c, c.text, now) : c;
  }
  const data = (error.data ?? {}) as Record<string, unknown>;
  const message = typeof data.message === "string" && data.message ? data.message : error.message;
  const text = message.replace(/^Internal error:\s*/, "").trim();
  if (SESSION_LOST.test(text) || data.details === "Session not found")
    return { kind: "session_lost", text };

  if (profile === "codex" && typeof data.codexErrorInfo === "string") {
    const kind = data.codexErrorInfo;
    if (kind === "usageLimitExceeded")
      return withReset({ kind: "usage_limit", text, limitType: "other" }, text, now);
    if (CODEX_TRANSIENT.has(kind)) return { kind: "transient", text };
    if (CODEX_NOT_RECOVERABLE.has(kind)) return { kind: "not_recoverable", text };
    return { kind: "other", text };
  }
  if (profile === "gemini" && error.code === 429)
    return withReset({ kind: "usage_limit", text, limitType: "other" }, text, now);

  if (GENERIC_LIMIT.test(text) || error.code === 429) {
    if (NOT_FIXED_BY_WAITING.test(text)) return { kind: "not_recoverable", text };
    const limitType = /weekly/i.test(text)
      ? "weekly"
      : /5-hour|five.hour|session/i.test(text)
        ? "session"
        : "other";
    return withReset({ kind: "usage_limit", text, limitType }, text, now);
  }
  return { kind: "other", text };
}

function withReset(
  c: Extract<Classification, { kind: "usage_limit" }>,
  text: string,
  now: number,
): LimitClassification {
  const resetAt = parseResetHint(text, now);
  return resetAt === undefined ? c : { ...c, resetAt };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A reset time in any agent's words, in local time unless the text names a zone:
 *  - Claude: "resets 4:50pm (Europe/Samara)", "resets Mon 12:00am"
 *  - Codex:  "Try again at 6:34 AM." or "Try again at Sep 15th, 2026 9:25 AM."
 *  - others: "try again in 2 hours", "resets in 3h 20m", "reset in 45 minutes"
 */
export function parseResetHint(text: string, now: number): number | undefined {
  const claude = parseResetText(text, now);
  if (claude) return claude.resetAt;

  const at =
    /try again (?:at|after)\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(
      text,
    );
  if (at) {
    let hour = Number(at[4]);
    const minute = at[5] ? Number(at[5]) : 0;
    const ampm = at[6]?.toLowerCase().replace(/\./g, "");
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) {
      if (at[1] && at[2] && at[3]) {
        const month = MONTHS.indexOf(at[1].toLowerCase());
        if (month >= 0) {
          const t = new Date(Number(at[3]), month, Number(at[2]), hour, minute).getTime();
          if (t > now - 60_000) return t;
        }
      } else {
        const d = new Date(now);
        d.setHours(hour, minute, 0, 0);
        if (d.getTime() <= now - 60_000) d.setDate(d.getDate() + 1);
        return d.getTime();
      }
    }
  }

  const rel =
    /(?:try again|reset[s]?|available again|wait[a-z ]*?)\s+(?:in|after)\s+(?:(\d+)\s*(?:h|hours?|hrs?))?\s*(?:(\d+)\s*(?:m|min|minutes?|mins?))?/i.exec(
      text,
    );
  if (rel && (rel[1] || rel[2])) {
    const ms = (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000;
    if (ms > 0) return now + ms;
  }
  return undefined;
}
