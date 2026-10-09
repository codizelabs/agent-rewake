import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExplainInput, explainResume } from "../src/core/explain.js";
import { LATE_MS } from "../src/core/resume.js";
import { registerHost, type Schedule, ScheduleStore } from "../src/core/store.js";
import { explainSchedule } from "../src/ui/overview.js";

registerHost("test");

const NOW = Date.parse("2026-10-07T12:00:00Z");
const base: ExplainInput = {
  dueAt: NOW + 3_600_000,
  status: "scheduled",
  statusWord: "Scheduled",
  kind: "limit_resume",
  text: "Continue.",
  where: 'Codex in the "shop" folder',
  noun: "thread",
  outsideZed: true,
  cancel: "To cancel all planned resumes: agent-rewake continue --cancel",
};

describe("explainResume", () => {
  it("says what happens at the time and what could stop it, in the shared rules' numbers", () => {
    const text = explainResume(base, NOW, "en-US").join("\n");
    expect(text).toContain('Codex in the "shop" folder');
    expect(text).toContain('continue the thread by sending "Continue." once');
    expect(text).toContain("You type in the thread before then: Rewake sends nothing.");
    expect(text).toContain("The agent continues on its own first");
    expect(text).toContain("The thread is open in a window or terminal then");
    expect(text).toContain("still at its usage limit");
    expect(text).toContain(
      "Rewake waits for the new reset and tries again, or tells you if it can't",
    );
    expect(text).toContain("The computer is off or asleep then");
    expect(text).toContain("Rewake never resumes it");
    expect(text).toContain("Nothing is sent now: this view only reads.");
    expect(text).toContain("agent-rewake continue --cancel");
  });

  it("leaves out an open session where Rewake has no second writer to worry about (Zed)", () => {
    const text = explainResume(
      { ...base, outsideZed: false, lateMs: 15 * 60_000, where: 'The Zed thread "Fix tests"' },
      NOW,
    ).join("\n");
    expect(text).not.toContain("open in a window");
    expect(text).toContain("The computer is off or asleep then");
  });

  it("says when it is already too late to be sent by itself", () => {
    const text = explainResume({ ...base, dueAt: NOW - LATE_MS - 60_000 }, NOW).join("\n");
    expect(text).toContain("Its time has already passed by too long");
    expect(text).toContain("It will tell you.");
    expect(explainResume(base, NOW).join("\n")).not.toContain("already passed by too long");
  });

  it("says a finished resume does nothing more", () => {
    const text = explainResume({ ...base, status: "sent", statusWord: "Sent" }, NOW).join("\n");
    expect(text).toContain("That resume was already sent. Rewake won't do anything more with it.");
    expect(text).not.toContain("What could stop it");
  });

  it("describes a message you scheduled as a plain send", () => {
    const text = explainResume({ ...base, kind: "user", text: "Run the tests" }, NOW).join("\n");
    expect(text).toContain('send your message "Run the tests" into the thread once');
    expect(text).not.toContain("What could stop it");
  });
});

describe("explainSchedule", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewake-explain-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function add(): Schedule {
    const store = new ScheduleStore(dir);
    const s = store.create({
      sessionId: "thread-1",
      cwd: "/work/shop",
      text: "Continue.",
      dueAt: NOW + 3_600_000,
      kind: "limit_resume",
      createdBy: "auto",
      now: NOW,
    });
    store.put({ ...s, host: "test", sessionRef: { threadId: "thread-1" } });
    return s;
  }
  const hostOf = (h: string) => (h === "test" ? { name: "Codex", noun: "thread" } : undefined);

  it("finds a resume by the start of its id, names its host and folder, and changes nothing", () => {
    const s = add();
    const file = join(dir, "schedules", `${s.scheduleId}.json`);
    const before = readFileSync(file, "utf8");
    const r = explainSchedule(dir, s.scheduleId.slice(0, 8), NOW, hostOf, "en-US");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('Codex in the "shop" folder');
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("says plainly when no resume or more than one matches", () => {
    const a = add();
    const store = new ScheduleStore(dir);
    store.put({ ...a, scheduleId: "aaaaaaaa-0000-4000-8000-000000000001" });
    store.put({ ...a, scheduleId: "aaaaaaaa-0000-4000-8000-000000000002" });
    const none = explainSchedule(dir, "zzzz", NOW, hostOf);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain('No scheduled message starts with "zzzz"');
    const many = explainSchedule(dir, "aaaaaaaa", NOW, hostOf);
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toContain("More than one starts with");
    expect(explainSchedule(dir, "", NOW, hostOf).ok).toBe(false);
  });

  it("names a Zed thread by its title when no other host owns it", () => {
    const store = new ScheduleStore(dir);
    const s = store.create({
      sessionId: "zed-thread-1",
      cwd: "/work/shop",
      text: "Continue.",
      dueAt: NOW + 3_600_000,
      kind: "limit_resume",
      createdBy: "auto",
      now: NOW,
    });
    const r = explainSchedule(dir, s.scheduleId, NOW, hostOf, "en-US");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("The Zed thread zed-thre");
      expect(r.text).not.toContain("open in a window");
      expect(r.text).toContain("The computer is off or asleep then");
      expect(r.text).toContain("To cancel it, use the schedules page");
    }
  });
});
