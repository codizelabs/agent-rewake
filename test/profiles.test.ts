import { describe, expect, it } from "vitest";
import { classifyLimit, parseResetHint, profileFor } from "../src/adapters/profiles.js";

// Error shapes from the agents' own code.
const NOW = new Date(2026, 9, 4, 14, 0, 0, 0).getTime(); // Sunday 4 Oct 2026, 14:00 local
const HOUR = 3_600_000;

describe("which profile an agent gets", () => {
  it("goes by the agent's id in Zed first, then by the name it reports", () => {
    expect(profileFor("claude-acp", "anything")).toBe("claude");
    expect(profileFor("codex-acp", "@agentclientprotocol/codex-acp")).toBe("codex");
    expect(profileFor("gemini", "gemini-cli")).toBe("gemini");
    expect(profileFor("my-codex", "codex-acp")).toBe("codex");
    expect(profileFor(undefined, "@agentclientprotocol/claude-agent-acp")).toBe("claude");
    expect(profileFor("opencode", "OpenCode")).toBe("opencode");
    expect(profileFor("some-new-agent", "Some Agent")).toBe("generic");
    // The registry's second Copilot entry (the language server), and agents added under a custom id.
    expect(profileFor("github-copilot", "GitHub Copilot")).toBe("copilot");
    expect(profileFor("my-agy", "Antigravity")).toBe("antigravity");
    expect(profileFor("my-copilot", "GitHub Copilot CLI")).toBe("copilot");
    expect(profileFor("my-grok", "Grok Build")).toBe("grok");
  });
});

describe("usage limits, by agent", () => {
  it("Codex: usageLimitExceeded, with the reset time from its own text", () => {
    const c = classifyLimit(
      "codex",
      {
        code: -32603,
        message: "Internal error",
        data: {
          message: "You've hit your usage limit. Upgrade to Pro or try again at 6:34 PM.",
          codexErrorInfo: "usageLimitExceeded",
        },
      },
      NOW,
    );
    expect(c).toMatchObject({ kind: "usage_limit" });
    expect(c.kind === "usage_limit" && c.resetAt).toBe(NOW + 4 * HOUR + 34 * 60_000);

    const later = classifyLimit(
      "codex",
      {
        code: -32603,
        message: "Internal error",
        data: {
          message: "You've hit your usage limit. Try again at Oct 6th, 2026 9:25 AM.",
          codexErrorInfo: "usageLimitExceeded",
        },
      },
      NOW,
    );
    expect(later.kind === "usage_limit" && later.resetAt).toBe(
      new Date(2026, 9, 6, 9, 25).getTime(),
    );
  });

  it("Codex: short-term and budget errors aren't the plan limit", () => {
    const err = (kind: string) => ({
      code: -32603,
      message: "Internal error",
      data: { message: "x", codexErrorInfo: kind },
    });
    expect(classifyLimit("codex", err("rateLimitExceeded"), NOW).kind).toBe("transient");
    expect(classifyLimit("codex", err("sessionBudgetExceeded"), NOW).kind).toBe("not_recoverable");
    expect(classifyLimit("codex", err("contextWindowExceeded"), NOW).kind).toBe("not_recoverable");
  });

  it("Gemini: code 429, with no reset time", () => {
    const c = classifyLimit(
      "gemini",
      { code: 429, message: "Rate limit exceeded. Try again later." },
      NOW,
    );
    expect(c).toEqual({
      kind: "usage_limit",
      text: "Rate limit exceeded. Try again later.",
      limitType: "other",
    });
  });

  it("other agents: a cautious match on the error message, never on anything else", () => {
    const copilot = classifyLimit(
      "generic",
      {
        code: -32603,
        message:
          "You've reached your weekly rate limit. Please wait for your limit to reset in 5 hours or switch to auto model to continue.",
      },
      NOW,
    );
    expect(copilot).toMatchObject({
      kind: "usage_limit",
      limitType: "weekly",
      resetAt: NOW + 5 * HOUR,
    });
    expect(
      classifyLimit(
        "generic",
        { code: -32603, message: "Quota exceeded: add credits to continue" },
        NOW,
      ).kind,
    ).toBe("not_recoverable");
    expect(
      classifyLimit("generic", { code: -32603, message: "Tool failed: ENOENT" }, NOW).kind,
    ).toBe("other");
    expect(
      classifyLimit("generic", { code: -32603, message: "Session not found: s-1" }, NOW).kind,
    ).toBe("session_lost");
  });

  it("Claude: unchanged, with the reset time from its text", () => {
    const c = classifyLimit(
      "claude",
      {
        code: -32603,
        message: "Internal error: You've hit your session limit · resets 5pm",
        data: { errorKind: "rate_limit" },
      },
      NOW,
    );
    expect(c).toMatchObject({ kind: "usage_limit", limitType: "session" });
    expect(c.kind === "usage_limit" && c.resetAt).toBe(NOW + 3 * HOUR);
  });
});

describe("reset times in any agent's words", () => {
  it("reads absolute and relative times", () => {
    expect(parseResetHint("Try again at 3:00 PM.", NOW)).toBe(NOW + HOUR);
    expect(parseResetHint("try again at 9:00 AM", NOW)).toBe(NOW + 19 * HOUR); // tomorrow
    expect(parseResetHint("Your limit resets in 2h 30m", NOW)).toBe(NOW + 2.5 * HOUR);
    expect(parseResetHint("try again in 45 minutes", NOW)).toBe(NOW + 45 * 60_000);
    expect(parseResetHint("Try again later.", NOW)).toBeUndefined();
  });
});
