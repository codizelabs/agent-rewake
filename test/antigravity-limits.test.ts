import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravityWaitMs, classifyAntigravityStop } from "../src/core/limits/agents.js";
import { resumeAgy } from "../src/hosts/antigravity/host.js";
import { SessionRecords } from "../src/hosts/sessions.js";

// "Model quota limit exceeded" and "Refreshes in 6 days and 18 hours" come from a Google forum post
// (discuss.ai.google.dev, 2026-01-24) and the community tool saaranshM/unsnooze, not from Google's
// documentation. "Resets in …" is the CLI's own (research impl-google L3).
const FAKE = fileURLToPath(new URL("./fixtures/fake-resume.mjs", import.meta.url));
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const SID = "8a3c1f2e-0b5d-4c7a-9e21-3f6b8d0c4a17";

let dir: string;
let state: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-agy-limits-")));
  state = join(dir, "state");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Antigravity's quota texts", () => {
  it.each([
    ["Individual quota reached. Resets in 16h39m20s", (16 * 60 + 39) * 60_000 + 20_000],
    ["Individual quota reached. Refreshes in 2h30m", 150 * 60_000],
    ["Model quota limit exceeded. Refreshes in 6 days and 18 hours", (6 * 24 + 18) * H],
    ["Model quota limit exceeded. Refreshes in 1 day", 24 * H],
    ["Model quota limit exceeded. Refreshes in 45 minutes", 45 * 60_000],
    ["Model quota limit exceeded. Refreshes in 3 hours and 5 minutes.", 3 * H + 5 * 60_000],
  ])("reads the wait in %j", (text, ms) => {
    expect(antigravityWaitMs(text)).toBe(ms);
    expect(classifyAntigravityStop({ terminationReason: "error", error: text }, NOW)).toEqual({
      kind: "other",
      billing: false,
      resetsAt: NOW + ms,
    });
  });

  it("knows 'Model quota limit exceeded' as a limit even with no wait in it", () => {
    expect(
      classifyAntigravityStop(
        { terminationReason: "error", error: "Model quota limit exceeded" },
        NOW,
      ),
    ).toEqual({ kind: "other", billing: false });
  });

  it("finds no wait where the text names none", () => {
    expect(antigravityWaitMs("Individual quota reached.")).toBeUndefined();
    expect(antigravityWaitMs("Refreshes in a while")).toBeUndefined();
  });
});

describe("an Antigravity resume that hits the limit again", () => {
  const run = (outcome: string) => {
    const r = new SessionRecords(state, "gemini-cli").update(SID, dir, NOW, (x) => ({
      ...x,
      program: FAKE,
    }));
    if (!r) throw new Error("no session record");
    return resumeAgy(r, "Continue.", { ...process.env, FAKE_RESUME: outcome });
  };

  it("reads the quota text and its reset from stderr's AGY_ERROR line (exit 3)", async () => {
    const before = Date.now();
    const result = await run("agy-stderr-quota");
    expect(result).toMatchObject({ ok: false, reason: "limited" });
    const at = (result as { resetsAt?: number }).resetsAt ?? 0;
    expect(at).toBeGreaterThanOrEqual(before + 150 * 60_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 150 * 60_000);
  });

  it("reports any other AGY_ERROR as a failure, with its message", async () => {
    expect(await run("agy-stderr-other")).toMatchObject({
      ok: false,
      reason: "failed",
      detail: "exit 3",
      message: expect.stringContaining("Something else broke."),
    });
  });

  it("lets a non-empty response win over quota text left on stderr", async () => {
    expect(await run("agy-ok-stale-stderr")).toEqual({ ok: true });
  });

  it("still judges a quiet exit as no response", async () => {
    expect(await run("silent")).toEqual({ ok: false, reason: "failed", detail: "no response" });
  });
});
