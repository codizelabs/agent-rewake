import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerHost, type Schedule, ScheduleStore } from "../src/core/store.js";
import { ThreadStore } from "../src/core/threads.js";
import { history, historyText } from "../src/ui/history.js";
import { outcomeText } from "../src/ui/outcome.js";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 8, 12, 0).getTime();
let dir: string;
let store: ScheduleStore;
registerHost("codex");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-history-"));
  store = new ScheduleStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A schedule that ended as `change` says, `agoMs` before NOW. */
function made(
  sessionId: string,
  cwd: string,
  agoMs: number,
  change: Partial<Schedule>,
  kind: Schedule["kind"] = "limit_resume",
): Schedule {
  const s = store.create({
    sessionId,
    cwd,
    text: "PRIVATE message text",
    dueAt: NOW - agoMs,
    kind,
    createdBy: "auto",
    now: NOW - agoMs - 3_600_000,
  });
  store.put({ ...s, updatedAt: NOW - agoMs, ...change });
  return store.get(s.scheduleId) as Schedule;
}

describe("history (G66)", () => {
  it("lists what happened newest first, with the agent, folder and a reason", () => {
    new ThreadStore(dir).update("t1", "/work/api", { agentName: "Claude Agent" }, NOW);
    made("t1", "/work/api", 3 * DAY, { status: "sent" });
    made("t1", "/work/api", 1 * DAY, { status: "stopped", failureReason: "typed" });
    made("t1", "/work/api", 2 * DAY, { status: "failed", failureReason: "signed-out" });
    registerHost("codex");
    made("c1", "/work/web", 0.5 * DAY, {
      status: "needs_attention",
      failureReason: "still_limited",
      host: "codex",
      sessionRef: { threadId: "c1" },
    });
    const rows = history(dir, NOW, 7, (h) => (h === "codex" ? "Codex" : undefined));
    expect(rows.map((r) => r.outcome)).toEqual([
      "Still limited: the agent was still limited",
      "Cancelled: you typed in the session first",
      "Failed: the agent was signed out",
      "Sent",
    ]);
    expect(rows[0]).toMatchObject({ agent: "Codex", folder: "web", kind: "Resume" });
    expect(rows[1]).toMatchObject({ agent: "Claude Agent", folder: "api" });
  });

  it("keeps to the days asked for", () => {
    made("t1", "/work/api", 2 * DAY, { status: "sent" });
    made("t1", "/work/api", 10 * DAY, { status: "sent" });
    expect(history(dir, NOW, 7)).toHaveLength(1);
    expect(history(dir, NOW, 30)).toHaveLength(2);
    expect(history(dir, NOW, 1)).toHaveLength(0);
  });

  it("writes dates with the year, never the message text, and says when there's nothing", () => {
    made("t1", "/work/api", 2 * DAY, { status: "sent" }, "user");
    const text = historyText(history(dir, NOW, 7), 7);
    expect(text).toContain("The last 7 days, newest first:");
    expect(text).toContain("Tuesday October 6, 2026 at 12:00");
    expect(text).toContain('an agent in the "api" folder · Message: Sent');
    expect(text).not.toContain("PRIVATE");
    expect(historyText([], 1)).toBe(
      "Nothing in the last day: no messages or resumes were planned, sent or missed.",
    );
  });
});

describe("what happened and why", () => {
  it("says each ending in plain words", () => {
    const base = made("t", "/w", 0, {});
    const of = (extra: Partial<Schedule>) => outcomeText({ ...base, ...extra });
    expect(of({ status: "sent" })).toBe("Sent");
    expect(of({ status: "cancelled" })).toBe("Cancelled");
    expect(of({ status: "stopped", failureReason: "typed" })).toBe(
      "Cancelled: you typed in the session first",
    );
    expect(of({ status: "stopped", failureReason: "native" })).toBe(
      "Not needed: the agent continued by itself",
    );
    expect(of({ status: "stopped", failureReason: "you" })).toBe("Stopped by you");
    expect(of({ status: "missed" })).toContain("Too late");
    expect(of({ status: "failed", failureReason: "too-late" })).toBe(
      "Failed: it was too late to send",
    );
    expect(of({ status: "failed", failureReason: "expired" })).toBe(
      "Still limited: it was still limited after several tries",
    );
    expect(
      of({ status: "failed", failureReason: "failed", failureMessage: "No session matched" }),
    ).toBe("Failed: No session matched");
    expect(of({ status: "failed" })).toBe("Failed");
    expect(of({ status: "needs_attention", failureReason: "far-reset" })).toBe(
      "Needs you: the limit resets too far away to wait for",
    );
    expect(of({ status: "scheduled", rearms: 2 })).toContain("Still limited");
    expect(of({ status: "scheduled" })).toBe("Planned");
  });
});
