import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyGrokFailure } from "../src/core/limits/agents.js";
import { grokLimitAgain, resumeGrok } from "../src/hosts/grok/host.js";

// Texts: xai-org/grok-build @2bdd1d6. The free-tier sentence is
// crates/codegen/xai-grok-shell/src/sampling/error.rs:33 (curly apostrophe, no "429" or "rate
// limit"); the 402 text is xai-grok-pager/src/app/dispatch/tests/billing.rs:569.
const FREE =
  "You’ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok?referrer=grok-build";
const BALANCE = "API error (status 402 Payment Required): Grok Build usage balance exhausted";
const SID = "01993c7e-5a4b-7c2d-9e8f-0a1b2c3d4e5f";

let dir: string;
let grok: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-grok-limits-")));
  grok = join(dir, "grok");
  mkdirSync(join(grok, "logs"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a Grok resume that hits the limit again", () => {
  it.each([
    [
      "the free-tier sentence on a JSON error line",
      `${JSON.stringify({ type: "error", message: FREE })}\n`,
      "",
    ],
    ["the free-tier sentence on stderr", "", `${FREE}\n`],
    ["the free-usage code", "", "API error (status 429): subscription:free-usage-exhausted: x\n"],
    ["a balance message with no status", "", "Grok Build usage balance exhausted\n"],
  ])("sees it in %s", (_name, out, err) => {
    expect(grokLimitAgain(out, err)).toBe(true);
  });

  it("doesn't take an ordinary failure for the limit", () => {
    expect(grokLimitAgain("", "Error: tool failed\n")).toBe(false);
    expect(
      grokLimitAgain(`${JSON.stringify({ type: "error", message: "bad tool call" })}\n`, ""),
    ).toBe(false);
  });

  it("is limited, not failed, when the run prints the free-tier sentence", async () => {
    const program = join(dir, "grok-free.mjs");
    const line = `${JSON.stringify({ type: "error", message: FREE })}\n`;
    writeFileSync(program, `process.stdout.write(${JSON.stringify(line)});\nprocess.exit(1);\n`);
    const r = {
      schemaVersion: 1 as const,
      host: "grok",
      sessionId: SID,
      cwd: dir,
      open: false,
      program,
      updatedAt: Date.now(),
    };
    expect(await resumeGrok(r, "Continue.", { ...process.env, GROK_HOME: grok })).toEqual({
      ok: false,
      reason: "limited",
    });
  });
});

describe("a 402 'usage balance exhausted'", () => {
  const stop = { error: "invalid_request", errorDetails: BALANCE };

  it("is the weekly limit, with or without a recent billing line", () => {
    for (const billing of [{ full: false }, { full: false, seen: true }]) {
      expect(classifyGrokFailure(stop, billing)).toEqual({ kind: "weekly", billing: false });
    }
    expect(classifyGrokFailure(stop, { full: true, resetsAt: 5 })).toEqual({
      kind: "weekly",
      billing: false,
      resetsAt: 5,
    });
  });

  it("is the weekly limit when no 402 or other word is in the text but the balance one", () => {
    expect(
      classifyGrokFailure(
        { error: "invalid_request", errorDetails: "Grok Build usage balance exhausted" },
        { full: false },
      ),
    ).toEqual({ kind: "weekly", billing: false });
  });

  it("is still billing when the text names a spending cap", () => {
    expect(
      classifyGrokFailure(
        { ...stop, lastAssistantMessage: "You've hit your spending cap." },
        { full: false },
      ),
    ).toEqual({ kind: "billing", billing: true });
  });
});
