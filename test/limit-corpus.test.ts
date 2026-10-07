import { describe, expect, it } from "vitest";
import {
  type AgentProfile,
  classifyLimit,
  classifyTurnEnd,
  type LimitClassification,
  type TurnContext,
} from "../src/adapters/profiles.js";

// Messages as each agent and provider sends them, from their source or public reports.
const NOW = new Date(2026, 9, 6, 14, 0, 0, 0).getTime(); // Tuesday 6 Oct 2026, 14:00 local
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const local = (y: number, m: number, d: number, h: number, mi = 0) =>
  new Date(y, m, d, h, mi).getTime();
const utc = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, m, d, h, mi, s);
/** The first time after NOW that a UTC clock reads h:mi (a dateless time in a fixed zone). */
const nextUtc = (h: number, mi = 0) => {
  const n = new Date(NOW);
  const t = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), h, mi);
  return t > NOW ? t : t + DAY;
};

type RpcError = { code: number; message: string; data?: unknown };
/** "billing", "context" and "auth" are not_recoverable with that reason; "none" means no action. */
type Want =
  | "usage_limit"
  | "transient"
  | "not_recoverable"
  | "billing"
  | "context"
  | "auth"
  | "session_lost"
  | "other"
  | "none";
/** A number is the reset time, null means no reset time, undefined leaves it unchecked. */
type Reset = number | null | undefined;
type ErrorCase = [string, AgentProfile, RpcError, Want, Reset?, TurnContext?];
type TurnEndCase = [string, AgentProfile, string, string, Want, Reset?, number?];

function expectClass(c: LimitClassification | undefined, want: Want, reset?: Reset) {
  if (want === "none") {
    expect(c).toBeUndefined();
    return;
  }
  expect(c).toBeDefined();
  if (!c) return;
  if (want === "billing" || want === "context" || want === "auth") {
    expect({ kind: c.kind, reason: "reason" in c ? c.reason : undefined }).toEqual({
      kind: "not_recoverable",
      reason: want,
    });
  } else {
    expect(c.kind).toBe(want);
  }
  if (reset === null) expect(c.resetAt).toBeUndefined();
  else if (reset !== undefined) expect(c.resetAt).toBe(reset);
}

const runErrors = (cases: ErrorCase[]) =>
  it.each(cases)("%s", (_name, profile, error, want, reset, context) => {
    expectClass(classifyLimit(profile, error, NOW, context ?? {}), want, reset);
  });

const runTurnEnds = (cases: TurnEndCase[]) =>
  it.each(cases)("%s", (_name, profile, text, stopReason, want, reset, chunks) => {
    expectClass(classifyTurnEnd(profile, text, stopReason, NOW, chunks ?? 1), want, reset);
  });

const rpc = (code: number, message: string, data?: unknown): RpcError =>
  data === undefined ? { code, message } : { code, message, data };
const details = (text: string) => rpc(-32603, "Internal error", { details: text });

describe("Claude Code", () => {
  const claude = (text: string, errorKind?: string) =>
    rpc(-32603, `Internal error: ${text}`, errorKind === undefined ? undefined : { errorKind });
  const limit = (text: string) => claude(text, "rate_limit");
  const KARACHI_1950 = nextUtc(14, 50); // 7:50pm in Asia/Karachi
  const KARACHI_OCT9_3PM = utc(2026, 9, 9, 10);

  describe("plan limits", () => {
    runErrors([
      [
        "Claude: session limit",
        "claude",
        limit("You've hit your session limit · resets 7:50pm (Asia/Karachi)"),
        "usage_limit",
        KARACHI_1950,
      ],
      [
        "Claude: session limit, progress saved",
        "claude",
        limit("You've hit your session limit · resets 10:40pm (Asia/Tokyo) · progress saved"),
        "usage_limit",
        nextUtc(13, 40),
      ],
      [
        "Claude: weekly limit, date without a zone",
        "claude",
        limit("You've hit your weekly limit · resets Sep 15 at 7pm"),
        "usage_limit",
        local(2027, 8, 15, 19),
      ],
      [
        "Claude: weekly limit, date in UTC",
        "claude",
        limit("You've hit your weekly limit · resets Jul 31, 2am (UTC)"),
        "usage_limit",
        utc(2027, 6, 31, 2),
      ],
      [
        "Claude: weekly limit, time in Madrid",
        "claude",
        limit("You've hit your weekly limit · resets 4am (Europe/Madrid)"),
        "usage_limit",
        nextUtc(2),
      ],
      [
        "Claude: weekly limit, date and zone",
        "claude",
        limit("You've hit your weekly limit · resets Oct 9, 3pm (Asia/Karachi)"),
        "usage_limit",
        KARACHI_OCT9_3PM,
      ],
      [
        "Claude: weekly limit, date with a year",
        "claude",
        limit("You've hit your weekly limit · resets Jan 2, 2027, 3pm (Asia/Karachi)"),
        "usage_limit",
        utc(2027, 0, 2, 10),
      ],
      [
        "Claude: Opus limit",
        "claude",
        limit("You've hit your Opus limit · resets Oct 9, 3pm (Asia/Karachi)"),
        "usage_limit",
        KARACHI_OCT9_3PM,
      ],
      [
        "Claude: Sonnet limit",
        "claude",
        limit("You've hit your Sonnet limit · resets 7:50pm (Asia/Karachi)"),
        "usage_limit",
        KARACHI_1950,
      ],
      [
        "Claude: Fable limit",
        "claude",
        limit("You've hit your Fable limit · resets 7:50pm (Asia/Karachi)"),
        "usage_limit",
        KARACHI_1950,
      ],
      [
        "Claude: plain limit",
        "claude",
        limit("You've hit your limit · resets 7:50pm (Asia/Karachi)"),
        "usage_limit",
        KARACHI_1950,
      ],
      [
        "Claude: usage limit with reset",
        "claude",
        limit("You've hit your usage limit · resets 7:50pm (Asia/Karachi)"),
        "usage_limit",
        KARACHI_1950,
      ],
      [
        "Claude: usage limit, contact admin",
        "claude",
        limit("You've hit your usage limit · contact your admin to increase it"),
        "not_recoverable",
      ],
      [
        "Claude: usage limit without reset",
        "claude",
        limit("You've hit your usage limit"),
        "not_recoverable",
      ],
      [
        "Claude: session limit, as seen live",
        "claude",
        limit("You've hit your session limit · resets 11:20pm (Asia/Karachi)"),
        "usage_limit",
        nextUtc(18, 20),
      ],
      [
        "Claude: spend limit with a session reset after midnight",
        "claude",
        limit(
          "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 1:30am (Asia/Karachi)",
        ),
        "usage_limit",
        nextUtc(20, 30),
      ],
    ]);
  });

  describe("spend limits and credits", () => {
    runErrors([
      [
        "Claude: individual spend limit with a session reset",
        "claude",
        limit(
          "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 7:50pm (Asia/Karachi)",
        ),
        "usage_limit",
        KARACHI_1950,
      ],
      [
        "Claude: org spend limit with a session reset",
        "claude",
        limit(
          "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 4:20pm (America/Chicago)",
        ),
        "usage_limit",
        nextUtc(21, 20),
      ],
      [
        "Claude: org spend limit",
        "claude",
        limit(
          "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit",
        ),
        "not_recoverable",
      ],
      [
        "Claude: monthly spend limit",
        "claude",
        limit(
          "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
        ),
        "not_recoverable",
      ],
      [
        "Claude: monthly spend limit with a weekly reset",
        "claude",
        limit(
          "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets Oct 9, 3pm (Asia/Karachi)",
        ),
        "usage_limit",
        KARACHI_OCT9_3PM,
      ],
      [
        "Claude: monthly spend limit with an Opus reset",
        "claude",
        limit(
          "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your Opus limit resets 7:50pm (Asia/Karachi)",
        ),
        "usage_limit",
        KARACHI_1950,
      ],
      [
        "Claude: org spend limit, ask admin",
        "claude",
        limit(
          "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage",
        ),
        "not_recoverable",
      ],
      [
        "Claude: org spend limit with a Sonnet reset",
        "claude",
        limit(
          "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage · your Sonnet limit resets 7:50pm (Asia/Karachi)",
        ),
        "usage_limit",
        KARACHI_1950,
      ],
      [
        "Claude: channel spend limit",
        "claude",
        limit(
          "You've hit your channel's monthly spend limit · an org owner or channel manager can raise it in the channel's Claude settings",
        ),
        "not_recoverable",
      ],
      [
        "Claude: channel spend limit with a session reset",
        "claude",
        limit(
          "You've hit your channel's monthly spend limit · an org owner or channel manager can raise it in the channel's Claude settings · your session limit resets 7:50pm (Asia/Karachi)",
        ),
        "usage_limit",
        KARACHI_1950,
      ],
      [
        "Claude: team budget",
        "claude",
        limit("You've hit your team's shared budget · raise it at claude.ai/admin-settings/usage"),
        "not_recoverable",
      ],
      [
        "Claude: team budget, ask admin",
        "claude",
        limit(
          "You've hit your team's shared budget · ask your admin to raise it at claude.ai/admin-settings/usage",
        ),
        "not_recoverable",
      ],
      [
        "Claude: team budget with a session reset",
        "claude",
        limit(
          "You've hit your team's shared budget · ask your admin to raise it at claude.ai/admin-settings/usage · your session limit resets 7:50pm (Asia/Karachi)",
        ),
        "usage_limit",
        KARACHI_1950,
      ],
      [
        "Claude: individual monthly usage limit",
        "claude",
        limit("You've hit your individual usage limit · resets Nov 1, 12am (Asia/Karachi)"),
        "not_recoverable",
      ],
      [
        "Claude: org monthly usage limit with reset",
        "claude",
        limit("You've hit your org's monthly usage limit · resets Nov 1, 12am (Asia/Karachi)"),
        "not_recoverable",
      ],
      [
        "Claude: org monthly usage limit",
        "claude",
        limit("You've hit your org's monthly usage limit"),
        "not_recoverable",
      ],
      [
        "Claude: channel monthly usage limit",
        "claude",
        limit(
          "You've hit your channel's monthly usage limit · an org owner can raise it · resets Nov 1, 12am (Asia/Karachi)",
        ),
        "not_recoverable",
      ],
      [
        "Claude: org out of usage, add funds",
        "claude",
        limit("Your org is out of usage · add funds to continue"),
        "not_recoverable",
      ],
      [
        "Claude: org out of usage, contact admin",
        "claude",
        limit("Your org is out of usage · contact your admin"),
        "not_recoverable",
      ],
      [
        "Claude: seat without usage credits",
        "claude",
        limit("Your seat type doesn't include usage credits"),
        "not_recoverable",
      ],
      [
        "Claude: seat without usage",
        "claude",
        limit("Your seat type doesn't include usage"),
        "not_recoverable",
      ],
      [
        "Claude: usage allocation disabled",
        "claude",
        limit(
          "Your usage allocation has been disabled by your admin · run /usage-credits to ask your admin for a higher limit",
        ),
        "not_recoverable",
      ],
      [
        "Claude: group limit set to zero",
        "claude",
        limit("Your group's usage limit is set to $0 · ask your admin for a higher limit"),
        "not_recoverable",
      ],
      [
        "Claude: service disabled for org",
        "claude",
        limit("This service is disabled for your org"),
        "not_recoverable",
      ],
      [
        "Claude: out of extra usage",
        "claude",
        limit("You're out of extra usage"),
        "not_recoverable",
      ],
      [
        "Claude: seat without extra usage",
        "claude",
        limit("Your seat type doesn't include extra usage"),
        "not_recoverable",
      ],
      [
        "Claude: out of extra usage, API error",
        "claude",
        claude(
          `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}}`,
          "unknown",
        ),
        "not_recoverable",
      ],
    ]);
  });

  describe("with the turn's rate-limit event", () => {
    runErrors([
      [
        "Claude: out of credits, five-hour window rejected",
        "claude",
        limit("You're out of usage credits · resets 7:50pm (Asia/Karachi)"),
        "usage_limit",
        KARACHI_1950,
        {
          rateLimit: {
            status: "rejected",
            resetsAt: KARACHI_1950 / 1000,
            rateLimitType: "five_hour",
          },
        },
      ],
      [
        "Claude: out of credits while on overage",
        "claude",
        limit("You're out of usage credits · resets 7:50pm (Asia/Karachi)"),
        "not_recoverable",
        undefined,
        {
          rateLimit: { status: "rejected", resetsAt: KARACHI_1950 / 1000, isUsingOverage: true },
        },
      ],
      [
        "Claude: bare rate_limit with a rejected window",
        "claude",
        rpc(-32603, "Internal error", { errorKind: "rate_limit" }),
        "usage_limit",
        local(2026, 9, 6, 17),
        {
          rateLimit: {
            status: "rejected",
            resetsAt: local(2026, 9, 6, 17) / 1000,
            rateLimitType: "five_hour",
          },
        },
      ],
    ]);
  });

  describe("model limits", () => {
    runErrors([
      [
        "Claude: Fable limit, switch model",
        "claude",
        limit("You've reached your Fable limit. Switch to another model to continue."),
        "usage_limit",
      ],
      [
        "Claude: Fable limit, switch model or manage credits",
        "claude",
        limit(
          "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage, to continue.",
        ),
        "usage_limit",
      ],
      [
        "Claude: model requires credits",
        "claude",
        limit("Fable 5 requires usage credits. Switch to another model to continue."),
        "not_recoverable",
      ],
      [
        "Claude: out of credits, switch model",
        "claude",
        limit("You're out of usage credits. Switch to another model to continue."),
        "not_recoverable",
      ],
      [
        "Claude: monthly spend limit, switch model",
        "claude",
        limit("You've hit your monthly spend limit. Switch to another model to continue."),
        "not_recoverable",
      ],
      [
        "Claude: channel spend limit, switch model",
        "claude",
        limit(
          "You've hit your channel's monthly spend limit. Switch to another model to continue.",
        ),
        "not_recoverable",
      ],
      [
        "Claude: team budget, switch model",
        "claude",
        limit("You've hit your team's shared budget. Switch to another model to continue."),
        "not_recoverable",
      ],
      [
        "Claude: out of credits, keep using Fable",
        "claude",
        limit(
          "You're out of usage credits. Run /usage-credits to keep using Fable or /model to switch models.",
        ),
        "not_recoverable",
      ],
      [
        "Claude: team budget, /model",
        "claude",
        limit("You've hit your team's shared budget. /model to switch models."),
        "not_recoverable",
      ],
      [
        "Claude: 1M context needs credits",
        "claude",
        limit(
          "API Error: Usage credits required for 1M context · turn on usage credits at claude.ai/settings/usage, or use --model to switch to standard context",
        ),
        "not_recoverable",
      ],
      [
        "Claude: 1M context needs credits, run /usage-credits",
        "claude",
        limit(
          "API Error: Usage credits required for 1M context · run /usage-credits to turn them on (or use --model to switch to standard context)",
        ),
        "not_recoverable",
      ],
    ]);
  });

  describe("passing errors", () => {
    runErrors([
      [
        "Claude: server limiting requests",
        "claude",
        limit(
          "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
        ),
        "transient",
      ],
      [
        "Claude: account rate limit (429)",
        "claude",
        limit(
          "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
        ),
        "transient",
      ],
      [
        "Claude: Opus under high load",
        "claude",
        limit("Opus is experiencing high load, please use /model to switch to Sonnet"),
        "transient",
      ],
      [
        "Claude: Fable under high load",
        "claude",
        limit("Fable is experiencing high load, please use /model to switch to Sonnet"),
        "transient",
      ],
      [
        "Claude: repeated 529 overloaded",
        "claude",
        claude(
          "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. If it persists, check https://status.claude.com.",
          "server_error",
        ),
        "transient",
      ],
      [
        "Claude: internal server error",
        "claude",
        claude(
          "API Error: Internal server error. This is a server-side issue, usually temporary — try again in a moment.",
          "server_error",
        ),
        "transient",
      ],
      [
        "Claude: request timed out",
        "claude",
        claude("Request timed out", "server_error"),
        "transient",
      ],
      [
        "Claude: connection lost",
        "claude",
        claude(
          "API Error: Connection to the API was lost (ECONNRESET). This is usually temporary — try again.",
          "server_error",
        ),
        "transient",
      ],
      ["Claude: no response requested", "claude", limit("No response requested."), "transient"],
      [
        "Claude: Bedrock throttling",
        "claude",
        limit("API Error: Request rejected (429) · ThrottlingException"),
        "transient",
      ],
      [
        "Claude: gateway daily spend limit, resets tonight",
        "claude",
        limit(
          "spend limit reached (daily; resets 2026-10-07 00:00 UTC) — request an increase at https://go.corp.example.com/claude-limits",
        ),
        "usage_limit",
        utc(2026, 9, 7, 0),
      ],
      [
        "Claude: gateway weekly spend limit, days away",
        "claude",
        limit(
          "spend limit reached (weekly; resets 2026-10-12 00:00 UTC) — request an increase at https://go.corp.example.com/claude-limits",
        ),
        "not_recoverable",
      ],
    ]);
  });

  describe("account, request and session errors", () => {
    runErrors([
      [
        "Claude: credit balance too low",
        "claude",
        claude("Credit balance is too low", "billing_error"),
        "not_recoverable",
      ],
      [
        "Claude: API usage limits until a date",
        "claude",
        claude(
          `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2025-12-01 at 00:00 UTC."}}`,
          "unknown",
        ),
        "not_recoverable",
      ],
      [
        "Claude: invalid API key",
        "claude",
        claude("Please run /login · API Error: 401 invalid x-api-key", "authentication_failed"),
        "not_recoverable",
      ],
      [
        "Claude: failed to authenticate",
        "claude",
        claude("Failed to authenticate. API Error: 401", "authentication_failed"),
        "not_recoverable",
      ],
      [
        "Claude: login expired",
        "claude",
        claude("Login expired · Please run /login", "authentication_failed"),
        "not_recoverable",
      ],
      [
        "Claude: external key invalid",
        "claude",
        claude("Invalid API key · Fix external API key", "authentication_failed"),
        "not_recoverable",
      ],
      [
        "Claude: authentication required",
        "claude",
        rpc(-32000, "Authentication required"),
        "not_recoverable",
      ],
      [
        "Claude: no access to Claude",
        "claude",
        claude(
          "Your account does not have access to Claude. Please login again or contact your administrator.",
          "authentication_failed",
        ),
        "not_recoverable",
      ],
      [
        "Claude: org disabled subscription access",
        "claude",
        claude(
          "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
          "oauth_org_not_allowed",
        ),
        "not_recoverable",
      ],
      [
        "Claude: account on hold",
        "claude",
        claude(
          "Your account is on hold and can't sign in to Claude Code. View details or appeal: https://claude.ai/x",
          "account_on_hold",
        ),
        "not_recoverable",
      ],
      [
        "Claude: organization verification",
        "claude",
        claude("API Error: Organization verification required", "verification_required"),
        "not_recoverable",
      ],
      [
        "Claude: AWS credentials missing",
        "claude",
        claude(
          "API Error: Could not load AWS credentials · no profile. Check or refresh your AWS credentials and try again.",
          "cloud_credential_error",
        ),
        "not_recoverable",
      ],
      [
        "Claude: AWS credentials expired",
        "claude",
        claude("AWS credentials expired or invalid", "authentication_failed"),
        "not_recoverable",
      ],
      [
        "Claude: key from a disabled org",
        "claude",
        claude("Your ANTHROPIC_API_KEY belongs to a disabled organization · x", "invalid_request"),
        "not_recoverable",
      ],
      [
        "Claude: model not in plan",
        "claude",
        claude("Claude Opus is not available with the Claude Pro plan.", "invalid_request"),
        "not_recoverable",
      ],
      [
        "Claude: model issue",
        "claude",
        claude("There's an issue with the selected model (foo).", "model_not_found"),
        "not_recoverable",
      ],
      [
        "Claude: prompt too long",
        "claude",
        claude("Prompt is too long", "invalid_request"),
        "context",
      ],
      [
        "Claude: request too large",
        "claude",
        claude("Request too large (max 32MB). Try a smaller file.", "invalid_request"),
        "context",
      ],
      ["Claude: max turns", "claude", claude("error_max_turns"), "other"],
      ["Claude: max budget", "claude", claude("error_max_budget_usd"), "not_recoverable"],
      ["Claude: session not found", "claude", details("Session not found"), "session_lost"],
      [
        "Claude: session ended",
        "claude",
        claude("The Claude Agent session has ended. Please start a new session."),
        "session_lost",
      ],
      [
        "Claude: process exited",
        "claude",
        claude("The Claude Agent process exited unexpectedly. Please start a new session."),
        "session_lost",
      ],
      [
        "Claude: transport lost",
        "claude",
        rpc(-32603, "Internal error", { errorKind: "transport_lost" }),
        "session_lost",
      ],
      [
        "Claude: worker shut down",
        "claude",
        rpc(-32603, "Internal error", { errorKind: "worker_shutdown" }),
        "session_lost",
      ],
    ]);
  });
});

describe("provider APIs, through a generic agent", () => {
  const api = (name: string, text: string, want: Want, reset?: Reset): ErrorCase => [
    name,
    "generic",
    details(text),
    want,
    reset,
  ];

  describe("Anthropic", () => {
    runErrors([
      api(
        "Anthropic: tokens per minute",
        "This request would exceed your organization's rate limit of 50,000 input tokens per minute (org: x, model: claude-haiku-4-5-20251001). For details, refer to: https://docs.claude.com/en/api/rate-limits. You can see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later.",
        "transient",
      ),
      api(
        "Anthropic: account rate limit",
        "This request would exceed your account's rate limit. Please try again later.",
        "transient",
      ),
      api(
        "Anthropic: specified API usage limits",
        "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
        "usage_limit",
        utc(2026, 10, 1),
      ),
      api(
        "Anthropic: credit balance too low",
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
        "not_recoverable",
      ),
      api("Anthropic: overloaded", "Overloaded", "transient"),
      api(
        "Anthropic: overloaded, SDK form",
        `529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}`,
        "transient",
      ),
      api(
        "Anthropic: prompt too long",
        "prompt is too long: 2326643 tokens > 1000000 maximum",
        "context",
      ),
      api(
        "Anthropic: 429, SDK form",
        `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."},"request_id":"req_1"}`,
        "transient",
      ),
      api(
        "Anthropic: rate limit through LiteLLM",
        `litellm.RateLimitError: AnthropicException - b'{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\\'s rate limit of 50,000 input tokens per minute"}}'`,
        "transient",
      ),
    ]);
  });

  describe("OpenAI and Azure OpenAI", () => {
    runErrors([
      api(
        "OpenAI: tokens per minute",
        "Rate limit reached for gpt-4.1-mini in organization org-x on tokens per min (TPM): Limit 200000, Used 198469, Requested 7607. Please try again in 1.822s. Visit https://platform.openai.com/account/rate-limits to learn more.",
        "transient",
      ),
      api(
        "OpenAI: tokens per minute, retry in ms",
        "Rate limit reached for gpt-4.1-mini in organization org-x on tokens per min (TPM): Limit 200000, Used 198469, Requested 7607. Please try again in 202ms. Visit https://platform.openai.com/account/rate-limits to learn more.",
        "transient",
      ),
      api(
        "OpenAI: requests per day",
        "Rate limit reached for gpt-4o-mini in organization org-batchgpt on requests per day (RPD): Limit 10000, Used 10000, Requested 1. Please try again in 8.64s. Visit https://platform.openai.com/account/rate-limits to learn more.",
        "usage_limit",
      ),
      api(
        "OpenAI: realtime requests per day",
        "Rate limit reached for gpt-realtime (for limit gpt-4o-realtime) in organization org-x on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 1m26.4s.",
        "usage_limit",
      ),
      api(
        "OpenAI: quota exceeded",
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
        "not_recoverable",
      ),
      api(
        "OpenAI: quota exceeded, Node SDK",
        "Error: 429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
        "not_recoverable",
      ),
      api(
        "OpenAI: quota exceeded, AI SDK retries",
        "Failed after 3 attempts. Last error: You exceeded your current quota, please check your plan and billing details.",
        "not_recoverable",
      ),
      api(
        "OpenAI: quota exceeded, Python SDK",
        `Error code: 429 - {'error': {'message': 'You exceeded your current quota, please check your plan and billing details.', 'type': 'insufficient_quota', 'param': None, 'code': 'insufficient_quota'}}`,
        "not_recoverable",
      ),
      api(
        "OpenAI: no credits remaining",
        "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
        "not_recoverable",
      ),
      api(
        "OpenAI: context length",
        "This model's maximum context length is 200000 tokens. However, your messages resulted in 333379 tokens (333059 in the messages, 320 in the functions). Please reduce the length of the messages or functions.",
        "context",
      ),
      api(
        "Azure OpenAI: call rate, 7 seconds",
        "Requests to the Embeddings_Create Operation under Azure OpenAI API version 2023-07-01-preview have exceeded call rate limit of your current OpenAI S0 pricing tier. Please retry after 7 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit. For Free Account customers, upgrade to Pay as you Go here: https://aka.ms/429TrialUpgrade.",
        "transient",
      ),
      api(
        "Azure OpenAI: call rate, 1 second",
        "Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-02-01 have exceeded call rate limit of your current OpenAI S0 pricing tier. Please retry after 1 second.",
        "transient",
      ),
      api(
        "Azure OpenAI: token rate, a day",
        "Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-02-01 have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 86400 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.",
        "usage_limit",
        NOW + DAY,
      ),
      api(
        "Azure AI Services: call rate",
        "Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-02-01 have exceeded call rate limit of your current AIServices S0 pricing tier. Please retry after 2 seconds. Please contact Azure support service if you would like to further increase the default rate limit.",
        "transient",
      ),
      api(
        "Azure OpenAI: through LiteLLM",
        "litellm.RateLimitError: AzureException RateLimitError - Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-02-01 have exceeded call rate limit of your current OpenAI S0 pricing tier. Please retry after 7 seconds.",
        "transient",
      ),
    ]);
  });

  describe("Google Gemini and Vertex AI", () => {
    runErrors([
      api(
        "Gemini API: per-minute quota",
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-2.5-flash\nPlease retry in 29.019961092s.",
        "transient",
      ),
      api(
        "Gemini API: daily quota, with the quota id",
        `429 RESOURCE_EXHAUSTED. {'error': {'code': 429, 'message': 'You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50, model: gemini-2.5-pro Please retry in 34.07s.', 'status': 'RESOURCE_EXHAUSTED', 'details': [{'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [{'quotaId': 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'quotaValue': '50'}]}, {'@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': '34s'}]}}`,
        "usage_limit",
      ),
      api(
        "Gemini API: no quota on this tier",
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.0-flash\nPlease retry in 29s.",
        "not_recoverable",
      ),
      api(
        "Gemini API: prepay credit depleted",
        "Your Prepay credit balance is depleted. Add credits to your billing account, or turn on auto-reload.",
        "not_recoverable",
      ),
      api(
        "Gemini API: model overloaded",
        "The model is overloaded. Please try again later.",
        "transient",
      ),
      api(
        "Gemini API: model overloaded, JS SDK",
        "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/x:generateContent: [503 Service Unavailable] The model is overloaded. Please try again later.",
        "transient",
      ),
      api(
        "Vertex AI: out of capacity",
        "429 Unable to submit request because the service is temporarily out of capacity.",
        "transient",
      ),
      api(
        "Gemini API: input too long",
        "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
        "context",
      ),
      api(
        "Gemini API: daily quota on this model",
        "You have exhausted your daily quota on this model.",
        "usage_limit",
      ),
    ]);
  });

  describe("Bedrock, OpenRouter and gateways", () => {
    runErrors([
      api(
        "Bedrock: too many tokens",
        "Too many tokens, please wait before trying again.",
        "transient",
      ),
      api(
        "Bedrock: too many tokens through LiteLLM",
        `litellm.RateLimitError: BedrockException - b'{"message":"Too many tokens, please wait before trying again."}'`,
        "transient",
      ),
      api(
        "Bedrock: too many requests",
        "Too many requests, please wait before trying again.",
        "transient",
      ),
      api(
        "Bedrock: tokens per day",
        "Too many tokens per day, please wait before trying again.",
        "usage_limit",
      ),
      api(
        "OpenRouter: free models per day",
        "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
        "usage_limit",
      ),
      api(
        "OpenRouter: upstream rate limit",
        "google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits",
        "transient",
      ),
      api(
        "OpenRouter: can't afford max tokens",
        "This request requires more credits, or fewer max_tokens. You requested up to 3200 tokens, but can only afford 1000.",
        "not_recoverable",
      ),
      api(
        "OpenRouter: insufficient credits",
        "402 Insufficient credits. Add more using https://openrouter.ai/settings/credits",
        "not_recoverable",
      ),
      api("OpenRouter: HTTP 402", "HTTP 402: Insufficient credits", "not_recoverable"),
      api("AI Gateway: rate limit", "Rate limit exceeded", "transient"),
      api(
        "AI Gateway: credit balance required",
        "A positive credit balance is required for all requests, including BYOK, so fallback providers remain available. Add credits at https://vercel.com/d?to=x to continue.",
        "not_recoverable",
      ),
      api(
        "AI Gateway: project budget",
        "Project budget exceeded. Current spend: $1.01, limit: $1.00. Please contact your administrator to increase the budget.",
        "usage_limit",
      ),
      api(
        "AI SDK: insufficient funds",
        "AI_RetryError: Failed after 2 attempts with non-retryable error: 'Upstream request failed: Insufficient account funds'",
        "not_recoverable",
      ),
      api(
        "Ollama Cloud: payment past due",
        `403 Forbidden: {"error":{"message":"your subscription payment is past due. update your payment method: https://ollama.com/settings/billing (ref: x)","type":"api_error","param":null,"code":null}}`,
        "not_recoverable",
      ),
      api(
        "ZenMux: free model limit",
        `Error code: 429 - {'error': {'code': '429', 'type': 'rate_limit', 'message': 'You have reached the usage limit for the current free model. Please try again later, or use a different model.'}}`,
        "usage_limit",
      ),
    ]);
  });

  describe("Kimi, Zhipu and other providers", () => {
    runErrors([
      api(
        "Kimi API: engine overloaded",
        "The engine is currently overloaded, please try again later",
        "transient",
      ),
      api(
        "Kimi API: suspended for balance",
        "Your account org-x <ak-y> is suspended due to insufficient balance, please recharge your account or check your plan and billing details",
        "not_recoverable",
      ),
      api(
        "Kimi API: account not active",
        "Your account xx> is not active, organization <xx> exceeded current quota, please check your plan and billing details",
        "not_recoverable",
      ),
      api(
        "Kimi API: requests per minute",
        "Your account org-x<ak-y> request reached organization max RPM: 20, please try again after 1 seconds",
        "transient",
      ),
      api(
        "Kimi API: organization rate limit",
        "Organization Rate limit exceeded, please try again after 1 seconds",
        "transient",
      ),
      api(
        "Kimi API: concurrency",
        "Your account org-x<ak-y> request reached max organization concurrency: 1, please try again after 1 seconds",
        "transient",
      ),
      api(
        "Kimi API: tokens per minute",
        "Your account org-x<ak-y> request reached project TPM rate limit, current: 1410, limit: 100, please try again after 1 seconds",
        "transient",
      ),
      api(
        "Kimi API: tokens per day",
        "Your account org-x<ak-y> request reached organization TPD rate limit, current: 1526210, limit: 1500000",
        "usage_limit",
      ),
      api("Zhipu: request rate", "Rate limit reached for requests", "transient"),
      api(
        "Zhipu: overloaded",
        "The service may be temporarily overloaded, please try again later",
        "transient",
      ),
      api(
        "Zhipu: 5-hour limit, past reset",
        "Usage limit reached for 5 hour. Your limit will reset at 2026-08-27 21:31:39",
        "usage_limit",
      ),
      api(
        "Zhipu: 5-hour limit, reset tonight",
        "Usage limit reached for 5 hour. Your limit will reset at 2026-10-06 21:31:39",
        "usage_limit",
        local(2026, 9, 6, 21, 31) + 39 * SEC,
      ),
      api(
        "Zhipu: weekly or monthly limit",
        "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-10 06:54:23",
        "usage_limit",
      ),
      api(
        "Zhipu: insufficient balance",
        "Insufficient balance or no resource package. Please recharge.",
        "not_recoverable",
      ),
      api(
        "Zhipu: insufficient balance, Anthropic route",
        `429 {"type":"error","error":{"type":"rate_limit_error","code":"1113","message":"[1113][Insufficient balance or no resource package. Please recharge.][req1]"}}`,
        "not_recoverable",
      ),
      api(
        "Zhipu: coding plan expired",
        "Your GLM Coding Plan package has expired and is temporarily unavailable.",
        "not_recoverable",
      ),
      api(
        "Groq: tokens per day",
        "Rate limit reached for model `llama` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199990, Requested 21021. Please try again in 2h31m16.752s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing",
        "usage_limit",
        NOW + 2 * HOUR + 31 * MIN + 16_752,
      ),
      api(
        "Groq: tokens per minute",
        "Rate limit reached for model gemma2-9b-it in organization org_x tokens per minute (TPM): Limit 15000, Used 11972, Requested 4351. Please try again in 5.289s.",
        "transient",
      ),
      api(
        "Cerebras: tokens per minute",
        "AI_APICallError: Tokens per minute limit exceeded",
        "transient",
      ),
      api("Mistral: request rate", '{"message":"Requests rate limit exceeded"}', "transient"),
    ]);
  });
});

describe("Codex", () => {
  const codex = (message: string) =>
    rpc(-32603, "Internal error", { message, codexErrorInfo: "usageLimitExceeded" });
  const hit = (rest: string) => codex(`You’ve hit your usage limit. ${rest}`);
  const PLUS_OFFER =
    "Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:51 PM.";

  describe("errors", () => {
    runErrors([
      [
        "Codex: Plus limit, same day",
        "codex",
        hit(PLUS_OFFER),
        "usage_limit",
        local(2026, 9, 6, 14, 51),
      ],
      [
        "Codex: limit until a date",
        "codex",
        hit(
          "Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 8th, 2026 4:13 PM.",
        ),
        "usage_limit",
        local(2026, 9, 8, 16, 13),
      ],
      [
        "Codex: limit, try again later",
        "codex",
        hit(
          "Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
        ),
        "usage_limit",
        null,
      ],
      [
        "Codex: business limit, ask admin",
        "codex",
        hit("To get more access now, send a request to your admin or try again at 6:34 PM."),
        "usage_limit",
        local(2026, 9, 6, 18, 34),
      ],
      [
        "Codex: free limit, upgrade to Plus",
        "codex",
        hit(
          "Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 6:34 PM.",
        ),
        "usage_limit",
        local(2026, 9, 6, 18, 34),
      ],
      [
        "Codex: limit, try again at a time",
        "codex",
        hit("Try again at 6:34 PM."),
        "usage_limit",
        local(2026, 9, 6, 18, 34),
      ],
      [
        "Codex: limit with a credits offer",
        "codex",
        hit("Upgrade your plan or add credits, or try again at 6:34 PM."),
        "usage_limit",
        local(2026, 9, 6, 18, 34),
      ],
      [
        "Codex: model limit",
        "codex",
        codex(
          "You’ve hit your usage limit for GPT-5.5-Codex. Switch to another model now, or try again at 6:34 PM.",
        ),
        "usage_limit",
        local(2026, 9, 6, 18, 34),
      ],
      [
        "Codex: workspace out of credits",
        "codex",
        codex("Your workspace is out of credits. Add credits to continue."),
        "billing",
      ],
      [
        "Codex: workspace out of credits, ask owner",
        "codex",
        codex(
          "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
        ),
        "billing",
      ],
      [
        "Codex: spend cap",
        "codex",
        codex("You hit your spend cap set in your workspace. Increase your spend cap to continue."),
        "not_recoverable",
      ],
      [
        "Codex: spend cap set by owner",
        "codex",
        codex(
          "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
        ),
        "not_recoverable",
      ],
      [
        "Codex: quota exceeded",
        "codex",
        codex("Quota exceeded. Check your plan and billing details."),
        "not_recoverable",
      ],
      [
        "Codex: plan without Codex",
        "codex",
        codex(
          "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        ),
        "not_recoverable",
      ],
      [
        "Codex: under another agent name",
        "generic",
        hit(PLUS_OFFER),
        "usage_limit",
        local(2026, 9, 6, 14, 51),
      ],
      [
        "Codex app: day-first date",
        "codex",
        codex(
          "You've hit your usage limit. Upgrade your plan or add credits to continue, or try again at 20 Oct 2026, 16:29.",
        ),
        "usage_limit",
        local(2026, 9, 20, 16, 29),
      ],
      [
        "Codex app: month-first date",
        "codex",
        hit(
          "Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 20, 2026, 7:38 AM.",
        ),
        "usage_limit",
        local(2026, 9, 20, 7, 38),
      ],
      ["Codex: authentication", "codex", rpc(-32000, "Authentication required"), "auth"],
      ["Codex: session not found", "codex", details("Session 019a-abc not found"), "session_lost"],
      [
        "Codex: session in use elsewhere",
        "codex",
        rpc(
          -32600,
          "Invalid request: This Codex session is in use by another Codex client (pid 4242). Close the session there or quit that client, then try again.",
          { reason: "thread_active_writer" },
        ),
        "other",
      ],
    ]);
  });

  describe("turn ends", () => {
    runTurnEnds([
      [
        "Codex: per-minute rate limit text",
        "codex",
        "rate limit exceeded: Rate limit reached for gpt-5 on tokens per min. Please try again in 2s.\n\n",
        "end_turn",
        "none",
      ],
      [
        "Codex: retry limit text",
        "codex",
        "exceeded retry limit, last status: 429 Too Many Requests, request id: 9f9fe320aa92b10b-FRA\n\n",
        "end_turn",
        "none",
      ],
      [
        "Codex: context window text",
        "codex",
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.\n\n",
        "end_turn",
        "none",
      ],
      [
        "Codex: model at capacity text",
        "codex",
        "Selected model is at capacity. Please try a different model.\n\n",
        "end_turn",
        "none",
      ],
      [
        "Codex: high demand text",
        "codex",
        "We’re currently experiencing high demand, which may cause temporary errors.\n\n",
        "end_turn",
        "none",
      ],
    ]);
  });
});

describe("Devin", () => {
  const devin = (code: number, message: string, data: Record<string, unknown>) =>
    rpc(code, message, data);
  runErrors([
    [
      "Devin: quota exhausted",
      "devin",
      devin(-32011, "Quota exhausted.", {
        "cognition.ai/errorKind": "resource_exhausted",
        "cognition.ai/retryable": true,
      }),
      "usage_limit",
      null,
    ],
    [
      "Devin: monthly limit",
      "devin",
      devin(
        -32011,
        "You've reached your monthly usage limit. Wait for the limit to reset next month.",
        { "cognition.ai/errorKind": "resource_exhausted", "cognition.ai/retryable": true },
      ),
      "usage_limit",
      null,
    ],
    [
      "Devin: organization monthly limit",
      "devin",
      devin(
        -32011,
        "Your organization has reached its monthly usage limit. Ask an account admin to raise it, or wait for the limit to reset next month.",
        { "cognition.ai/errorKind": "resource_exhausted" },
      ),
      "usage_limit",
      null,
    ],
    [
      "Devin: usage paused by admin",
      "devin",
      devin(-32011, "An admin paused usage on your account. Ask them to resume it to continue.", {
        "cognition.ai/errorKind": "resource_exhausted",
      }),
      "not_recoverable",
    ],
    [
      "Devin: rate limited, retry after",
      "devin",
      devin(-32011, "Rate limited: too many requests", {
        "cognition.ai/errorKind": "resource_exhausted",
        "cognition.ai/retryable": true,
        "cognition.ai/retryAfterSeconds": 30,
      }),
      "transient",
    ],
    [
      "Devin: rate limited",
      "devin",
      devin(-32011, "Rate limited: too many requests", {
        "cognition.ai/errorKind": "resource_exhausted",
      }),
      "transient",
    ],
    [
      "Devin: upstream unavailable",
      "devin",
      devin(-32603, "Server error: upstream", { "cognition.ai/errorKind": "unavailable" }),
      "transient",
    ],
    [
      "Devin: content filter",
      "devin",
      devin(
        -32603,
        "The model declined to respond to this request (provider content filter). Rephrasing the request or switching models usually works.",
        { "cognition.ai/errorKind": "content_filter" },
      ),
      "other",
    ],
    ["Devin: session not found", "devin", rpc(-32603, "Session not found"), "session_lost"],
  ]);
});

describe("Grok Build", () => {
  runErrors([
    [
      "Grok: team API rate limit",
      "grok",
      rpc(
        -32603,
        "You’ve hit your team’s API rate limit. Ask a team admin to purchase more credits for higher limits, or try again later. See https://docs.x.ai/developers/rate-limits#rate-limit-tiers",
      ),
      "transient",
    ],
    [
      "Grok: team API rate limit, code 429",
      "grok",
      rpc(
        429,
        "You’ve hit your team’s API rate limit. Ask a team admin to purchase more credits for higher limits, or try again later. See https://docs.x.ai/developers/rate-limits#rate-limit-tiers",
      ),
      "transient",
    ],
    [
      "Grok: plan rate limit",
      "grok",
      rpc(
        -32603,
        "You’ve hit the rate limit for your plan. Upgrade your account or try again later.",
      ),
      "transient",
    ],
    [
      "Grok: free usage limit",
      "grok",
      rpc(
        -32603,
        "You’ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok?referrer=grok-build",
      ),
      "usage_limit",
      null,
    ],
    [
      "Grok: model overloaded",
      "grok",
      rpc(-32603, "Model is temporarily overloaded. Try again in a moment."),
      "transient",
    ],
    [
      "Grok: temporarily unavailable",
      "grok",
      rpc(-32603, "Grok is temporarily unavailable. Please try again in a moment. (HTTP 503"),
      "transient",
    ],
    [
      "Grok: subscription required",
      "grok",
      rpc(-32603, "http client init failed: requires a Grok subscription"),
      "not_recoverable",
    ],
    ["Grok: context length", "grok", rpc(-32603, "context_length_exceeded"), "context"],
    [
      "Grok: out of credits",
      "grok",
      rpc(-32603, "out of credits or over your spending limit. Add credits and retry."),
      "billing",
    ],
    ["Grok: weekly limit", "grok", rpc(-32603, "You hit your weekly limit."), "usage_limit"],
    [
      "Grok: plan credit limit",
      "grok",
      rpc(-32603, "You’ve hit the credit limit for your plan."),
      "not_recoverable",
    ],
    ["Grok: spending cap", "grok", rpc(-32603, "You’ve hit your spending cap."), "not_recoverable"],
  ]);
});

describe("GitHub Copilot CLI", () => {
  const copilot = (name: string, text: string, want: Want, reset?: Reset): TurnEndCase => [
    name,
    "copilot",
    `Error: ${text}`,
    "end_turn",
    want,
    reset,
  ];
  const DOCS = "Learn More (https://docs.github.com/copilot/concepts/rate-limits).";
  const REQUEST_ID = "(Request ID: C33A:2A98BA:2871A5:13FF8A5:6A7702DD)";

  describe("turn ends", () => {
    runTurnEnds([
      copilot(
        "Copilot: weekly limit, in hours",
        `You've reached your weekly rate limit. Please wait for your limit to reset in 2 hours. ${DOCS}`,
        "usage_limit",
        NOW + 2 * HOUR,
      ),
      copilot(
        "Copilot: weekly limit, on a date",
        `You've reached your weekly rate limit. Please wait for your limit to reset on October 7, 2026 at 3:47 PM. ${DOCS}`,
        "usage_limit",
        utc(2026, 9, 7, 15, 47),
      ),
      copilot(
        "Copilot: weekly limit, on a date with request id",
        `You've reached your weekly rate limit. Please wait for your limit to reset on October 8, 2026 at 3:47 PM. ${DOCS} ${REQUEST_ID}`,
        "usage_limit",
        utc(2026, 9, 8, 15, 47),
      ),
      copilot(
        "Copilot: weekly limit, no time",
        `You've reached your weekly rate limit. Please wait for your limit to reset. ${DOCS}`,
        "usage_limit",
        null,
      ),
      copilot(
        "Copilot: session limit, hours and minutes",
        `You've hit your session rate limit. Please wait for your limit to reset in 1 hour 30 minutes. ${DOCS}`,
        "usage_limit",
        NOW + 90 * MIN,
      ),
      copilot(
        "Copilot: session limit with request id",
        `You've hit your session rate limit. Please wait for your limit to reset in 3 hours. ${DOCS} ${REQUEST_ID}`,
        "usage_limit",
        NOW + 3 * HOUR,
      ),
      copilot(
        "Copilot: model rate limit, 10 minutes",
        `You've hit the rate limit for this model. Please switch models or wait for your limit to reset in 10 minutes. ${DOCS}`,
        "none",
      ),
      copilot(
        "Copilot: model rate limit, 2 minutes",
        `You've hit the rate limit for this model. Please switch models or wait for your limit to reset in 2 minutes. ${DOCS}`,
        "none",
      ),
      copilot(
        "Copilot: model rate limit, 23 hours",
        `You've hit the rate limit for this model. Please switch models or wait for your limit to reset in 23 hours. ${DOCS}`,
        "usage_limit",
        NOW + 23 * HOUR,
      ),
      copilot(
        "Copilot: rate limit, under a minute",
        `You've hit your rate limit. Please wait for your limit to reset in under a minute. ${DOCS}`,
        "none",
      ),
      copilot(
        "Copilot: rate limit, no time",
        `You've hit your rate limit. Please wait for your limit to reset. ${DOCS}`,
        "none",
      ),
      copilot(
        "Copilot: weekly limit, switch to auto",
        "You've reached your weekly rate limit. Please wait for your limit to reset on October 8, 2026 at 2:00 AM or switch to auto model to continue.",
        "usage_limit",
        utc(2026, 9, 8, 2),
      ),
      copilot(
        "Copilot: older wording, 58 hours",
        "Sorry, you've hit a rate limit that restricts the number of Copilot model requests you can make within a specific time period. Please try again in 58 hours. Please review our Terms of Service (https://docs.github.com/site-policy).",
        "usage_limit",
        NOW + 58 * HOUR,
      ),
      copilot(
        "Copilot: older wording, 2 minutes",
        "Sorry, you've hit a rate limit that restricts the number of Copilot model requests you can make within a specific time period. Please try again in 2 minutes. Please review our Terms of Service (https://docs.github.com/site-policy).",
        "none",
      ),
      copilot(
        "Copilot: editor wording, hours and minutes",
        "You've hit your session rate limit. Please upgrade your plan or wait 1 hours 48 minutes for your limit to reset",
        "usage_limit",
        NOW + 108 * MIN,
      ),
      copilot(
        "Copilot: editor wording, wait a moment",
        "You've hit your session rate limit. Please upgrade your plan or wait a moment for your limit to reset.",
        "usage_limit",
        null,
      ),
      copilot(
        "Copilot: monthly AI credits used",
        "You've run out of your included AI credits for the month. Manage budget: https://github.com/settings/copilot/features",
        "usage_limit",
        null,
      ),
      copilot(
        "Copilot: 402 no quota",
        '402 {"error":{"message":"You have no quota","code":"quota_exceeded"}}',
        "usage_limit",
        null,
      ),
      copilot("Copilot: 402 with short text", "402 x", "usage_limit", null),
      copilot("Copilot: 402 payment required", "402 Payment Required", "usage_limit", null),
      copilot(
        "Copilot: session spending limit",
        "You've reached the spending limit for this session. Start a new session to continue.",
        "not_recoverable",
      ),
      copilot(
        "Copilot: several licenses",
        "You have multiple GitHub Copilot licenses from organizations or enterprises. Configure which license to use: https://github.com/settings/copilot/features",
        "not_recoverable",
      ),
      copilot(
        "Copilot: free chat requests used",
        "You've used all your Copilot Free chat requests for the month. Upgrade your plan for access to premium models and the Copilot Coding Agent.",
        "usage_limit",
        null,
      ),
      copilot(
        "Copilot: trials paused",
        "Copilot Pro trials have been temporarily paused. Please upgrade your account or revert to Copilot Free.",
        "not_recoverable",
      ),
      copilot(
        "Copilot: authorization error",
        "Authorization error. Your credentials may be expired or invalid.",
        "none",
      ),
      copilot(
        "Copilot: context window full",
        "The context window is full and the request cannot be processed. Try starting a new session or compacting the conversation.",
        "none",
      ),
      copilot(
        "Copilot: retries ended in 503",
        "Execution failed: Failed to get response from the AI model; retried 5 times (total retry wait time: 14.89 seconds) Last error: 503 service unavailable",
        "none",
      ),
      copilot(
        "Copilot: session limits exhausted",
        "Session limits exhausted before another model call could run.",
        "not_recoverable",
      ),
      copilot(
        "Copilot: prompt over the token limit",
        "Execution failed: Failed to get response from the AI model; retried 5 times (total retry wait time: 5.00 seconds) Last error: 400 prompt token count of 200000 exceeds the limit of 128000",
        "none",
      ),
      copilot(
        "Copilot: session token expired",
        "Session token expired and the request could not be retried. Please resend your message.",
        "none",
      ),
      copilot(
        "Copilot: own key, weekly limit",
        "Failed to get response from the AI model; retried 5 times (total retry wait time: 59.43 seconds) Last error: 429 You've reached your weekly rate limit.",
        "usage_limit",
      ),
      copilot(
        "Copilot: own key, premium allowance",
        "402 You have exceeded your premium request allowance.",
        "usage_limit",
      ),
    ]);
  });

  describe("errors", () => {
    runErrors([
      [
        "Copilot: session not found",
        "copilot",
        rpc(-32602, "Session 00000000-0000-0000-0000-000000000000 not found", {
          sessionId: "00000000-0000-0000-0000-000000000000",
        }),
        "session_lost",
      ],
      [
        "Copilot: session resource not found",
        "copilot",
        rpc(-32002, "Resource not found: Session abc not found", { uri: "Session abc not found" }),
        "session_lost",
      ],
    ]);
  });
});

describe("Cursor", () => {
  describe("turn ends", () => {
    runTurnEnds([
      [
        "Cursor: upgrade your plan",
        "cursor",
        "\n\nUpgrade your plan to continue",
        "end_turn",
        "usage_limit",
        null,
      ],
      [
        "Cursor: add a payment method",
        "cursor",
        "\n\nAdd a payment method to continue",
        "end_turn",
        "billing",
      ],
      ["Cursor: sign in", "cursor", "\n\nPlease sign in to continue", "end_turn", "none"],
      [
        "Cursor: resource exhausted",
        "cursor",
        "\n\nError: T: [resource_exhausted] Error",
        "end_turn",
        "none",
      ],
      [
        "Cursor: retriable stream error",
        "cursor",
        "\n\nError: RetriableError: WritableIterable is closed",
        "end_turn",
        "none",
      ],
      [
        "Cursor: free requests until cycle end",
        "cursor",
        "\n\nError: NonRetriableError: You've hit your free requests limit. Upgrade to Pro for more usage... Your usage limits will reset when your monthly cycle ends on 10/8/2026.",
        "end_turn",
        "usage_limit",
        local(2026, 9, 8, 0, 0),
      ],
      [
        "Cursor: high demand",
        "cursor",
        "\n\nError: NonRetriableError: We're experiencing high demand for the selected model right now. Please upgrade to Pro, switch to Auto, another model, or try again in a few moments.",
        "end_turn",
        "none",
      ],
    ]);
  });

  describe("errors", () => {
    runErrors([
      ["Cursor: session not found", "cursor", details("Session abc not found"), "session_lost"],
      [
        "Cursor: authentication",
        "cursor",
        rpc(-32000, "Authentication required", {
          message:
            "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.",
        }),
        "auth",
      ],
    ]);
  });
});

describe("Factory Droid", () => {
  // The prompt fails with a generic error; the limit is in the turn's last message.
  const AGENT_ERROR = details("Internal error: Agent error");
  const droid = (name: string, text: string, want: Want, reset?: Reset): TurnEndCase => [
    name,
    "droid",
    `Error: ${text}`,
    "error",
    want,
    reset,
  ];

  it("Droid: the prompt error itself says nothing", () => {
    expect(classifyLimit("droid", AGENT_ERROR, NOW).kind).toBe("other");
  });

  describe("turn ends after the error", () => {
    runTurnEnds([
      droid(
        "Droid: weekly Core limit",
        `402 {"detail":"You've reached your weekly Droid Core usage limit (resets in 5 days).\\nReload Extra Usage credits or wait for your limits to reset.","status":402,"title":"Payment Required","displayToUser":true,"requestId":"req_123"}`,
        "usage_limit",
        NOW + 5 * DAY,
      ),
      droid(
        "Droid: 5-hour limit in a 402",
        `402 {"detail":"You've reached your 5-hour standard usage limit (resets in 1h 0min).","status":402,"title":"Payment Required","displayToUser":true}`,
        "usage_limit",
        NOW + HOUR,
      ),
      droid(
        "Droid: 5-hour limit",
        "You've reached your 5-hour standard usage limit (resets in 1h 0min).",
        "usage_limit",
        NOW + HOUR,
      ),
      droid(
        "Droid: credit limit reached",
        '402 {"detail":"Credit limit reached.","status":402,"displayToUser":true}',
        "billing",
      ),
      droid("Droid: insufficient balance", "402 Insufficient Balance", "billing"),
      droid(
        "Droid: reload your tokens",
        '402 {"detail":"Ready for more? Reload your tokens..."}',
        "billing",
      ),
    ]);
  });

  describe("errors", () => {
    runErrors([
      [
        "Droid: unknown session",
        "droid",
        rpc(-32602, "Invalid params: Unknown session identifier", { sessionId: "x" }),
        "session_lost",
      ],
      [
        "Droid: no authentication",
        "droid",
        rpc(
          -32603,
          "Internal error: API key authentication failed",
          "No authentication available. Set FACTORY_API_KEY or login.",
        ),
        "auth",
      ],
    ]);
  });
});

describe("Amp", () => {
  const amp = (name: string, text: string, want: Want, reset?: Reset): TurnEndCase => [
    name,
    "amp",
    `Error: ${text}`,
    "end_turn",
    want,
    reset,
  ];

  describe("turn ends", () => {
    runTurnEnds([
      amp(
        "Amp: free usage until the next hour",
        "Add credits to keep using Amp right now, or wait until the next hour starts for more free usage.",
        "usage_limit",
        local(2026, 9, 6, 15),
      ),
      amp(
        "Amp: free usage limit, next hour",
        "You've reached your free usage limit. Add credits to keep using Amp right now, or wait until the next hour starts for more free usage.",
        "usage_limit",
        local(2026, 9, 6, 15),
      ),
      amp(
        "Amp: monthly included usage",
        "Your included usage is at its monthly limit, and no paid credits are available. Upgrade to Gigawatt for more included usage, or add paid credits to continue now.",
        "usage_limit",
        null,
      ),
      amp(
        "Amp: out of credits",
        "Out of Credits. Upgrade to a paid tier, or add credits to keep using Amp.",
        "billing",
      ),
      amp(
        "Amp: out of credits, choose a paid tier",
        "You are out of credits. Add paid credits or choose a paid tier. ",
        "billing",
      ),
      amp(
        "Amp: workspace usage limit",
        "Your workspace usage limit has been reached. Ask a workspace admin to change your limit.",
        "not_recoverable",
      ),
      amp("Amp: rate limit", "Rate limit exceeded. Try again shortly.", "none"),
      amp(
        "Amp: context window",
        "This conversation has reached the context window limit. Start a new thread to continue.",
        "none",
      ),
      amp(
        "Amp: 402 out of credits",
        '{"error":{"code":402,"message":"Out of credits"}}',
        "billing",
      ),
    ]);
  });

  describe("errors", () => {
    runErrors([
      ["Amp: session not found", "amp", details("Session not found"), "session_lost"],
      [
        "Amp: thread not found",
        "amp",
        details("Amp CLI process exited with code 1: Thread not found."),
        "session_lost",
      ],
      ["Amp: authentication", "amp", rpc(-32000, "Authentication required"), "auth"],
    ]);
  });
});

describe("Gemini CLI, Qwen Code and Qoder", () => {
  const code429 = (message: string, code = 429) => rpc(code, message);
  runErrors([
    [
      "Gemini: rate limit, try later",
      "gemini",
      code429("Rate limit exceeded. Try again later."),
      "usage_limit",
      null,
    ],
    [
      "Gemini: daily quota",
      "gemini",
      code429("You have exhausted your daily quota on this model."),
      "usage_limit",
    ],
    [
      "Gemini: capacity, resets now",
      "gemini",
      code429("You have exhausted your capacity on this model. Your quota will reset after 0s."),
      "transient",
    ],
    [
      "Gemini: capacity, resets in hours",
      "gemini",
      code429(
        "You have exhausted your capacity on this model. Your quota will reset after 2h3m4s.",
      ),
      "usage_limit",
      NOW + 2 * HOUR + 3 * MIN + 4 * SEC,
    ],
    [
      "Gemini: individual quota",
      "gemini",
      code429(
        "Individual quota reached. Please upgrade your subscription to increase your limits.",
      ),
      "usage_limit",
    ],
    [
      "Gemini: Code Assist individual quota",
      "gemini",
      code429(
        "Cloud Code Assist API error (429): Individual quota reached.\n Contact your administrator to enable overages",
      ),
      "usage_limit",
    ],
    [
      "Gemini: free tier, short retry",
      "gemini",
      code429(
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 2\nPlease retry in 44.097740004s.",
      ),
      "transient",
    ],
    [
      "Gemini: free tier, retry in an hour",
      "gemini",
      code429(
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 2\nPlease retry in 3600s.",
      ),
      "usage_limit",
      NOW + HOUR,
    ],
    [
      "Gemini: no quota for the model",
      "gemini",
      code429(
        "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests\nlimit: 0, model: gemini-3-pro\nPlease retry in 59s.",
      ),
      "not_recoverable",
    ],
    [
      "Gemini: no capacity",
      "gemini",
      code429("No capacity available for model gemini-3.1-pro-preview on the server"),
      "transient",
    ],
    [
      "Gemini: resource exhausted, retry in an hour",
      "gemini",
      code429("Resource has been exhausted (e.g. check quota).\nSuggested retry after 3600s."),
      "usage_limit",
      NOW + HOUR,
    ],
    [
      "Gemini: per-minute quota",
      "gemini",
      code429(
        "Quota exceeded for quota metric 'Generate Content API requests per minute'\nSuggested retry after 60s.",
      ),
      "transient",
    ],
    [
      "Gemini: validation required",
      "gemini",
      code429("Validation required to continue.", 403),
      "not_recoverable",
    ],
    ["Gemini: model not found", "gemini", code429("Model not found", 404), "other"],
    ["Gemini: session not found", "gemini", rpc(-32602, "Session not found: abc"), "session_lost"],
    ["Gemini: authentication", "gemini", rpc(-32000, "Authentication required."), "auth"],
    [
      "Qwen: rate limit, try later",
      "qwen",
      code429("Rate limit exceeded. Try again later."),
      "usage_limit",
      null,
    ],
    [
      "Qwen: weekly token plan, reset in July",
      "qwen",
      details(
        "Quota exhausted: Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC.\n\nPlease retry after the reset time, or switch to another API key / auth method.",
      ),
      "usage_limit",
      utc(2027, 6, 27, 9, 25),
    ],
    [
      "Qwen: weekly token plan, reset this week",
      "qwen",
      details(
        "Quota exhausted: Your token-plan 1-week quota has been exhausted. The quota will reset at 10-09 09:25:00 UTC.\n\nPlease retry after the reset time, or switch to another API key / auth method.",
      ),
      "usage_limit",
      utc(2026, 9, 9, 9, 25),
    ],
    [
      "Qwen: free tier discontinued",
      "qwen",
      details(
        "Qwen OAuth free tier has been discontinued as of 2026-04-15.\n\nTo continue using Qwen Code, try one of these alternatives:\n  - OpenRouter: x\n\nAfter setting up your API key, run /auth to configure your provider.",
      ),
      "billing",
    ],
    ["Qwen: session not found", "qwen", details("Session not found: abc"), "session_lost"],
    [
      "Qwen: session not found, own code",
      "qwen",
      rpc(-32004, "Session not found: abc"),
      "session_lost",
    ],
    [
      "Qoder: rate limit, try later",
      "qoder",
      code429("Rate limit exceeded. Try again later."),
      "usage_limit",
      null,
    ],
    [
      "Qoder: budget exceeded",
      "qoder",
      code429("Maximum budget exceeded.", 500),
      "not_recoverable",
    ],
    ["Qoder: session not found", "qoder", details("Session not found: abc"), "session_lost"],
  ]);
});

describe("Kimi CLI", () => {
  const kimi = (status: number, message: string) =>
    rpc(-32603, "Internal error", {
      error: `Error code: ${status} - {'error': {'message': "${message}", 'type': 'x'}}`,
    });
  runErrors([
    [
      "Kimi: 5-hour limit",
      "kimi",
      kimi(403, "You've reached your 5-hour usage limit... reset when current 5-hour window ends."),
      "usage_limit",
    ],
    [
      "Kimi: weekly limit",
      "kimi",
      kimi(403, "You've reached your weekly (7-day) usage limit"),
      "usage_limit",
    ],
    [
      "Kimi: monthly limit",
      "kimi",
      kimi(403, "You've reached your monthly usage limit for this billing cycle"),
      "not_recoverable",
    ],
    [
      "Kimi: concurrent requests",
      "kimi",
      kimi(403, "You've reached your concurrent request limit"),
      "transient",
    ],
    [
      "Kimi: too many requests",
      "kimi",
      kimi(429, "We're receiving too many requests"),
      "transient",
    ],
    [
      "Kimi: engine overloaded",
      "kimi",
      rpc(-32603, "Internal error", {
        error:
          "Error code: 429 - {'error': {'message': 'The engine is currently overloaded, please try again later', 'type': 'engine_overloaded_error'}}",
      }),
      "transient",
    ],
    [
      "Kimi: tokens per day",
      "kimi",
      rpc(-32603, "Internal error", {
        error:
          "Error code: 429 - {'error': {'message': 'Your account org-1 request reached organization TPD rate limit, current: 1505241, limit: 1500000', 'type': 'rate_limit_reached_error'}}",
      }),
      "usage_limit",
    ],
    [
      "Kimi: membership not verified",
      "kimi",
      kimi(402, "unable to verify your membership benefits"),
      "not_recoverable",
    ],
    [
      "Kimi: model not in subscription",
      "kimi",
      kimi(401, "Your current subscription does not have access to kimi-k3"),
      "not_recoverable",
    ],
    [
      "Kimi: invalid authentication",
      "kimi",
      kimi(401, "Invalid Authentication"),
      "not_recoverable",
    ],
    [
      "Kimi: over the model token limit",
      "kimi",
      kimi(400, "Your request exceeded model token limit: 262144"),
      "context",
    ],
    [
      "Kimi: session not found",
      "kimi",
      rpc(-32602, "Invalid params", { session_id: "Session not found" }),
      "session_lost",
    ],
  ]);
});

describe("Z.AI GLM", () => {
  const glm = (text: string) => details(`429 ${text}`);
  /** Z.AI prints its reset times in China Standard Time (UTC+8). */
  const shanghai = (y: number, m: number, d: number, h: number, mi = 0, s = 0) =>
    utc(y, m, d, h, mi, s) - 8 * HOUR;
  runErrors([
    [
      "GLM: weekly or monthly limit",
      "glm",
      glm("Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-12 00:00:00"),
      "usage_limit",
      shanghai(2026, 9, 12, 0),
    ],
    [
      "GLM: 7-day limit, no extra-usage balance",
      "glm",
      glm(
        "Usage limit reached for the past 7 days. Insufficient balance for extra usage. Resets at 2026-10-12 22:00:00.",
      ),
      "usage_limit",
      shanghai(2026, 9, 12, 22),
    ],
    [
      "GLM: 7-day limit, spend limit",
      "glm",
      glm(
        "Usage limit reached for the past 7 days. Extra usage is not available due to monthly spend limit. Resets at 2026-10-12 22:00:00.",
      ),
      "usage_limit",
      shanghai(2026, 9, 12, 22),
    ],
    ["GLM: request rate", "glm", glm("Rate limit reached for requests"), "transient"],
    [
      "GLM: overloaded",
      "glm",
      glm("The service may be temporarily overloaded, please try again later"),
      "transient",
    ],
    [
      "GLM: insufficient balance",
      "glm",
      glm("Insufficient balance or no resource package. Please recharge."),
      "billing",
    ],
    [
      "GLM: coding plan expired",
      "glm",
      glm(
        "Your GLM Coding Plan package has expired and is temporarily unavailable. You can resume using it after renewing the subscription on the official website. https://z.ai/subscribe。",
      ),
      "not_recoverable",
    ],
    [
      "GLM: model not in plan",
      "glm",
      glm("Your current subscription plan does not yet include access to glm-5"),
      "not_recoverable",
    ],
    [
      "GLM: fair usage policy",
      "glm",
      glm(
        "Your account's current usage pattern does not comply with the Fair Usage Policy, and your request frequency has been limited. To restore access, please submit a request.",
      ),
      "not_recoverable",
    ],
    [
      "GLM: enterprise package expired",
      "glm",
      glm("Your enterprise package has expired. Please contact your enterprise administrator."),
      "not_recoverable",
    ],
    [
      "GLM: key limited to enterprise",
      "glm",
      glm("This API Key is limited to enterprise coding package scenarios."),
      "not_recoverable",
    ],
    ["GLM: authentication failed", "glm", details("401 Authentication Failed"), "not_recoverable"],
    [
      "GLM: context overflow",
      "glm",
      details(
        "Context overflow could not reduce the request payload; narrow the current request or start a new session.",
      ),
      "context",
    ],
    [
      "GLM: context overflow after compaction",
      "glm",
      details("Context overflow persisted after emergency compaction"),
      "context",
    ],
    ["GLM: session not found", "glm", details("Session not found: abc"), "session_lost"],
  ]);
});

describe("MiniMax Code", () => {
  const minimax = (text: string) =>
    rpc(-32603, `Internal error: MiniMax Code Runtime failed: ${text}`);
  runErrors([
    ["MiniMax: usage limit", "minimax", minimax("usage limit exceeded"), "usage_limit", null],
    [
      "MiniMax: token plan limit",
      "minimax",
      minimax("Token Plan usage limit reached"),
      "usage_limit",
    ],
    [
      "MiniMax: limit on continuation",
      "minimax",
      rpc(-32603, "Internal error: MiniMax Code Runtime continuation failed: usage limit exceeded"),
      "usage_limit",
    ],
    ["MiniMax: insufficient balance", "minimax", minimax("insufficient balance"), "billing"],
    ["MiniMax: rate limit", "minimax", minimax("rate limit"), "transient"],
    ["MiniMax: token limit", "minimax", minimax("token limit"), "transient"],
    ["MiniMax: connection limit", "minimax", minimax("conn limit"), "transient"],
    ["MiniMax: rate growth limit", "minimax", minimax("rate growth limit"), "transient"],
    ["MiniMax: invalid key", "minimax", minimax("invalid API Key"), "not_recoverable"],
    [
      "MiniMax: not authorized",
      "minimax",
      minimax("not authorized / token not match group / cookie is missing, log in again"),
      "not_recoverable",
    ],
    ["MiniMax: LLM usage limit", "minimax", minimax("LLM usage limit reached"), "usage_limit"],
    ["MiniMax: LLM credits exhausted", "minimax", minimax("LLM credits exhausted"), "billing"],
    [
      "MiniMax: provider rate limited",
      "minimax",
      minimax("LLM provider rate limited the request"),
      "transient",
    ],
    [
      "MiniMax: provider token rate",
      "minimax",
      minimax("LLM provider token rate limit reached"),
      "transient",
    ],
    ["MiniMax: provider overloaded", "minimax", minimax("LLM provider is overloaded"), "transient"],
    [
      "MiniMax: provider authentication",
      "minimax",
      minimax("LLM provider authentication failed"),
      "not_recoverable",
    ],
  ]);
});

describe("Auggie and CodeBuddy", () => {
  const auggie = (message: string, apiStatus: string, httpStatus: number, prefix = "") =>
    rpc(-32603, `Internal error: ${prefix}${message}`, { httpStatus, apiStatus, message });
  const quota = (text: string, data: Record<string, unknown>) =>
    rpc(-32003, `Quota exceeded: ${text}`, { details: text, category: "quota", ...data });
  runErrors([
    [
      "Auggie: subscription inactive",
      "auggie",
      auggie(
        "Your subscription for account a@b.co is inactive. Please update your subscription here to continue using Augment.",
        "permissionDenied",
        403,
        "Permission denied: ",
      ),
      "not_recoverable",
    ],
    [
      "Auggie: too many requests",
      "auggie",
      auggie("Too many requests", "resourceExhausted", 429),
      "transient",
    ],
    [
      "Auggie: rate limit naming a quota",
      "auggie",
      auggie("Rate limit exceeded: quota exceeded", "resourceExhausted", 429),
      "transient",
    ],
    [
      "Auggie: not logged in",
      "auggie",
      rpc(-32000, "Authentication required: Not authenticated: run 'auggie login' first."),
      "auth",
    ],
    [
      "Auggie: client upgrade required",
      "auggie",
      auggie(
        "Client upgrade required. Please update to the latest version to continue.",
        "augmentUpgradeRequired",
        426,
      ),
      "not_recoverable",
    ],
    ["Auggie: session not found", "auggie", details("No ACP session found: abc"), "session_lost"],
    [
      "CodeBuddy: quota exhausted",
      "codebuddy",
      quota("quota exhausted", { code: 14001 }),
      "not_recoverable",
    ],
    [
      "CodeBuddy: user limit exhausted",
      "codebuddy",
      quota("UsageLimitUserExhausted", { code: 14018 }),
      "not_recoverable",
    ],
    [
      "CodeBuddy: quota used up, Chinese text",
      "codebuddy",
      quota("额度已用尽", {}),
      "not_recoverable",
    ],
    [
      "CodeBuddy: no available credits",
      "codebuddy",
      quota("no available credits", {}),
      "not_recoverable",
    ],
    [
      "CodeBuddy: rate limit",
      "codebuddy",
      quota("Rate limit exceeded", { code: 14003, statusCode: 429 }),
      "transient",
    ],
    [
      "CodeBuddy: too many requests",
      "codebuddy",
      quota("too many requests", { statusCode: 429 }),
      "transient",
    ],
    ["CodeBuddy: request rate", "codebuddy", quota("CraftRateLimit", { code: 6000 }), "transient"],
    ["CodeBuddy: tokens per day", "codebuddy", quota("TPDLimit", { code: 6004 }), "usage_limit"],
    [
      "CodeBuddy: license expired",
      "codebuddy",
      rpc(-32603, "Internal error", {
        details: "License expired",
        code: 14015,
        category: "internal",
      }),
      "not_recoverable",
    ],
    [
      "CodeBuddy: context too long",
      "codebuddy",
      rpc(-32603, "Internal error", {
        details: "ContextTooLong",
        code: 11115,
        category: "internal",
      }),
      "context",
    ],
    [
      "CodeBuddy: prompt too long",
      "codebuddy",
      rpc(-32004, "Model service error: prompt is too long", { details: "prompt is too long" }),
      "context",
    ],
    [
      "CodeBuddy: session not found",
      "codebuddy",
      details("Session not found: abc"),
      "session_lost",
    ],
  ]);
});

describe("Antigravity", () => {
  const QUOTA = "Usage Limit Reached\n\nYou have reached your current quota for this period.";

  describe("turn ends", () => {
    runTurnEnds([
      [
        "Antigravity: quota, resets in days",
        "antigravity",
        `${QUOTA} Your limit will reset in 4 days, 23 hours.`,
        "end_turn",
        "usage_limit",
        NOW + 4 * DAY + 23 * HOUR,
      ],
      [
        "Antigravity: quota, the turn ends with refusal",
        "antigravity",
        `${QUOTA} Your limit will reset in 2 hours, 15 minutes.`,
        "refusal",
        "usage_limit",
        NOW + 2 * HOUR + 15 * MIN,
      ],
      [
        "Antigravity: quota, resets in hours",
        "antigravity",
        `${QUOTA} Your limit will reset in 2 hours, 15 minutes.`,
        "end_turn",
        "usage_limit",
        NOW + 2 * HOUR + 15 * MIN,
      ],
      [
        "Antigravity: quota, resets on a date",
        "antigravity",
        `${QUOTA} Your limit will reset on Oct 7, 2026 14:05 UTC.`,
        "end_turn",
        "usage_limit",
        utc(2026, 9, 7, 14, 5),
      ],
      ["Antigravity: quota, no time", "antigravity", QUOTA, "end_turn", "usage_limit", null],
      [
        "Antigravity: model capacity, hours",
        "antigravity",
        "Agent execution error: You have exhausted your capacity on this model. Your quota will reset after 2h3m4s.",
        "end_turn",
        "usage_limit",
        NOW + 2 * HOUR + 3 * MIN + 4 * SEC,
      ],
      [
        "Antigravity: model capacity, days in hours",
        "antigravity",
        "You have exhausted your capacity on this model. Your quota will reset after 119h36m35.41909833s.",
        "end_turn",
        "usage_limit",
        NOW + 119 * HOUR + 36 * MIN + 35_419,
      ],
      [
        "Antigravity: model capacity, seconds",
        "antigravity",
        "You have exhausted your capacity on this model. Your quota will reset after 5s.",
        "end_turn",
        "none",
      ],
      [
        "Antigravity: model quota",
        "antigravity",
        "Agent execution error: You have exhausted your quota on this model.",
        "end_turn",
        "usage_limit",
        null,
      ],
      [
        "Antigravity: high traffic",
        "antigravity",
        "Agent execution error: Our servers are experiencing high traffic right now, please try again in a minute.",
        "end_turn",
        "none",
      ],
    ]);
  });

  describe("errors", () => {
    runErrors([
      [
        "Antigravity: session not found",
        "antigravity",
        details("Session not found: abc"),
        "session_lost",
      ],
    ]);
  });
});

describe("OpenCode and Kilo", () => {
  const opencode = (message: string, errorName = "APIError") =>
    rpc(-32603, `Internal error: ${message}`, { service: "session", errorName });
  runErrors([
    [
      "OpenCode Go: 5-hour limit",
      "opencode",
      opencode(
        "5-hour usage limit reached. Resets in 4hr 10min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/w/go",
      ),
      "usage_limit",
      NOW + 4 * HOUR + 10 * MIN,
    ],
    [
      "OpenCode Go: weekly limit",
      "opencode",
      opencode(
        "Weekly usage limit reached. Resets in 3 days. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/w/go",
      ),
      "usage_limit",
      NOW + 3 * DAY,
    ],
    [
      "OpenCode Go: monthly limit",
      "opencode",
      opencode(
        "Monthly usage limit reached. Resets in 4 days. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/w/go",
      ),
      "usage_limit",
      NOW + 4 * DAY,
    ],
    [
      "OpenCode Black: subscription quota",
      "opencode",
      opencode("Subscription quota exceeded. Retry in 2hr 5min."),
      "usage_limit",
      NOW + 2 * HOUR + 5 * MIN,
    ],
    [
      "OpenCode Zen: free rate limit",
      "opencode",
      opencode("Rate limit exceeded. Please try again later."),
      "usage_limit",
    ],
    [
      "OpenCode: OpenRouter free models per day",
      "opencode",
      opencode("Rate limit exceeded: free-models-per-day-high-balance."),
      "usage_limit",
    ],
    [
      "OpenCode: 5-hour quota, reset with offset",
      "opencode",
      opencode(
        "You have exceeded the 5-hour usage quota. It will reset at 2026-10-07 16:11:46 +0800 CST.",
      ),
      "usage_limit",
      utc(2026, 9, 7, 8, 11, 46),
    ],
    [
      "OpenCode: upstream rate limit",
      "opencode",
      opencode("Upstream request failed: [rate_limit_exceeded]"),
      "transient",
    ],
    [
      "OpenCode: insufficient balance",
      "opencode",
      opencode(
        "Insufficient balance. Manage your billing here: https://opencode.ai/workspace/w/billing",
      ),
      "billing",
    ],
    [
      "OpenCode: no payment method",
      "opencode",
      opencode(
        "No payment method. Add a payment method here: https://opencode.ai/workspace/w/billing",
      ),
      "billing",
    ],
    [
      "OpenCode: workspace spending limit",
      "opencode",
      opencode(
        "Your workspace has reached its monthly spending limit of $50. Manage your limits here: https://opencode.ai/workspace/w/billing",
      ),
      "billing",
    ],
    [
      "OpenCode: user spending limit",
      "opencode",
      opencode(
        "You have reached your monthly spending limit of $50. Manage your limits here: https://opencode.ai/workspace/w/billing",
      ),
      "billing",
    ],
    [
      "OpenCode: OpenAI quota exceeded",
      "opencode",
      opencode("Quota exceeded. Check your plan and billing details."),
      "billing",
    ],
    [
      "OpenCode: Codex needs Plus",
      "opencode",
      opencode(
        "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      ),
      "billing",
    ],
    [
      "OpenCode: free promotion ended",
      "opencode",
      opencode(
        "Free promotion has ended for big-pickle. You can continue using the model by subscribing to OpenCode Go - https://opencode.ai/go",
      ),
      "billing",
    ],
    [
      "OpenCode: context overflow",
      "opencode",
      opencode("Input exceeds context window of this model", "ContextOverflowError"),
      "context",
    ],
    [
      "OpenCode: provider authentication",
      "opencode",
      rpc(-32000, "Authentication required: provider authentication required", {
        providerId: "openai",
      }),
      "auth",
    ],
    [
      "OpenCode: session not found",
      "opencode",
      rpc(-32602, "Invalid params: session not found: s1"),
      "session_lost",
    ],
    [
      "OpenCode: service failure",
      "opencode",
      rpc(-32603, "Internal error: OpenCode service failure"),
      "other",
    ],
    [
      "Kilo: insufficient balance",
      "opencode",
      opencode("Insufficient balance. Please add credits to continue."),
      "billing",
    ],
    [
      "Kilo: free model rate limit",
      "opencode",
      opencode("Rate limit exceeded for free models. Please try again later."),
      "usage_limit",
    ],
    [
      "Kilo: free model usage limit",
      "opencode",
      opencode(
        "Too Many Requests: Free model usage limit reached. Please try again later or upgrade to a paid model.",
      ),
      "usage_limit",
    ],
    [
      "Kilo: provider rate limit",
      "opencode",
      opencode("Provider rate limit exceeded. Please try again shortly."),
      "transient",
    ],
    [
      "Kilo: forbidden by firewall",
      "opencode",
      opencode(`Forbidden: {"error":{"code":"403","message":"Forbidden","id":"fra1::abc"}}`),
      "other",
    ],
    ["Kilo: prompt failed", "opencode", opencode("Kilo prompt failed"), "other"],
  ]);
});

describe("Cline", () => {
  const cline = (message: string) => rpc(-32603, `Internal error: ${message}`, { message });
  runErrors([
    [
      "Cline: 5-hour ClinePass limit",
      "cline",
      cline(
        "You have reached your 5-hour Clinepass limit. The limit resets in 5h, please try again later.",
      ),
      "usage_limit",
      NOW + 5 * HOUR,
    ],
    [
      "Cline: daily free limit",
      "cline",
      cline(
        "Error: Error 429: Daily free limit reached on model deepseek/deepseek-v4-flash. Try again in 23h 59m",
      ),
      "usage_limit",
      NOW + 23 * HOUR + 59 * MIN,
    ],
    ["Cline: not enough credits", "cline", cline("Not enough credits available"), "billing"],
    [
      "Cline: zero balance",
      "cline",
      cline("Insufficient balance. Your Cline credits balance is $0.00."),
      "billing",
    ],
    [
      "Cline: no ClinePass access",
      "cline",
      cline(
        "No access to ClinePass subscription models yet. Subscribe to ClinePass, then try again.",
      ),
      "billing",
    ],
    [
      "Cline: ClinePass on an org account",
      "cline",
      cline(
        "Organization accounts cannot use ClinePass subscriptions. Switch to a personal account.",
      ),
      "billing",
    ],
    [
      "Cline: not subscribed to the model plan",
      "cline",
      rpc(
        -32000,
        "Authentication required: Error 403: the user is not subscribed to required model plan",
        {
          message: "Error 403: the user is not subscribed to required model plan",
        },
      ),
      "billing",
    ],
    [
      "Cline: retries ended in 503",
      "cline",
      cline("Failed after 6 attempts. Last error: 503 Service Unavailable"),
      "transient",
    ],
    [
      "Cline: output token limit",
      "cline",
      cline("Model reached the maximum output token limit before completing the turn"),
      "other",
    ],
    ["Cline: empty response", "cline", cline("Model returned empty response"), "transient"],
    ["Cline: unknown session", "cline", details("unknown session: s1"), "session_lost"],
    ["Cline: resource not found", "cline", rpc(-32002, "Resource not found: s1"), "session_lost"],
  ]);
});

describe("goose", () => {
  const goose = (text: string) =>
    `Ran into this error: ${text}\n\nPlease retry if you think this is a transient or recoverable error.`;

  describe("turn ends", () => {
    runTurnEnds([
      [
        "goose: tokens per day",
        "goose",
        goose(
          "Rate limit exceeded: Your account org-1 <ak-1> request reached organization TPD rate limit, current: 1510192, limit: 1500000.",
        ),
        "end_turn",
        "usage_limit",
      ],
      [
        "goose: requests per minute",
        "goose",
        goose(
          "Rate limit exceeded: Your account org-1<ak-1> request reached organization max RPM: 20, please try again after 1 seconds.",
        ),
        "end_turn",
        "none",
      ],
      [
        "goose: input tokens per minute",
        "goose",
        goose(
          "Rate limit exceeded: This request would exceed your organization’s rate limit of 80,000 input tokens per minute.",
        ),
        "end_turn",
        "none",
      ],
      [
        "goose: Bedrock server error",
        "goose",
        goose("Server error: Failed to call Bedrock: ValidationException(x)."),
        "end_turn",
        "none",
      ],
    ]);
  });

  describe("errors", () => {
    runErrors([
      [
        "goose: credits exhausted",
        "goose",
        rpc(-32603, "Internal error", { reason: "credits_exhausted", url: "https://x" }),
        "billing",
      ],
      ["goose: authentication", "goose", rpc(-32000, "Authentication required"), "auth"],
      ["goose: resource not found", "goose", rpc(-32002, "Resource not found"), "session_lost"],
    ]);
  });
});

describe("Mistral Vibe", () => {
  runErrors([
    [
      "Vibe: context too long",
      "vibe",
      rpc(
        -31004,
        "Context too long for mistral (model: m). Use /rewind to undo recent actions, then /compact to summarize.",
      ),
      "context",
    ],
    [
      "Vibe: invalid key",
      "vibe",
      rpc(
        -31002,
        "API error from mistral (model: m): Invalid API key. Please check your API key and try again.",
      ),
      "not_recoverable",
    ],
    [
      "Vibe: backend read error",
      "vibe",
      rpc(
        -32603,
        "API error from mistral (model: m): LLM backend error [mistral]\n  status: N/A\n  reason: ReadError('')",
      ),
      "transient",
    ],
    ["Vibe: session not found", "vibe", rpc(-32602, "Session not found: s1"), "session_lost"],
    ["Vibe: conversation limit", "vibe", rpc(-31003, "Conversation limit reached"), "other"],
  ]);
});

describe("fast-agent", () => {
  const failed = (text: string) =>
    `I hit an internal error while calling the model: ${text}. See fast-agent-error for additional details.`;

  describe("turn ends", () => {
    runTurnEnds([
      [
        "fast-agent: Codex plan limit with reset",
        "fast-agent",
        failed(
          `codexplan request failed for model 'gpt-5' (status=429): Error code: 429 - {'error': {'type': 'usage_limit_reached', 'plan_type': 'plus', 'resets_at': ${NOW / 1000 + 3 * 3600}}}`,
        ),
        "refusal",
        "usage_limit",
        NOW + 3 * HOUR,
      ],
      [
        "fast-agent: plain 429",
        "fast-agent",
        failed(
          "openai request failed for model 'gpt-4o' (status=429): Error code: 429 - {'error': {'message': 'Rate limit reached for requests'}}",
        ),
        "refusal",
        "none",
      ],
      [
        "fast-agent: insufficient quota",
        "fast-agent",
        failed(
          "openai request failed for model 'gpt-4o' (code: insufficient_quota) (status=429): Error code: 429 - {'error': {'code': 'insufficient_quota', 'message': 'You exceeded your current quota'}}",
        ),
        "refusal",
        "billing",
      ],
    ]);
  });

  describe("errors", () => {
    runErrors([
      [
        "fast-agent: Codex sign-in missing",
        "fast-agent",
        rpc(-32000, "Authentication required", { message: "Codex OAuth token not configured" }),
        "not_recoverable",
      ],
    ]);
  });
});

describe("Junie and Cortex Code", () => {
  describe("errors", () => {
    runErrors([
      [
        "Junie: provider rate limiting",
        "junie",
        rpc(
          -32011,
          "The model provider is temporarily unavailable due to rate limiting. Retry later or switch models.",
          { reason: "rate_limit_exceeded" },
        ),
        "transient",
      ],
      [
        "Junie: insufficient balance",
        "junie",
        rpc(-32010, "Insufficient account balance. All tokens in your account have been spent.", {
          reason: "insufficient_account_balance",
        }),
        "billing",
      ],
      [
        "Junie: authentication",
        "junie",
        rpc(-32000, "Authentication is required before this operation can be performed."),
        "auth",
      ],
    ]);
  });

  describe("turn ends", () => {
    const DAILY =
      "Daily credit usage limit reached. Your estimated usage has exceeded the configured limit for this surface. Please try again later or contact your account administrator to adjust your limit.";
    runTurnEnds([
      ["Cortex: daily credit limit", "cortex", DAILY, "end_turn", "usage_limit"],
      [
        "Cortex: daily credit limit in an API error",
        "cortex",
        `\nError: Error: API error 429:\n${DAILY}`,
        "end_turn",
        "usage_limit",
      ],
      [
        "Cortex: daily credit limit after an error prefix",
        "cortex",
        `\nError: ${DAILY}`,
        "end_turn",
        "usage_limit",
      ],
      [
        "Cortex: other 429",
        "cortex",
        "\nError: Error: API error 429:\nToo many requests",
        "end_turn",
        "none",
      ],
    ]);
  });
});

describe("Autohand", () => {
  const exited = (lines: string) => `\n> **Error:** Autohand exited with code 1\n${lines}`;

  describe("turn ends", () => {
    runTurnEnds([
      [
        "Autohand: weekly quota",
        "autohand",
        exited(
          "> Autohand AI weekly request quota reached.\n> Your current request quota is exhausted.\n> Resets Oct 8, 2026 (Asia/Karachi) · in 1d 2h 3m.\n> Upgrade your Autohand Code plan for more usage: https://console.autohand.ai/billing\n",
        ),
        "end_turn",
        "usage_limit",
        NOW + DAY + 2 * HOUR + 3 * MIN,
      ],
      [
        "Autohand: 5-hour quota, reset unknown",
        "autohand",
        exited(
          "> Autohand AI 5-hour request quota reached.\n> Your current request quota is exhausted.\n> Reset time is temporarily unavailable. Run /usage to refresh your quota.\n",
        ),
        "end_turn",
        "usage_limit",
      ],
      [
        "Autohand: rate limit",
        "autohand",
        exited(
          "> Rate limit exceeded. Please wait a moment and try again, or choose a different model.\n",
        ),
        "end_turn",
        "none",
      ],
      [
        "Autohand: token throughput",
        "autohand",
        exited("> Your token throughput is exhausted for this minute.\n"),
        "end_turn",
        "none",
      ],
      [
        "Autohand: payment required",
        "autohand",
        exited("> Payment required. Please check your account balance or billing settings.\n"),
        "end_turn",
        "billing",
      ],
      [
        "Autohand: conversation too long",
        "autohand",
        exited(
          "> The conversation is too long for this model. Try /undo to remove recent turns or /new to start fresh.\n",
        ),
        "end_turn",
        "none",
      ],
    ]);
  });

  describe("errors", () => {
    runErrors([
      [
        "Autohand: unknown session",
        "autohand",
        rpc(-32602, "Invalid params", { message: "Unknown session id." }),
        "session_lost",
      ],
      [
        "Autohand: not logged in",
        "autohand",
        rpc(-32000, "Authentication required", { message: "Please log in to use Autohand" }),
        "auth",
      ],
    ]);
  });
});

describe("agents on the generic rules", () => {
  runErrors([
    [
      "Minion Code: not signed in",
      "generic",
      rpc(-32000, "Authentication required", { message: "Please sign in to use Minion Code." }),
      "auth",
    ],
    [
      "Nova: no API keys",
      "generic",
      rpc(-32000, "Click Nova Setup to configure your API keys"),
      "auth",
    ],
    ["Nova: session not found", "generic", rpc(-32601, "Session not found: s1"), "session_lost"],
    [
      "Nova: token quota until a time",
      "generic",
      rpc(-32603, "Aggregate token quota exhausted. Quota resets at 2026-10-07T00:00:00Z."),
      "usage_limit",
      utc(2026, 9, 7),
    ],
    [
      "Kimchi: token expired",
      "generic",
      rpc(
        -32000,
        "Authentication required: token expired: auth required. Call session/authenticate to log in again, then retry.",
        { kind: "auth" },
      ),
      "auth",
    ],
    [
      "Kimchi: rate limited for minutes",
      "generic",
      rpc(
        -32603,
        "Internal error: kimi-k2 is rate limited until 2026-10-06T09:05:00Z (5m) — not retrying. Switch model with /model, or top up at https://app.kimchi.dev/billing",
        { kind: "rate_limit", retryAtMs: NOW + 5 * MIN },
      ),
      "transient",
    ],
    [
      "Kimchi: rate limited for hours",
      "generic",
      rpc(
        -32603,
        "Internal error: kimi-k2 is rate limited until 2026-10-06T11:00:00Z (2h) — not retrying. Switch model with /model, or top up at https://app.kimchi.dev/billing",
        { kind: "rate_limit", retryAtMs: NOW + 2 * HOUR },
      ),
      "usage_limit",
      NOW + 2 * HOUR,
    ],
    [
      "Kimchi: budget exhausted",
      "generic",
      rpc(-32603, "Internal error: budget exhausted for this account", {
        kind: "budget_exhausted",
        httpStatusCode: 402,
      }),
      "billing",
    ],
    [
      "Kimchi: budget exhausted, cleaned-up text",
      "generic",
      rpc(
        -32603,
        "Internal error: The request could not be completed (budget exhausted). Please retry your request.",
        { kind: "budget_exhausted" },
      ),
      "billing",
    ],
    [
      "Kimchi: context window",
      "generic",
      rpc(-32603, "Internal error: context too long", { kind: "context_window_exceeded" }),
      "context",
    ],
    ["Kimchi: unknown session", "generic", rpc(-32602, "unknown sessionId s1"), "session_lost"],
    [
      "DimCode: session not found",
      "generic",
      rpc(-32002, "ACP session not found: s1"),
      "session_lost",
    ],
    [
      "DimCode: prompt already running",
      "generic",
      rpc(-32603, "Internal error: ACP session already has an active prompt"),
      "other",
    ],
    [
      "DimCode: provider rate limit",
      "generic",
      details("Rate limit exceeded for openai: Too many requests"),
      "transient",
    ],
    [
      "Dirac: Cerebras rate limit",
      "generic",
      details("Cerebras API rate limit exceeded."),
      "transient",
    ],
    [
      "siGit: monthly cloud allowance",
      "generic",
      rpc(
        -32603,
        "Monthly siGit Code Cloud allowance reached. It resets at the start of your next billing period.",
      ),
      "usage_limit",
    ],
    [
      "siGit: endpoint returned 429",
      "generic",
      rpc(-32603, "endpoint returned 429 Too Many Requests"),
      "transient",
    ],
    [
      "siGit: unknown session",
      "generic",
      rpc(-32602, "unknown session s1; create it with session/new or restore it with session/load"),
      "session_lost",
    ],
    [
      "Stakpak: insufficient credits",
      "generic",
      details(
        `Stream processing failed: Stream error: Unknown("Bad Request: InvalidAgentInput(\\"Provider error: Insufficient credits. Please top up your Stakpak account at https://app.stakpak.dev/settings/billing. Balance is 0\\")")`,
      ),
      "billing",
    ],
    [
      "Stakpak: rate limited",
      "generic",
      rpc(
        -32603,
        "Internal error",
        `Stream processing failed: Stream error: Unknown("Bad Request: InvalidAgentInput(\\"Provider error: Rate limited. Please wait a moment and try again. Too many requests\\")")`,
      ),
      "transient",
    ],
    [
      "Stakpak: copilot too many requests",
      "generic",
      rpc(
        -32603,
        "Internal error",
        "Chat completion failed: Our copilot is handling too many requests at this time, please try again later.",
      ),
      "transient",
    ],
    [
      "VT Code: unknown session",
      "generic",
      rpc(-32602, "Invalid params", { reason: "unknown_session" }),
      "session_lost",
    ],
    [
      "Harn: rate limited",
      "generic",
      rpc(-32000, "openai HTTP 429 [rate_limited]: Rate limit reached (retry-after: 20)", {
        schema: "harn.acp.prompt_error.v1",
        terminalClass: "rate_limited",
        retryable: true,
        retryAfterMs: 20000,
      }),
      "transient",
    ],
    [
      "Harn: provider billing",
      "generic",
      rpc(-32000, "openai HTTP 429 [billing_limit]: You exceeded your current quota", {
        schema: "harn.acp.prompt_error.v1",
        terminalClass: "provider_billing",
        retryable: false,
      }),
      "billing",
    ],
    [
      "Harn: context overflow",
      "generic",
      rpc(-32000, "anthropic HTTP 400 [context_overflow]: prompt is too long", {
        schema: "harn.acp.prompt_error.v1",
        terminalClass: "context_overflow",
      }),
      "context",
    ],
    [
      "Harn: provider unavailable",
      "generic",
      rpc(-32000, "openai HTTP 503: unavailable", { terminalClass: "provider_unavailable" }),
      "transient",
    ],
    [
      "Harn: provider misconfigured",
      "generic",
      rpc(-32000, "missing key", { terminalClass: "provider_misconfigured" }),
      "not_recoverable",
    ],
    ["Harn: unknown session", "generic", rpc(-32602, "Unknown session: s1"), "session_lost"],
    [
      "Corust: token limit",
      "generic",
      details(
        "You may have reached your token limit. Use `/subscribe` to view pricing plans and upgrade your quota.",
      ),
      "usage_limit",
    ],
    [
      "Agoragentic: method not found",
      "generic",
      rpc(-32601, "Method not found: session/prompt"),
      "other",
    ],
    [
      "DeepAgents: provider package missing",
      "generic",
      details(
        "Unable to import @langchain/anthropic. Please install with `npm install @langchain/anthropic` or `pnpm install @langchain/anthropic`",
      ),
      "not_recoverable",
    ],
    [
      "DeepAgents: invalid key",
      "generic",
      details(
        `401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_AUTHENTICATION/\n`,
      ),
      "not_recoverable",
    ],
    [
      "DeepAgents: per-minute rate limit",
      "generic",
      details(
        `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50,000 input tokens per minute."}}\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/\n`,
      ),
      "transient",
    ],
    ["DeepAgents: session not found", "generic", details("Session not found: s1"), "session_lost"],
    [
      "pi: configure a key",
      "generic",
      rpc(-32000, "Configure an API key or log in with an OAuth provider.", { authMethods: [] }),
      "auth",
    ],
    ["pi: unknown session", "generic", rpc(-32602, "Unknown sessionId: s1"), "session_lost"],
    [
      "pi: ChatGPT usage limit",
      "generic",
      rpc(-32603, "You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min."),
      "usage_limit",
      NOW + 120 * MIN,
    ],
    [
      "pi: context overflow",
      "generic",
      rpc(
        -32603,
        "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
      ),
      "context",
    ],
    [
      "Poolside: daily limit",
      "generic",
      rpc(-32603, "Internal error", {
        error: "Daily limit exceeded. Usage limit resets in 5 hours. API Response: {}",
      }),
      "usage_limit",
      NOW + 5 * HOUR,
    ],
    [
      "Poolside: usage limit",
      "generic",
      rpc(-32603, "Internal error", { error: "Usage limit exceeded" }),
      "usage_limit",
    ],
    [
      "Poolside: rate limit",
      "generic",
      rpc(-32603, "Internal error", { error: "Rate limit exceeded" }),
      "transient",
    ],
    [
      "Poolside: context window",
      "generic",
      rpc(-32603, "Internal error", { error: "context window exceeded: 210000 > 200000" }),
      "context",
    ],
    [
      "Poolside: server error",
      "generic",
      rpc(-32603, "Internal error", { error: "API request failed with status 500: boom" }),
      "other",
    ],
    [
      "TypeScript SDK: 429 in details",
      "generic",
      details("429 Too Many Requests: Rate limit reached for requests"),
      "transient",
    ],
    [
      "Rust SDK: rate limit as string data",
      "generic",
      rpc(-32603, "Internal error", "Rate limit exceeded"),
      "transient",
    ],
    [
      "Python SDK: 402 insufficient credits",
      "generic",
      details("Error code: 402 - insufficient credits"),
      "billing",
    ],
  ]);
});
