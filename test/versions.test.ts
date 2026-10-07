import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_VERSIONS, newerThanTested, tooOld, untestedText } from "../src/hosts/versions.js";

const PACKAGES: Record<string, string> = {
  "claude-code": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  "gemini-cli": "@google/gemini-cli",
  grok: "@xai-official/grok",
};

describe("agent versions", () => {
  it("names as tested exactly the versions the contract tests pin", () => {
    const pinned = (
      JSON.parse(readFileSync("test/agents/package.json", "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;
    for (const [id, v] of Object.entries(AGENT_VERSIONS)) {
      const pkg = PACKAGES[id];
      expect(v?.tested, id).toBe(pkg ? pinned[pkg] : undefined);
    }
  });

  it("never tests below the minimum", () => {
    for (const [id, v] of Object.entries(AGENT_VERSIONS))
      if (v?.tested) expect(tooOld(id as keyof typeof AGENT_VERSIONS, v.tested), id).toBe(false);
  });

  it("tells older, tested and newer versions apart, and leaves unknown ones alone", () => {
    expect(tooOld("claude-code", "2.1.282")).toBe(true);
    expect(tooOld("claude-code", "2.1.287")).toBe(false);
    expect(tooOld("claude-code", undefined)).toBe(false);
    expect(newerThanTested("claude-code", "2.1.292")).toBe(false);
    expect(newerThanTested("claude-code", "2.1.300")).toBe(true);
    expect(newerThanTested("claude-code", undefined)).toBe(false);
    // Copilot has no real program under test yet: no claim either way.
    expect(newerThanTested("copilot-cli", "9.9.9")).toBe(false);
    expect(tooOld("antigravity", "0.0.1")).toBe(false);
  });

  it("says which version was tested and what to do", () => {
    expect(untestedText("codex", "0.170.0")).toBe(
      "Codex 0.170.0 is newer than the versions Rewake was tested with (up to 0.160.1). It should still work; if Rewake misses a usage limit there, report it with agent-rewake doctor --details.",
    );
  });
});
