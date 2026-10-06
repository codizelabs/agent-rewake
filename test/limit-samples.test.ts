import { describe, expect, it } from "vitest";
import {
  type AgentProfile,
  classifyLimit,
  classifyTurnEnd,
  isSessionLost,
} from "../src/adapters/profiles.js";
import { parseDuration, parseResetHint } from "../src/adapters/reset.js";

// Messages as each agent sends them, from its source or from public reports. Times are local
// unless the text names a zone.
const NOW = new Date(2026, 9, 6, 14, 0, 0, 0).getTime(); // Tuesday 6 Oct 2026, 14:00 local
const MIN = 60_000;
const HOUR = 60 * MIN;
const local = (month: number, day: number, hour: number, minute = 0, year = 2026) =>
  new Date(year, month, day, hour, minute).getTime();

type Expected =
  | "usage_limit"
  | "transient"
  | "not_recoverable"
  | "session_lost"
  | "other"
  | "billing"
  | undefined;

/** "billing" is a not_recoverable that Rewake explains to the user. */
function kindOf(c: { kind: string; reason?: string } | undefined): Expected {
  if (!c) return undefined;
  return c.kind === "not_recoverable" && c.reason === "billing" ? "billing" : (c.kind as Expected);
}

const sdkError = (details: string) => ({
  code: -32603,
  message: "Internal error",
  data: { details },
});

describe("errors, agent by agent", () => {
  const cases: [
    string,
    AgentProfile,
    { code: number; message: string; data?: unknown },
    Expected,
  ][] = [
    // Codex: one error kind for the plan limit and for credits and spend caps.
    [
      "Codex Plus limit, with credits offered",
      "codex",
      {
        code: -32603,
        message: "Internal error",
        data: {
          codexErrorInfo: "usageLimitExceeded",
          message:
            "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:51 PM.",
        },
      },
      "usage_limit",
    ],
    [
      "Codex workspace out of credits",
      "codex",
      {
        code: -32603,
        message: "Internal error",
        data: {
          codexErrorInfo: "usageLimitExceeded",
          message: "Your workspace is out of credits. Add credits to continue.",
        },
      },
      "billing",
    ],
    [
      "Codex spend cap",
      "codex",
      {
        code: -32603,
        message: "Internal error",
        data: {
          codexErrorInfo: "usageLimitExceeded",
          message:
            "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
        },
      },
      "billing",
    ],
    [
      "Codex quota exceeded (API billing)",
      "codex",
      {
        code: -32603,
        message: "Internal error",
        data: {
          codexErrorInfo: "usageLimitExceeded",
          message: "Quota exceeded. Check your plan and billing details.",
        },
      },
      "billing",
    ],
    [
      "Codex free plan",
      "codex",
      {
        code: -32603,
        message: "Internal error",
        data: {
          codexErrorInfo: "usageLimitExceeded",
          message:
            "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        },
      },
      "billing",
    ],
    ["Codex lost session", "codex", sdkError("Session 019a-77 not found"), "session_lost"],
    // Gemini CLI and its forks: JSON-RPC code 429.
    [
      "Gemini, no quota on this tier",
      "gemini",
      {
        code: 429,
        message:
          "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0",
      },
      "not_recoverable",
    ],
    [
      "Gemini, no capacity",
      "gemini",
      { code: 429, message: "No capacity available for model gemini-3-pro on the server" },
      "transient",
    ],
    [
      "Gemini, per-minute with a short retry",
      "gemini",
      {
        code: 429,
        message:
          "You exceeded your current quota, please check your plan and billing details. Please retry in 44.09s.",
      },
      "transient",
    ],
    [
      "Gemini, daily quota with a short retry hint",
      "gemini",
      {
        code: 429,
        message:
          "You exceeded your current quota. Quota exceeded for quota metric 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'. Please retry in 34s.",
      },
      "usage_limit",
    ],
    [
      "Qwen quota with reset",
      "qwen",
      sdkError(
        "Quota exhausted: hour allocated quota exceeded. Please retry after the reset time, or switch to another API key.",
      ),
      "usage_limit",
    ],
    [
      "Qoder budget",
      "qoder",
      { code: 500, message: "Maximum budget exceeded for this account" },
      "billing",
    ],
    // Kimi and GLM put the text where the generic rules never looked.
    [
      "Kimi 5-hour limit",
      "kimi",
      {
        code: -32603,
        message: "Internal error",
        data: {
          error:
            "Error code: 403 - You've reached the 5-hour usage limit for your plan. Please try again later.",
        },
      },
      "usage_limit",
    ],
    [
      "Kimi lost session",
      "kimi",
      { code: -32603, message: "Internal error", data: { session_id: "Session not found" } },
      "session_lost",
    ],
    [
      "Z.AI 5-hour limit with spend limit",
      "glm",
      sdkError(
        "429 Usage limit reached for the past 5 hours. Extra usage is not available due to monthly spend limit. Resets at 2026-10-07 20:45:35.",
      ),
      "usage_limit",
    ],
    ["Z.AI short rate limit", "glm", sdkError("429 Rate limit reached for requests"), "transient"],
    [
      "Z.AI out of balance",
      "glm",
      sdkError("429 Insufficient balance or no resource package. Please recharge."),
      "billing",
    ],
    // Credit-based agents have no plan window.
    [
      "Auggie rate limit",
      "auggie",
      {
        code: -32603,
        message: "Internal error",
        data: { details: "Too many requests", apiStatus: "resourceExhausted" },
      },
      "transient",
    ],
    [
      "CodeBuddy credits spent",
      "codebuddy",
      {
        code: -32003,
        message: "Quota exceeded: credits used up",
        data: { code: 14001, category: "quota" },
      },
      "billing",
    ],
    // Multi-provider agents.
    [
      "OpenCode Go 5-hour limit with balance offer",
      "opencode",
      sdkError(
        "5-hour usage limit reached. Resets in 4hr 10min. To continue using this model now, enable usage from your available balance",
      ),
      "usage_limit",
    ],
    [
      "Kilo provider rate limit",
      "opencode",
      sdkError("Provider rate limit exceeded. Please try again shortly."),
      "transient",
    ],
    [
      "Kilo free model limit",
      "opencode",
      sdkError(
        "Free model usage limit reached. Please try again later or upgrade to a paid model.",
      ),
      "usage_limit",
    ],
    [
      "OpenCode context overflow",
      "opencode",
      {
        code: -32603,
        message: "Internal error",
        data: { errorName: "ContextOverflowError", details: "prompt is too long" },
      },
      "not_recoverable",
    ],
    [
      "Cline Clinepass 5-hour limit",
      "cline",
      {
        code: -32603,
        message: "Internal error",
        data: { message: "You have reached your 5-hour Clinepass limit. The limit resets in 5h" },
      },
      "usage_limit",
    ],
    [
      "Cline daily free limit",
      "cline",
      sdkError("Daily free limit reached on model x-ai/grok. Try again in 23h 59m"),
      "usage_limit",
    ],
    [
      "goose credits",
      "goose",
      {
        code: -32603,
        message: "Internal error",
        data: { details: "credits exhausted", reason: "credits_exhausted" },
      },
      "billing",
    ],
    [
      "goose lost session",
      "goose",
      { code: -32002, message: "Resource not found" },
      "session_lost",
    ],
    [
      "Mistral Vibe rate limit code",
      "vibe",
      { code: -31001, message: "Rate limit exceeded for mistral" },
      "usage_limit",
    ],
    [
      "Junie rate limit code",
      "junie",
      { code: -32011, message: "Rate limit", data: { reason: "rate_limit_exceeded" } },
      "transient",
    ],
    [
      "Junie balance code",
      "junie",
      {
        code: -32010,
        message: "Insufficient balance",
        data: { reason: "insufficient_account_balance" },
      },
      "billing",
    ],
    [
      "Devin monthly limit",
      "devin",
      {
        code: -32011,
        message: "Quota exhausted.",
        data: { "cognition.ai/errorKind": "resource_exhausted" },
      },
      "usage_limit",
    ],
    [
      "Devin short rate limit",
      "devin",
      {
        code: -32011,
        message: "Rate limited: slow down",
        data: {
          "cognition.ai/errorKind": "resource_exhausted",
          "cognition.ai/retryAfterSeconds": 30,
        },
      },
      "transient",
    ],
    [
      "Grok plan rate limit (curly apostrophe)",
      "grok",
      sdkError("You’ve hit the rate limit for your plan. Please wait and try again."),
      "transient",
    ],
    [
      "Grok free usage limit",
      "grok",
      sdkError("You’ve reached your free Grok Build usage limit."),
      "usage_limit",
    ],
    // Agents with structured categories, under the generic profile.
    [
      "Kimchi rate limit with a reopening time",
      "generic",
      {
        code: -32603,
        message: "Internal error: claude-opus is rate limited until 2026-10-06T17:00:00Z",
        data: { kind: "rate_limit", retryAtMs: NOW + 3 * HOUR },
      },
      "usage_limit",
    ],
    [
      "Kimchi budget",
      "generic",
      {
        code: -32603,
        message: "Internal error: budget exhausted",
        data: { kind: "budget_exhausted" },
      },
      "billing",
    ],
    [
      "Harn billing over 429",
      "generic",
      {
        code: -32000,
        message: "anthropic HTTP 429 [billing_limit]: credit balance is too low",
        data: { schema: "harn.acp.prompt_error.v1", terminalClass: "provider_billing" },
      },
      "billing",
    ],
    [
      "siGit Cloud monthly allowance",
      "generic",
      {
        code: -32603,
        message:
          "Monthly siGit Code Cloud allowance reached. It resets at the start of your next billing period.",
      },
      "usage_limit",
    ],
    [
      "Rust SDK error with the text as bare data",
      "generic",
      {
        code: -32603,
        message: "Internal error",
        data: "429 Too Many Requests: Rate limit reached for requests per min (RPM)",
      },
      "transient",
    ],
    [
      "Python SDK error with a 402",
      "generic",
      sdkError("Error code: 402 - insufficient credits"),
      "billing",
    ],
    ["unrelated failure", "generic", sdkError("ENOENT: no such file or directory"), "other"],
  ];

  it.each(cases)("%s", (_name, profile, error, expected) => {
    expect(kindOf(classifyLimit(profile, error, NOW))).toBe(expected);
  });
});

describe("provider errors passed through by multi-provider agents", () => {
  const cases: [string, string, Expected][] = [
    [
      "OpenAI per-minute",
      "429 Rate limit reached for gpt-4.1 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 202ms.",
      "transient",
    ],
    [
      "OpenAI billing",
      "429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
      "billing",
    ],
    [
      "Groq daily tokens, billing link in the advice",
      "429 Rate limit reached for model `llama-3.3-70b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 100000, Used 99000, Requested 2000. Please try again in 2h31m16.752s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing",
      "usage_limit",
    ],
    [
      "OpenRouter free models per day",
      "429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
      "usage_limit",
    ],
    [
      "Azure one-day limit",
      "Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-10-21 have exceeded call rate limit of your current OpenAI S0 pricing tier. Please retry after 86400 seconds.",
      "usage_limit",
    ],
    [
      "Anthropic overloaded",
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "transient",
    ],
    ["DeepSeek balance", "402 Insufficient Balance", "billing"],
  ];
  it.each(cases)("%s", (_name, text, expected) => {
    expect(kindOf(classifyLimit("generic", sdkError(text), NOW))).toBe(expected);
  });
});

describe("Claude", () => {
  const limit = (text: string, errorKind = "rate_limit") => ({
    code: -32603,
    message: `Internal error: ${text}`,
    data: { errorKind },
  });
  const cases: [string, string, Expected][] = [
    [
      "spend limit, then the session limit's reset",
      "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 7:50pm (Asia/Karachi)",
      "usage_limit",
    ],
    [
      "spend limit, then the Opus limit's reset",
      "You've hit your individual spend limit · ask your admin for a higher limit · your Opus limit resets Oct 9, 3pm (Asia/Karachi)",
      "usage_limit",
    ],
    [
      "usage-based account",
      "You've hit your usage limit · contact your admin to increase it",
      "billing",
    ],
    ["team budget", "You've hit your team's shared budget · ask your admin to raise it", "billing"],
    ["org disabled", "This service is disabled for your org", "billing"],
    [
      "1M context needs credits",
      "API Error: Usage credits required for 1M context · turn on usage credits at claude.ai/settings/usage, or use --model to switch to standard context",
      "billing",
    ],
    [
      "plain session limit",
      "You've hit your session limit · resets 11:20pm (Asia/Karachi)",
      "usage_limit",
    ],
    ["out of credits", "You're out of usage credits", "billing"],
    [
      "a gateway's daily spend limit with its reset",
      "API Error: 429 spend limit reached (daily; resets 2026-10-07 00:00 UTC)",
      "usage_limit",
    ],
    [
      "a short server-side throttle",
      "API Error: Server is temporarily limiting requests",
      "transient",
    ],
  ];
  it.each(cases)("%s", (_name, text, expected) => {
    expect(kindOf(classifyLimit("claude", limit(text), NOW))).toBe(expected);
  });

  it("follows Claude Code's own rule when the rate-limit event says the plan window resets", () => {
    const resetsAt = Math.floor((NOW + 2 * HOUR) / 1000);
    const c = classifyLimit("claude", limit("You're out of usage credits · resets 4pm"), NOW, {
      rateLimit: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
    });
    expect(c).toMatchObject({
      kind: "usage_limit",
      limitType: "session",
      resetAt: resetsAt * 1000,
    });
    // While overage is in use, Claude Code doesn't continue on its own, and neither does Rewake.
    const overage = classifyLimit(
      "claude",
      limit("You're out of usage credits · resets 4pm"),
      NOW,
      { rateLimit: { status: "rejected", resetsAt, isUsingOverage: true } },
    );
    expect(kindOf(overage)).toBe("billing");
  });

  it("recognises the ways claude-agent-acp says the session is gone", () => {
    expect(
      kindOf(
        classifyLimit(
          "claude",
          limit("The Claude Agent session has ended. Please start a new session.", "x"),
          NOW,
        ),
      ),
    ).toBe("session_lost");
    expect(kindOf(classifyLimit("claude", limit("", "transport_lost"), NOW))).toBe("session_lost");
  });
});

describe("limits reported as the turn's last message", () => {
  const cases: [string, AgentProfile, string, string, Expected][] = [
    [
      "Cursor upgrade line",
      "cursor",
      "\n\nUpgrade your plan to continue",
      "end_turn",
      "usage_limit",
    ],
    [
      "Cursor payment line",
      "cursor",
      "\n\nAdd a payment method to continue",
      "end_turn",
      "billing",
    ],
    [
      "Cursor high demand",
      "cursor",
      "\n\nError: RetriableError: We're experiencing high demand for the selected model right now. Please upgrade to Pro, switch to Auto, another model, or try again in a few moments.",
      "end_turn",
      undefined,
    ],
    [
      "Copilot session rate limit",
      "copilot",
      "Error: You've hit your session rate limit. Please wait for your limit to reset in 3 hours. (Request ID: 1A2B:3C4D)",
      "end_turn",
      "usage_limit",
    ],
    [
      "Copilot short model rate limit",
      "copilot",
      "Error: You've hit the rate limit for this model. Please wait for your limit to reset in under a minute.",
      "end_turn",
      undefined,
    ],
    [
      "Amp free usage",
      "amp",
      "Error: You've reached your free usage limit. Add credits to keep using Amp right now, or wait until the next hour starts for more free usage.",
      "end_turn",
      "usage_limit",
    ],
    [
      "Amp out of credits",
      "amp",
      'Error: {"error":{"code":402,"message":"Out of credits"}}',
      "end_turn",
      "billing",
    ],
    [
      "Droid weekly limit inside a 402",
      "droid",
      'Error: 402 {"detail":"You\'ve reached your weekly Droid Core usage limit (resets in 5 days).\\nReload Extra Usage credits or wait for your limits to reset.","status":402,"title":"Payment Required","displayToUser":true}',
      "error",
      "usage_limit",
    ],
    [
      "Droid credit limit",
      "droid",
      'Error: 402 {"detail":"Credit limit reached.","status":402,"displayToUser":true}',
      "error",
      "billing",
    ],
    [
      "Antigravity quota",
      "antigravity",
      "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 4 days, 23 hours.",
      "end_turn",
      "usage_limit",
    ],
    [
      "goose daily tokens",
      "goose",
      "Ran into this error: Rate limit exceeded: Rate limit reached for model in organization on tokens per day (TPD).",
      "end_turn",
      "usage_limit",
    ],
    [
      "fast-agent usage limit with an epoch reset",
      "fast-agent",
      "I hit an internal error while calling the model: {'type': 'usage_limit_reached', 'resets_at': 1791313200}",
      "refusal",
      "usage_limit",
    ],
    [
      "Cortex daily credit limit",
      "cortex",
      "Daily credit usage limit reached. Your estimated usage has exceeded the configured limit for this surface. Please try again later or contact your account administrator to adjust your limit.",
      "end_turn",
      "usage_limit",
    ],
    [
      "Cursor's line written by the model",
      "cursor",
      "Upgrade your plan to continue",
      "end_turn",
      undefined,
    ],
    // The model's own words never count: a template must start the turn's last message.
    [
      "prose that quotes a limit",
      "copilot",
      "I looked into it. The log says: Error: You've hit your session rate limit.",
      "end_turn",
      undefined,
    ],
    [
      "the right text from an agent without templates",
      "generic",
      "Error: usage limit reached",
      "end_turn",
      undefined,
    ],
  ];
  it.each(cases)("%s", (_name, profile, text, stopReason, expected) => {
    expect(kindOf(classifyTurnEnd(profile, text, stopReason, NOW))).toBe(expected);
  });

  it("reads the reset time from the message", () => {
    const amp = classifyTurnEnd(
      "amp",
      "Error: You've reached your free usage limit. Add credits to keep using Amp right now, or wait until the next hour starts for more free usage.",
      "end_turn",
      NOW + 20 * MIN,
    );
    expect(amp).toMatchObject({ kind: "usage_limit", resetAt: NOW + HOUR });
    const fast = classifyTurnEnd(
      "fast-agent",
      "I hit an internal error while calling the model: {'type': 'usage_limit_reached', 'resets_at': 1791313200}",
      "refusal",
      NOW,
    );
    expect(fast).toMatchObject({ resetAt: 1791313200 * 1000 });
  });
});

describe("a lost session, in any agent's words", () => {
  it.each([
    sdkError("Session not found"),
    { code: -32603, message: "Internal error", data: { details: "Session not found" } },
    { code: -32602, message: "Session 9f2e not found" },
    { code: -32002, message: "Resource not found: Session 9f2e not found" },
    sdkError("Session not found: s-1"),
    { code: -32602, message: "Invalid params", data: { reason: "unknown_session" } },
  ])("%j", (error) => {
    expect(isSessionLost(error)).toBe(true);
  });

  it("isn't triggered by other errors", () => {
    expect(isSessionLost(sdkError("Tool failed: ENOENT"))).toBe(false);
  });
});

describe("reset times", () => {
  const cases: [string, number | undefined][] = [
    ["try again at 2:51 PM.", local(9, 6, 14, 51)],
    ["Try again at Sep 15th, 2027 9:25 AM.", local(8, 15, 9, 25, 2027)],
    ["try again at Oct 20, 2026, 7:38 AM", local(9, 20, 7, 38)],
    ["try again at 20 Oct 2026, 16:29", local(9, 20, 16, 29)],
    ["Please wait for your limit to reset on October 7, 2026 at 3:47 PM.", local(9, 7, 15, 47)],
    ["Your limit will reset on Oct 7, 2026 14:05 UTC.", Date.UTC(2026, 9, 7, 14, 5)],
    ["Your limit will reset in 4 days, 23 hours.", NOW + 4 * 24 * HOUR + 23 * HOUR],
    ["You've reached your weekly Droid Core usage limit (resets in 5 days).", NOW + 5 * 24 * HOUR],
    ["standard usage limit (resets in 1h 0min).", NOW + HOUR],
    ["Resets in 4hr 10min.", NOW + 4 * HOUR + 10 * MIN],
    ["Please wait 1 hours 48 minutes for your limit to reset", NOW + HOUR + 48 * MIN],
    ["Please try again in 202ms.", NOW + 202],
    ["please try again after 1 seconds", NOW + 1000],
    ["Please retry after 86400 seconds.", NOW + 24 * HOUR],
    ["quota will reset after 2h3m4s.", NOW + 2 * HOUR + 3 * MIN + 4000],
    ["It will reset at 2026-10-07 16:11:46 +0800 CST", Date.UTC(2026, 9, 7, 8, 11, 46)],
    ["You will regain access on 2026-11-01 at 00:00 UTC.", Date.UTC(2026, 10, 1)],
    ["Please retry after the reset at 10-07 09:25:00 UTC", Date.UTC(2026, 9, 7, 9, 25)],
    ["resets Jan 2, 2027, 3pm (UTC)", Date.UTC(2027, 0, 2, 15)],
    ["Try again later.", undefined],
    ["try again in a few moments", undefined],
    ["Released on 2026-10-01 12:00, quota exceeded", undefined],
  ];
  it.each(cases)("%s", (text, expected) => {
    expect(parseResetHint(text, NOW)).toBe(expected);
  });

  it("uses the vendor's zone when the text gives none", () => {
    expect(
      parseResetHint("Your limit will reset at 2026-10-07 20:45:35", NOW, {
        zone: "Asia/Shanghai",
      }),
    ).toBe(Date.UTC(2026, 9, 7, 12, 45, 35));
    expect(
      parseResetHint("Please wait for your limit to reset on October 7, 2026 at 3:47 PM.", NOW, {
        zone: "UTC",
      }),
    ).toBe(Date.UTC(2026, 9, 7, 15, 47));
  });

  it("reads durations in every form agents print", () => {
    expect(parseDuration("1d 2h 3m")).toBe(26 * HOUR + 3 * MIN);
    expect(parseDuration("119h36m35.4s")).toBe(119 * HOUR + 36 * MIN + 35_400);
    expect(parseDuration("2 hours, 15 minutes")).toBe(2 * HOUR + 15 * MIN);
    expect(parseDuration("soon")).toBeUndefined();
  });
});

describe("found in review", () => {
  it("doesn't stall on a huge error", () => {
    const text = `You've hit your session limit. Please retry in 5h${" ".repeat(100_000)}x 5m`;
    const start = Date.now();
    classifyLimit(
      "claude",
      { code: -32603, message: `Internal error: ${text}`, data: { errorKind: "rate_limit" } },
      NOW,
    );
    parseResetHint(`retry in ${"1 ".repeat(50_000)}`, NOW);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("Claude: the plan's reset wins over a team budget", () => {
    const c = classifyLimit(
      "claude",
      {
        code: -32603,
        message:
          "Internal error: You've hit your team's shared budget · ask your admin to raise it at claude.ai/admin-settings/usage · your session limit resets 7:50pm (Asia/Karachi)",
        data: { errorKind: "rate_limit" },
      },
      NOW,
    );
    expect(c.kind).toBe("usage_limit");
  });

  it("reads a bare UTC after a reset time", () => {
    expect(parseResetHint("spend limit reached (daily; resets 00:00 UTC)", NOW)).toBe(
      Date.UTC(2026, 9, new Date(NOW).getUTCDate() + 1, 0, 0),
    );
  });

  it("reads 'resets 4hr 10min' as a duration, not 4 o'clock", () => {
    expect(parseResetHint("resets 4hr 10min", NOW)).toBe(NOW + 4 * HOUR + 10 * MIN);
  });

  it("skips a timestamp that has passed, and a date that isn't the reset", () => {
    expect(
      parseResetHint(
        "Rate limit exceeded. Timestamp: 2026-10-01 08:59:00. Try again in 2 hours",
        NOW,
      ),
    ).toBe(NOW + 2 * HOUR);
    expect(parseResetHint("Key valid until 2026-12-31 00:00 UTC. Try again in 5 hours.", NOW)).toBe(
      NOW + 5 * HOUR,
    );
  });

  it("doesn't take the model's own 'Error:' line for the agent's", () => {
    expect(
      classifyTurnEnd(
        "copilot",
        "Error: the GitHub API returned 429 Too Many Requests because your script exceeds the secondary rate limit. Add a backoff.",
        "end_turn",
        NOW,
      ),
    ).toBeUndefined();
    expect(
      classifyTurnEnd(
        "amp",
        "Error: handling this, the quota for the S3 bucket was exceeded in the test; I fixed it.",
        "end_turn",
        NOW,
      ),
    ).toBeUndefined();
    // amp-acp writes its error in one update; a streamed reply comes in many.
    expect(
      classifyTurnEnd(
        "amp",
        "Error: You've reached your free usage limit. Add credits to keep using Amp right now, or wait until the next hour starts for more free usage.",
        "end_turn",
        NOW,
        7,
      ),
    ).toBeUndefined();
  });
});
