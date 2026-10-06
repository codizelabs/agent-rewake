import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE_LIMIT_ERROR_PREFIXES as SDK_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyPromptError,
  parseResetText,
  USAGE_LIMIT_ERROR_PREFIXES,
  zonedToEpoch,
} from "../src/adapters/claude/limits.js";
import {
  claudeAutoContinueDisabled,
  encodeProjectDir,
  resetFromTranscript,
} from "../src/adapters/claude/sources.js";

const limitError = (text: string, errorKind = "rate_limit") => ({
  code: -32603,
  message: `Internal error: ${text}`,
  data: { errorKind },
});

describe("contract with the Claude Agent SDK", () => {
  it("vendors exactly the SDK's USAGE_LIMIT_ERROR_PREFIXES", () => {
    expect([...USAGE_LIMIT_ERROR_PREFIXES]).toEqual([...SDK_PREFIXES]);
  });
});

describe("classifyPromptError", () => {
  it("recognises a session usage limit", () => {
    expect(
      classifyPromptError(
        limitError("You've hit your session limit · resets 4:50pm (Europe/Samara)"),
      ),
    ).toMatchObject({
      kind: "usage_limit",
      limitType: "session",
    });
    expect(
      classifyPromptError(limitError("You've hit your weekly limit · resets Mon 12:00am")),
    ).toMatchObject({
      kind: "usage_limit",
      limitType: "weekly",
    });
  });

  it("treats credit, spend and billing limits as not fixed by waiting", () => {
    expect(classifyPromptError(limitError("You're out of usage credits")).kind).toBe(
      "not_recoverable",
    );
    expect(classifyPromptError(limitError("You've hit your org's monthly spend limit")).kind).toBe(
      "not_recoverable",
    );
    expect(classifyPromptError(limitError("anything", "billing_error")).kind).toBe(
      "not_recoverable",
    );
  });

  it("treats a rate limit without limit text as transient", () => {
    expect(classifyPromptError(limitError("Server is temporarily limiting requests")).kind).toBe(
      "transient",
    );
    expect(classifyPromptError(limitError("Overloaded", "overloaded")).kind).toBe("transient");
  });

  it("recognises a lost session", () => {
    expect(
      classifyPromptError({
        code: -32603,
        message: "Internal error",
        data: { details: "Session not found" },
      }).kind,
    ).toBe("session_lost");
  });

  it("never classifies prose without the adapter's errorKind as a limit", () => {
    expect(
      classifyPromptError({ code: -32603, message: "You've hit your session limit · resets 3pm" })
        .kind,
    ).toBe("other");
  });
});

describe("parseResetText", () => {
  it("resolves a time in the named zone to the next occurrence", () => {
    const after = zonedToEpoch(2026, 9, 4, 10, 0, "Asia/Karachi");
    const r = parseResetText("You've hit your session limit · resets 5:40pm (Asia/Karachi)", after);
    expect(r).toEqual({
      resetAt: zonedToEpoch(2026, 9, 4, 17, 40, "Asia/Karachi"),
      confidence: "medium",
    });
  });

  it("rolls over to tomorrow when the time has passed", () => {
    const after = zonedToEpoch(2026, 9, 4, 18, 0, "Asia/Karachi");
    const r = parseResetText("resets 5:40pm (Asia/Karachi)", after);
    expect(r?.resetAt).toBe(zonedToEpoch(2026, 9, 5, 17, 40, "Asia/Karachi"));
  });

  it("handles weekday and month-day forms", () => {
    const after = zonedToEpoch(2026, 9, 4, 12, 0, "UTC"); // Sunday 4 Oct 2026
    expect(parseResetText("resets Mon 12:00am (UTC)", after)?.resetAt).toBe(
      zonedToEpoch(2026, 9, 5, 0, 0, "UTC"),
    );
    expect(parseResetText("resets Oct 21 at 3pm (UTC)", after)?.resetAt).toBe(
      zonedToEpoch(2026, 9, 21, 15, 0, "UTC"),
    );
  });

  it("returns undefined when there's no reset time", () => {
    expect(parseResetText("You're out of usage credits", Date.now())).toBeUndefined();
  });
});

describe("Claude sources", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewake-claude-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const env = () => ({ CLAUDE_CONFIG_DIR: dir });

  it("reads quotaLimits.resetsAt from the newest limit record in the transcript", () => {
    const cwd = "/Users/me/my project";
    const proj = join(dir, "projects", encodeProjectDir(cwd));
    mkdirSync(proj, { recursive: true });
    const records = [
      { type: "user", timestamp: "2026-10-04T10:00:00Z", message: { content: "secret stuff" } },
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "rate_limit",
        timestamp: "2026-10-04T10:01:00Z",
        quotaLimits: { status: "rejected", resetsAt: 1789476000, rateLimitType: "five_hour" },
      },
    ];
    writeFileSync(join(proj, "s-1.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
    expect(resetFromTranscript(env(), cwd, "s-1", Date.parse("2026-10-04T10:00:30Z"))).toEqual({
      resetAt: 1789476000 * 1000,
      rateLimitType: "five_hour",
    });
    // A limit record from before this turn belongs to an older episode.
    expect(
      resetFromTranscript(env(), cwd, "s-1", Date.parse("2026-10-04T12:00:00Z")),
    ).toBeUndefined();
  });

  it("honours Claude's autoContinueAtUsageLimit off-switch from user or project settings", () => {
    expect(claudeAutoContinueDisabled(env(), "")).toBe(false);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ autoContinueAtUsageLimit: false }));
    expect(claudeAutoContinueDisabled(env(), "")).toBe(true);
    rmSync(join(dir, "settings.json"));
    const project = join(dir, "proj");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "settings.local.json"),
      JSON.stringify({ autoContinueAtUsageLimit: false }),
    );
    expect(claudeAutoContinueDisabled(env(), project)).toBe(true);
  });
});
