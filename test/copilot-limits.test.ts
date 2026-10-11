import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyCopilotError, copilotCode } from "../src/core/limits/agents.js";
import { resumeCopilot } from "../src/hosts/copilot/host.js";
import { SessionRecords } from "../src/hosts/sessions.js";

// Codes and fields: github/copilot-sdk @503bc70, nodejs/src/generated/session-events.ts:2014 and
// :11922. The "session limit" wording of user_global_rate_limited and the `:pro` suffix are from the
// community-autoresume research note (it cites VS Code's commonTypes.ts).
const FAKE = fileURLToPath(new URL("./fixtures/fake-copilot.mjs", import.meta.url));
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const SID = "8a3c1f2e-0b5d-4c7a-9e21-3f6b8d0c4a17";

let dir: string;
let state: string;
let work: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-copilot-limits-")));
  state = join(dir, "state");
  work = join(dir, "shop");
  mkdirSync(work);
  chmodSync(FAKE, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const nested = (code: string, message = "Sorry, you have exceeded your weekly rate limit.") =>
  JSON.stringify({ error: { code, message } });

describe("Copilot's error codes", () => {
  it.each([
    ["user_weekly_rate_limited", { kind: "weekly", billing: false }],
    ["user_global_rate_limited", { kind: "session", billing: false }],
    ["user_global_rate_limited:pro", { kind: "session", billing: false }],
    ["user_model_rate_limited", { kind: "model", billing: false }],
    ["integration_rate_limited", { kind: "other", billing: false }],
    ["session_quota_exceeded", { kind: "session", billing: false }],
  ])("reads %s inside an error object", (code, limit) => {
    expect(copilotCode(nested(code))).toEqual(limit);
    // Copilot marks even a weekly limit recoverable: the code still wins.
    expect(classifyCopilotError(nested(code), NOW, true)).toEqual(limit);
  });

  it("still reads the code at the top", () => {
    expect(copilotCode(JSON.stringify({ code: "user_global_rate_limited" }))).toEqual({
      kind: "session",
      billing: false,
    });
  });

  it("doesn't take a bare rate_limited, or an unknown code, for a usage limit", () => {
    expect(copilotCode(nested("rate_limited"))).toBeUndefined();
    expect(classifyCopilotError(nested("rate_limited", "Too many requests."), NOW)).toBeUndefined();
    expect(copilotCode(nested("something_else"))).toBeUndefined();
    expect(copilotCode(JSON.stringify({ error: null }))).toBeUndefined();
  });

  it.each([
    "Sorry, you have exceeded your weekly rate limit.",
    "Sorry, you have exceeded your weekly rate limit. Please try again in 58 hours.",
  ])("reads the wording %j", (text) => {
    expect(classifyCopilotError(text, NOW)).toMatchObject({ billing: false });
  });

  it("reads 'try again in 58 hours' as the reset", () => {
    expect(
      classifyCopilotError(
        "Sorry, you have exceeded your weekly rate limit. Please try again in 58 hours.",
        NOW,
      )?.resetsAt,
    ).toBe(NOW + 58 * H);
  });
});

describe("a Copilot resume that hits a limit again", () => {
  const run = (events: unknown[]) => {
    const r = new SessionRecords(state, "copilot-cli").update(SID, work, NOW, (x) => ({
      ...x,
      program: FAKE,
    }));
    if (!r) throw new Error("no session record");
    return resumeCopilot(r, "Continue.", {
      ...process.env,
      FAKE_COPILOT: "events",
      FAKE_COPILOT_EVENTS: JSON.stringify(events),
    });
  };

  it("uses retryAfterSeconds as the reset", async () => {
    const before = Date.now();
    const result = await run([
      {
        type: "session.error",
        data: { errorType: "rate_limit", errorCode: "user_weekly_rate_limited", message: "x" },
      },
      { type: "auto_mode_switch.requested", data: { retryAfterSeconds: 7200 } },
    ]);
    expect(result).toMatchObject({ ok: false, reason: "limited" });
    const at = (result as { resetsAt?: number }).resetsAt ?? 0;
    expect(at).toBeGreaterThanOrEqual(before + 2 * H);
    expect(at).toBeLessThanOrEqual(Date.now() + 2 * H);
  });

  it.each([0, -30, "soon", null])(
    "ignores a retryAfterSeconds of %j and falls back to the message",
    async (bad) => {
      const result = await run([
        {
          type: "session.error",
          data: {
            errorType: "rate_limit",
            message:
              "You've reached your weekly rate limit. Please wait for your limit to reset in 3 hours or switch to auto model to continue.",
          },
        },
        { type: "auto_mode_switch.requested", data: { retryAfterSeconds: bad } },
      ]);
      expect(result).toMatchObject({ ok: false, reason: "limited" });
      const at = (result as { resetsAt?: number }).resetsAt ?? 0;
      expect(at).toBeGreaterThan(Date.now() + 3 * H - 60_000);
      expect(at).toBeLessThanOrEqual(Date.now() + 3 * H);
    },
  );

  it("takes the reset from an auto_mode_switch.requested event alone", async () => {
    const before = Date.now();
    const result = await run([
      { type: "auto_mode_switch.requested", data: { retryAfterSeconds: 3600 } },
    ]);
    expect(result).toMatchObject({ ok: false, reason: "limited" });
    const at = (result as { resetsAt?: number }).resetsAt ?? 0;
    expect(at).toBeGreaterThanOrEqual(before + H);
    expect(at).toBeLessThanOrEqual(Date.now() + H);
  });

  it("ignores an auto_mode_switch.requested event with no retry time", async () => {
    expect(
      await run([{ type: "auto_mode_switch.requested", data: { errorCode: "rate_limited" } }]),
    ).toMatchObject({ ok: false, reason: "failed" });
  });

  it("waits out a quota error that names a limit", async () => {
    expect(
      await run([
        {
          type: "session.error",
          data: { errorType: "quota", errorCode: "session_quota_exceeded", message: "x" },
        },
      ]),
    ).toMatchObject({ ok: false, reason: "limited" });
  });

  it("doesn't wait out a quota error about money", async () => {
    expect(
      await run([
        {
          type: "session.error",
          data: {
            errorType: "quota",
            errorCode: "billing_not_configured",
            message: "You've run out of your AI credits for the month.",
          },
        },
      ]),
    ).toMatchObject({ ok: false, reason: "failed", detail: "quota" });
  });
});
