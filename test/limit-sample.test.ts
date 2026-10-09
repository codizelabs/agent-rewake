import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { issueUrl, readSample, redactSample, renderSample } from "../src/limit-sample.js";

// `agent-rewake doctor --limit-sample "<text>"`: a dry run of Rewake's rules on a message a person
// copied from their agent, and a link they can open themselves. Nothing is sent or opened.
const NOW = Date.UTC(2026, 7, 20, 14, 0);
const HOME = "/Users/someone";

afterEach(() => vi.restoreAllMocks());

describe("redactSample", () => {
  it("removes keys, email addresses, terminal colours and the home folder, line by line", () => {
    const text = `\u001b[31mYou've hit your limit\u001b[0m, ${HOME}/work\nmail me@example.com token=abc123 sk-abcdefghijkl1234`;
    const out = redactSample(text, HOME);
    expect(out).toContain("You've hit your limit, ~/work");
    expect(out).not.toMatch(/me@example\.com|abc123|sk-abcdefghijkl1234/);
    expect(out).not.toContain(String.fromCharCode(27));
    expect(out).not.toContain(HOME);
  });

  it("keeps at most five lines of at most 200 characters", () => {
    const out = redactSample(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"), HOME);
    expect(out.split("\n")).toHaveLength(5);
    expect(redactSample("x ".repeat(300), HOME).length).toBeLessThanOrEqual(200);
  });
});

describe("readSample", () => {
  it("shows which agents read a text as a limit, and when it resets", () => {
    const r = readSample("Claude usage limit reached. Your limit will reset at 3pm (UTC).", NOW);
    expect(r.get("Claude")).toEqual({ read: "limit", resetsAt: Date.UTC(2026, 7, 20, 15, 0) });
  });

  it("shows billing and short waits apart from limits", () => {
    expect(
      readSample("Insufficient credits. Add credits to continue.", NOW).get("OpenCode"),
    ).toEqual({ read: "billing" });
    expect(readSample("Membership expired, please renew your plan", NOW).get("Kimi")).toEqual({
      read: "billing",
    });
  });

  it("reads Codex's text the way its session file is read", () => {
    expect(
      readSample("Your workspace is out of credits. Add credits to continue.", NOW).get("Codex"),
    ).toEqual({
      read: "billing",
    });
  });
});

describe("renderSample", () => {
  it("prints the redacted text, how Rewake reads it, and one link", () => {
    const out = renderSample(`Free usage exceeded, subscribe to Go ${HOME}`, NOW, HOME);
    expect(out).toContain("nothing was sent anywhere");
    expect(out).toContain("  Free usage exceeded, subscribe to Go ~");
    expect(out).toContain("A usage limit with no reset time (you pick when to continue): ");
    expect(out).toMatch(/OpenCode/);
    expect(out).not.toContain(HOME);
    expect(out.match(/https:\/\/github\.com\//g)).toHaveLength(1);
  });

  it("says when no agent reads the text as a usage limit", () => {
    const out = renderSample("The build failed: missing semicolon", NOW, HOME);
    expect(out).toContain("Rewake doesn't read this as a usage limit.");
    expect(out).not.toContain("A usage limit");
  });

  it("keeps the link well under 8,000 characters even for the longest, most symbol-heavy text", () => {
    const out = renderSample(
      Array.from({ length: 9 }, () => "·%&=?#".repeat(40)).join("\n"),
      NOW,
      HOME,
    );
    const url = /https:\/\/\S+/.exec(out)?.[0] ?? "";
    expect(url.length).toBeGreaterThan(100);
    expect(url.length).toBeLessThan(8000);
  });

  it("returns nothing for an empty text", () => {
    expect(renderSample("   ", NOW, HOME)).toBe("");
  });
});

describe("issueUrl", () => {
  it("is a link to the project's limit-text form with only the redacted text and the reading", () => {
    const url = new URL(issueUrl("a limit text", "Claude: a usage limit"));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/codizelabs/agent-rewake/issues/new",
    );
    expect(url.searchParams.get("template")).toBe("limit_text.yml");
    expect(url.searchParams.get("text")).toBe("a limit text");
    expect(url.searchParams.get("reading")).toBe("Claude: a usage limit");
    expect([...url.searchParams.keys()].sort()).toEqual(
      ["reading", "template", "text", "title", "version"].sort(),
    );
  });
});

describe("agent-rewake doctor --limit-sample", () => {
  const run = async (argv: string[]) => {
    let out = "";
    let err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out += String(s);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      err += String(s);
      return true;
    });
    const code = await main(argv, { AGENT_REWAKE_STATE_DIR: "/nonexistent-rewake-test" });
    return { code, out, err };
  };

  it("reads the words after the flag, even unquoted, and exits 0", async () => {
    const r = await run([
      "doctor",
      "--limit-sample",
      "Free",
      "usage",
      "exceeded,",
      "subscribe",
      "to",
      "Go",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Free usage exceeded, subscribe to Go");
    expect(r.out).toContain(
      "https://github.com/codizelabs/agent-rewake/issues/new?template=limit_text.yml",
    );
  });

  it("explains how to give the message when there is none", async () => {
    const r = await run(["doctor", "--limit-sample"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('doctor --limit-sample "<the message your agent showed>"');
    expect(r.out).toBe("");
  });
});
