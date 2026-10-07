import { describe, expect, it } from "vitest";
import { recognise } from "../src/core/limits/recognise.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const H = 3_600_000;

describe("recognise: one way in for every agent (plan §3.4)", () => {
  it("Copilot: the same text reads the same from Zed and from its terminal hook", () => {
    const text =
      "You've reached your weekly rate limit. Please wait for your limit to reset in 2 hours.";
    const hook = recognise({ agent: "copilot", source: "hook", text }, NOW);
    const zed = recognise({ agent: "copilot", source: "acp-error", text: `Error: ${text}` }, NOW);
    expect(hook).toMatchObject({ isUsageLimit: true, isBilling: false, confidence: "text" });
    expect(hook?.resetsAt).toBe(NOW + 2 * H);
    expect(zed?.isUsageLimit).toBe(true);
    // Recovered errors and other errors aren't limits.
    expect(
      recognise({ agent: "copilot", source: "hook", text, recovered: true }, NOW),
    ).toBeUndefined();
    expect(
      recognise({ agent: "copilot", source: "hook", text: "Network error" }, NOW),
    ).toBeUndefined();
  });

  it("billing is never a usage limit", () => {
    expect(
      recognise(
        { agent: "copilot", source: "hook", text: "You've run out of your AI credits." },
        NOW,
      ),
    ).toMatchObject({ isUsageLimit: false, isBilling: true });
  });

  it("Grok: the reset from its billing log is structured; without it, a guess (the person picks)", () => {
    const signal = {
      agent: "grok",
      source: "hook" as const,
      code: "invalid_request",
      text: "402 Payment Required You hit your weekly limit.",
    };
    expect(
      recognise({ ...signal, period: { full: true, seen: true, resetsAt: NOW + 50 * H } }, NOW),
    ).toMatchObject({ window: "weekly", resetsAt: NOW + 50 * H, confidence: "structured" });
    expect(recognise(signal, NOW)).toMatchObject({ window: "weekly", confidence: "guess" });
  });

  it("Gemini and Antigravity read their reset from the text", () => {
    expect(
      recognise(
        {
          agent: "gemini",
          source: "session-file",
          text: "[API Error: RESOURCE_EXHAUSTED … reset after 2h0m0s]",
        },
        NOW,
      ),
    ).toMatchObject({ isUsageLimit: true, resetsAt: NOW + 2 * H, confidence: "text" });
    expect(
      recognise(
        {
          agent: "antigravity",
          source: "hook",
          code: "error",
          text: "Individual quota reached. Resets in 1h0m0s",
        },
        NOW,
      ),
    ).toMatchObject({ isUsageLimit: true, resetsAt: NOW + H, confidence: "text" });
  });

  it("an agent it has no rules for gives nothing", () => {
    expect(
      recognise({ agent: "someone-new", source: "hook", text: "rate limit" }, NOW),
    ).toBeUndefined();
  });
});
