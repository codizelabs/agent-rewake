import { describe, expect, it } from "vitest";
import {
  type AgentProfile,
  classifyLimit,
  classifyTurnEnd,
  type LimitClassification,
} from "../src/adapters/profiles.js";

// More messages as agents and providers send them (their source, docs and public reports), kept so
// a change to the rules can't quietly stop recognising one. Reset times are checked where the
// message gives one.
const NOW = new Date(2026, 9, 6, 14, 0, 0, 0).getTime(); // Tuesday 6 Oct 2026, 14:00 local
const MIN = 60_000;
const HOUR = 60 * MIN;

type RpcError = { code: number; message: string; data?: unknown };
type Want = string;

function expectClass(c: LimitClassification | undefined, want: Want, reset?: number) {
  if (want === "none") return expect(c).toBeUndefined();
  if (want === "billing" || want === "context" || want === "auth") {
    expect({ kind: c?.kind, reason: c && "reason" in c ? c.reason : undefined }).toEqual({
      kind: "not_recoverable",
      reason: want,
    });
  } else expect(c?.kind).toBe(want);
  if (reset !== undefined) expect(c?.resetAt).toBe(reset);
}

describe("errors", () => {
  it.each<[string, AgentProfile, RpcError, Want, number?]>([
    [
      "claude: 5-hour limit reached ∙ resets 5am",
      "claude",
      {
        code: -32603,
        message: "Internal error: 5-hour limit reached ∙ resets 5am",
        data: { errorKind: "rate_limit" },
      },
      "usage_limit",
      NOW + 15 * HOUR,
    ],
    [
      "codex: exceeded retry limit, last status: 500 Internal Server Error",
      "codex",
      {
        code: -32603,
        message: "Internal error: exceeded retry limit, last status: 500 Internal Server Error",
      },
      "transient",
    ],
    [
      "codex: shared rollout token budget exhausted",
      "codex",
      { code: -32603, message: "Internal error: shared rollout token budget exhausted" },
      "not_recoverable",
    ],
    [
      "codex: Flex capacity unavailable.",
      "codex",
      { code: -32603, message: "Internal error: Flex capacity unavailable." },
      "transient",
    ],
    [
      "codex: This request has been flagged for possible cybersecurity ris",
      "codex",
      { code: -32000, message: "This request has been flagged for possible cybersecurity risk." },
      "not_recoverable",
    ],
    [
      "devin: The agent auto-continued past the per-turn billing threshold",
      "devin",
      {
        code: -32603,
        message: "Internal error: The agent auto-continued past the per-turn billing threshold.",
      },
      "other",
    ],
    [
      "copilot: You've reached your additional usage limit for your plan. Go",
      "copilot",
      {
        code: -32603,
        message:
          "Internal error: You've reached your additional usage limit for your plan. Go to https://github.com/settings/copilot/features for more details.",
      },
      "usage_limit",
    ],
    [
      "cursor: ActionRequiredError: Total usage limit reached",
      "cursor",
      { code: -32603, message: "Internal error: ActionRequiredError: Total usage limit reached" },
      "usage_limit",
    ],
    [
      "droid: The service is currently experiencing high demand. Please tr",
      "droid",
      {
        code: -32603,
        message:
          "Internal error: The service is currently experiencing high demand. Please try again in a moment.",
      },
      "transient",
    ],
    [
      "droid: This LLM provider is currently overloaded. Please switch to ",
      "droid",
      {
        code: -32603,
        message:
          "Internal error: This LLM provider is currently overloaded. Please switch to a different model and try again.",
      },
      "transient",
    ],
    [
      "droid: Request failed due to triggering the model provider's conten",
      "droid",
      {
        code: -32603,
        message:
          "Internal error: Request failed due to triggering the model provider's content moderation policy. Please modify your message and try again.",
      },
      "other",
    ],
    [
      "droid: Standard Usage limit reached.",
      "droid",
      { code: -32603, message: "Internal error: Standard Usage limit reached." },
      "usage_limit",
    ],
    [
      'droid: details:"Internal error: Agent error"',
      "droid",
      { code: -32603, message: 'Internal error: details:"Internal error: Agent error"' },
      "other",
    ],
    [
      "amp: This connection's provider reports that its servers are over",
      "amp",
      {
        code: -32603,
        message:
          "Internal error: This connection's provider reports that its servers are overloaded. Try again later.",
      },
      "transient",
    ],
    [
      "copilot: Error: Session token expired and the request could not be re",
      "copilot",
      {
        code: -32000,
        message:
          "Error: Session token expired and the request could not be retried. Please resend your message.",
      },
      "not_recoverable",
    ],
    [
      "gemini: Quota exceeded for metric: ...\\nlimit: 0, model: gemini-3-pr",
      "gemini",
      {
        code: -32603,
        message: "Internal error: Quota exceeded for metric: ...\\nlimit: 0, model: gemini-3-pro",
      },
      "not_recoverable",
    ],
    [
      "qwen: Qwen API quota exceeded: Your Qwen API quota has been exhaus",
      "qwen",
      {
        code: -32603,
        message:
          "Internal error: Qwen API quota exceeded: Your Qwen API quota has been exhausted. Please wait for your quota to reset.",
      },
      "usage_limit",
    ],
    [
      "qwen: 429 Throttling.AllocationQuota",
      "qwen",
      { code: -32603, message: "Internal error: 429 Throttling.AllocationQuota" },
      "usage_limit",
    ],
    [
      "kimi: The API Key appears to be invalid or may have expired",
      "kimi",
      { code: -32000, message: "The API Key appears to be invalid or may have expired" },
      "not_recoverable",
    ],
    [
      "antigravity: Your plan's baseline quota will refresh on 3/24/2026, 11:23:",
      "antigravity",
      {
        code: -32603,
        message:
          "Internal error: Your plan's baseline quota will refresh on 3/24/2026, 11:23:21 AM. To continue using this model now, enable AI Credit overages.",
      },
      "usage_limit",
    ],
    [
      'gemini: data.details: "Session not found: abc"',
      "gemini",
      { code: -32603, message: 'Internal error: data.details: "Session not found: abc"' },
      "session_lost",
    ],
    [
      'gemini: data.session_id: "Session not found"',
      "gemini",
      { code: -32603, message: 'Internal error: data.session_id: "Session not found"' },
      "session_lost",
    ],
    [
      'gemini: data.details: "429 Usage limit reached for 5 hour. Your limi',
      "gemini",
      {
        code: -32000,
        message:
          'data.details: "429 Usage limit reached for 5 hour. Your limit will reset at 2026-09-23 18:45:35"',
      },
      "not_recoverable",
    ],
    [
      'gemini: data.details: "429 Insufficient balance or no resource packa',
      "gemini",
      {
        code: -32603,
        message:
          'Internal error: data.details: "429 Insufficient balance or no resource package. Please recharge."',
      },
      "not_recoverable",
    ],
    [
      "gemini: Internal error: MiniMax Code Runtime failed: usage limit exc",
      "gemini",
      {
        code: -32603,
        message:
          "Internal error: Internal error: MiniMax Code Runtime failed: usage limit exceeded",
      },
      "usage_limit",
    ],
    [
      "gemini: Internal error: Too many requests",
      "gemini",
      { code: 429, message: "Internal error: Too many requests" },
      "usage_limit",
    ],
    [
      "gemini: Quota exceeded: Rate limit exceeded",
      "gemini",
      { code: -32603, message: "Internal error: Quota exceeded: Rate limit exceeded" },
      "usage_limit",
    ],
    [
      "gemini: Quota exceeded: quota exhausted",
      "gemini",
      { code: -32603, message: "Internal error: Quota exceeded: quota exhausted" },
      "usage_limit",
    ],
    [
      'generic:  cards ("API Error (Retrying)", "API Error (Retries Exhauste',
      "generic",
      {
        code: -32603,
        message:
          'Internal error:  cards ("API Error (Retrying)", "API Error (Retries Exhausted)", "API Error (Payment Required)") and finally a **',
      },
      "billing",
    ],
    [
      'generic: data.message "Unknown session id."',
      "generic",
      { code: -32603, message: 'Internal error: data.message "Unknown session id."' },
      "session_lost",
    ],
    [
      'generic: -32002 "ACP session not found: s1"',
      "generic",
      { code: -32603, message: 'Internal error: -32002 "ACP session not found: s1"' },
      "session_lost",
    ],
    [
      'generic: -32603 "Internal error: ACP session already has an active pr',
      "generic",
      {
        code: -32603,
        message:
          'Internal error: -32603 "Internal error: ACP session already has an active prompt"',
      },
      "other",
    ],
    [
      'generic: -32601 "Session not found: s1"',
      "generic",
      { code: -32603, message: 'Internal error: -32601 "Session not found: s1"' },
      "session_lost",
    ],
    [
      'generic: data.details "Cerebras API rate limit exceeded."',
      "generic",
      { code: -32603, message: 'Internal error: data.details "Cerebras API rate limit exceeded."' },
      "transient",
    ],
    [
      'generic: data.kind "budget_exhausted"',
      "generic",
      { code: -32000, message: 'data.kind "budget_exhausted"' },
      "not_recoverable",
    ],
    [
      'generic: -32602 "unknown sessionId s1"',
      "generic",
      { code: -32603, message: 'Internal error: -32602 "unknown sessionId s1"' },
      "session_lost",
    ],
    [
      'generic: -32603 "Monthly siGit Code Cloud allowance reached. It reset',
      "generic",
      {
        code: -32603,
        message:
          'Internal error: -32603 "Monthly siGit Code Cloud allowance reached. It resets at the start of your next billing period."',
      },
      "usage_limit",
    ],
    [
      'generic: -32603 "endpoint returned 429 Too Many Requests"',
      "generic",
      { code: -32603, message: 'Internal error: -32603 "endpoint returned 429 Too Many Requests"' },
      "transient",
    ],
    [
      'generic: -32602 "Unknown session: s1"',
      "generic",
      { code: -32603, message: 'Internal error: -32602 "Unknown session: s1"' },
      "session_lost",
    ],
    [
      'generic: -32601 "Method not found: session/prompt"',
      "generic",
      { code: -32603, message: 'Internal error: -32601 "Method not found: session/prompt"' },
      "other",
    ],
    [
      "goose: Please add credits to your account, then resend your message",
      "goose",
      {
        code: -32603,
        message:
          "Internal error: Please add credits to your account, then resend your message to continue.",
      },
      "not_recoverable",
    ],
    [
      "cortex: The AI quota for this account has been used up.",
      "cortex",
      { code: -32603, message: "Internal error: The AI quota for this account has been used up." },
      "usage_limit",
    ],
    [
      "cortex: Model context length exceeded. Start a new session.",
      "cortex",
      {
        code: -32603,
        message: "Internal error: Model context length exceeded. Start a new session.",
      },
      "context",
    ],
    [
      "cortex: The model provider is not available right now: it keeps reje",
      "cortex",
      {
        code: -32603,
        message:
          "Internal error: The model provider is not available right now: it keeps rejecting requests with 429 Too Many Requests.\\nTry again in a few minutes or switch to another model.",
      },
      "transient",
    ],
    [
      "cortex: The model provider is rate-limiting requests. Try again in a",
      "cortex",
      {
        code: -32603,
        message:
          "Internal error: The model provider is rate-limiting requests. Try again in a moment.",
      },
      "transient",
    ],
    [
      "cortex: The model provider is overloaded. Try again later.",
      "cortex",
      {
        code: -32603,
        message: "Internal error: The model provider is overloaded. Try again later.",
      },
      "transient",
    ],
    [
      "cortex: No active JetBrains AI subscription was found for this accou",
      "cortex",
      { code: -32000, message: "No active JetBrains AI subscription was found for this account." },
      "not_recoverable",
    ],
    [
      "cortex: All of your JetBrains AI licenses have expired. Renew a lice",
      "cortex",
      {
        code: -32000,
        message: "All of your JetBrains AI licenses have expired. Renew a license to continue.",
      },
      "not_recoverable",
    ],
    [
      "cortex: My account has run out of credits, so I cannot process reque",
      "cortex",
      {
        code: -32603,
        message:
          "Internal error: My account has run out of credits, so I cannot process requests right now. Please contact an administrator.",
      },
      "not_recoverable",
    ],
    [
      "cortex: I have reached my cost limit and cannot process requests unt",
      "cortex",
      {
        code: -32000,
        message:
          "I have reached my cost limit and cannot process requests until it is raised. Please contact an administrator.",
      },
      "not_recoverable",
    ],
    [
      "cortex: Daily limit exceeded. Usage limit resets in %d hour%s. API R",
      "cortex",
      {
        code: -32603,
        message:
          "Internal error: Daily limit exceeded. Usage limit resets in %d hour%s. API Response: %s",
      },
      "usage_limit",
    ],
    [
      "cortex: context window exceeded: %s",
      "cortex",
      { code: -32603, message: "Internal error: context window exceeded: %s" },
      "context",
    ],
    [
      "cortex: API request failed with status %d: %s",
      "cortex",
      { code: -32603, message: "Internal error: API request failed with status %d: %s" },
      "other",
    ],
    [
      "generic: status: RESOURCE_EXHAUSTED",
      "generic",
      { code: -32603, message: "Internal error: status: RESOURCE_EXHAUSTED" },
      "transient",
    ],
    [
      "generic: Rate limit reached for model gemma2-9b-it in organization ..",
      "generic",
      {
        code: -32603,
        message:
          "Internal error: Rate limit reached for model gemma2-9b-it in organization ... tokens per minute (TPM): Limit 15000, Used 11972, Requested 4351. Please try again in 5.289s.",
      },
      "transient",
    ],
  ])("%s", (_name, profile, error, want, reset) => {
    expectClass(classifyLimit(profile, error, NOW, {}), want, reset);
  });
});

describe("the turn's last message", () => {
  it.each<[string, AgentProfile, string, Want, number?]>([
    [
      "copilot: Error: 402 Payment Required",
      "copilot",
      "Error: 402 Payment Required",
      "usage_limit",
    ],
  ])("%s", (_name, profile, text, want, reset) => {
    expectClass(classifyTurnEnd(profile, text, "end_turn", NOW, 1), want, reset);
  });
});
