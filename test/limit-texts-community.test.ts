import { describe, expect, it } from "vitest";
import {
  type AgentProfile,
  classifyLimit,
  type LimitClassification,
} from "../src/adapters/profiles.js";
import { parseResetHint } from "../src/adapters/reset.js";

/**
 * Limit messages that a community project (unsnooze 1.20.0, github.com/saaranshM/unsnooze) captured
 * or wrote tests for, and that Rewake read wrongly before. None of them is a capture from the agent
 * itself: where a source is only that project, the row says so. Each row names where the text is.
 */
const NOW = Date.UTC(2026, 7, 20, 14, 0);

const claude = (message: string) => ({
  code: -32603,
  message,
  data: { errorKind: "rate_limit" },
});
const plain = (message: string) => ({ code: -32603, message });

type Row = {
  name: string;
  source: string;
  profile: AgentProfile;
  error: { code: number; message: string; data?: unknown };
  kind: LimitClassification["kind"];
  reason?: "billing";
  resetAt?: number;
  /** When it happens (default 14:00 UTC). */
  now?: number;
};

const rows: Row[] = [
  {
    name: "Claude: the older banner, 'Your limit will reset at 3pm (UTC)'",
    source:
      "unsnooze test/model-limit.test.js:75 (the older Claude Code banner; no capture from Claude Code)",
    profile: "claude",
    error: claude("Claude usage limit reached. Your limit will reset at 3pm (UTC)."),
    kind: "usage_limit",
    resetAt: Date.UTC(2026, 7, 20, 15, 0),
  },
  {
    name: "Claude: the older banner after 3pm UTC waits for tomorrow's 3pm",
    source: "same text, run at 16:00 UTC",
    profile: "claude",
    error: claude("Claude usage limit reached. Your limit will reset at 3pm (UTC)."),
    kind: "usage_limit",
    resetAt: Date.UTC(2026, 7, 21, 15, 0),
    now: Date.UTC(2026, 7, 20, 16, 0),
  },
  {
    name: "Claude: a monthly limit that says when it resets is a limit to ask about",
    source: "unsnooze test/claude-real-banners.test.js:27 (a real banner they captured)",
    profile: "claude",
    error: claude("You've hit your monthly limit · resets Sep 1 at 12:00am"),
    kind: "usage_limit",
    resetAt: new Date(2026, 8, 1, 0, 0).getTime(),
  },
  {
    name: "Claude: a monthly limit with a date and no time is a limit with no reset time",
    source: "the same banner without its time (Rewake's own variation)",
    profile: "claude",
    error: claude("You've hit your monthly limit · resets Sep 1"),
    kind: "usage_limit",
  },
  {
    name: "Claude: a monthly limit with no reset anywhere stays billing",
    source: "unchanged behaviour: waiting can't be shown to help",
    profile: "claude",
    error: claude("You've hit your monthly limit"),
    kind: "not_recoverable",
    reason: "billing",
  },
  {
    name: "Kimi: membership expired is billing",
    source: "unsnooze src/agents/kimi.js terminalPatterns, test/kimi.test.js:42 (community only)",
    profile: "kimi",
    error: plain("LLM provider error: Membership expired, please renew your plan"),
    kind: "not_recoverable",
    reason: "billing",
  },
  {
    name: "Kimi: the 429 'too many requests' stays a short wait",
    source:
      "unchanged: Kimi's own error reference calls it a throttle (test/limit-corpus.test.ts); unsnooze alone says it is also the quota stop",
    profile: "kimi",
    error: plain(
      `LLM provider error: Error code: 429 - {'error': {'message': "We're receiving too many requests at the moment. Please wait a moment and try again.", 'type': 'rate_limit_reached_error'}}`,
    ),
    kind: "transient",
  },
  {
    name: "OpenCode: 'Free usage exceeded' is a usage limit with no reset time",
    source: "unsnooze src/agents/opencode.js and test/opencode.test.js:25 (community only)",
    profile: "opencode",
    error: plain("Free usage exceeded, subscribe to Go"),
    kind: "usage_limit",
  },
  {
    name: "OpenCode: the Go plan's 'usage limit reached. It will reset in 2 hours 5 minutes.'",
    source: "OpenCode source packages/opencode/src/session/retry.ts at anomalyco/opencode 055d95bb",
    profile: "opencode",
    error: plain(
      "Go usage limit reached. It will reset in 2 hours 5 minutes. To continue using this model now, enable usage from your available balance",
    ),
    kind: "usage_limit",
    resetAt: NOW + 125 * 60_000,
  },
  {
    name: "OpenCode: the Go plan's limit that resets in less than a minute",
    source: "OpenCode source packages/opencode/src/session/retry.ts at anomalyco/opencode 055d95bb",
    profile: "opencode",
    error: plain("Go usage limit reached. It will reset in less than a minute."),
    kind: "usage_limit",
    resetAt: NOW + 60_000,
  },
];

describe("limit messages from unsnooze that Rewake missed", () => {
  it.each(rows)("$name", ({ profile, error, kind, reason, resetAt, now }) => {
    const c = classifyLimit(profile, error, now ?? NOW);
    expect(c.kind).toBe(kind);
    if (reason) expect((c as { reason?: string }).reason).toBe(reason);
    if (resetAt !== undefined) expect(c.resetAt).toBe(resetAt);
    else expect(c.resetAt).toBeUndefined();
  });

  it("reads 'reset at 3pm' only with an am/pm time, so other agents' 'reset at' forms keep their readers", () => {
    expect(parseResetHint("Your limit will reset at 3pm (UTC).", NOW)).toBe(
      Date.UTC(2026, 7, 20, 15, 0),
    );
    // Z.AI's date-time form, Qwen's date form and a bare number are not Claude's clock.
    expect(
      parseResetHint("Your limit will reset at 2026-09-23 18:45:35", NOW, { zone: "UTC" }),
    ).toBe(Date.UTC(2026, 8, 23, 18, 45, 35));
    expect(parseResetHint("Your limit will reset at 5", NOW)).toBeUndefined();
  });
});
