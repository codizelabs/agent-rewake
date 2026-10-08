import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/core/settings.js";
import { registerHost, ScheduleStore } from "../src/core/store.js";
import { ThreadStore } from "../src/core/threads.js";
import { type InputEvent, parseInput } from "../src/ui/input.js";
import { SchedulesPage } from "../src/ui/page.js";
import { VERSION } from "../src/version.js";

const HOUR = 3_600_000;
const T0 = new Date(2026, 9, 4, 14, 0, 0, 0).getTime(); // Sunday 4 Oct 2026 14:00 local
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes
const plain = (l: string) => l.replace(/\x1b\[[\d;]*m/g, "");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-page-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed() {
  const threads = new ThreadStore(dir);
  threads.update(
    "s-1",
    "/work/app",
    { title: "Refactor auth", agentId: "claude-acp", agentName: "Claude Agent" },
    T0,
  );
  threads.update(
    "s-2",
    "/work/api",
    { title: "Fix the build", agentId: "codex-acp", agentName: "Codex" },
    T0,
  );
  const store = new ScheduleStore(dir);
  store.create({
    sessionId: "s-1",
    cwd: "/work/app",
    text: "Run the tests",
    dueAt: T0 + HOUR,
    createdBy: "form",
    now: T0,
  });
  store.create({
    sessionId: "s-2",
    cwd: "/work/api",
    text: "Check CI and summarise failures",
    dueAt: T0 + 2 * HOUR,
    createdBy: "command",
    now: T0,
  });
  return store;
}

const page = (o: { threadId?: string } = {}) =>
  new SchedulesPage({ stateDir: dir, now: () => T0, locale: "en-GB", noColor: true, ...o });

/** Click the first hit with this id, the way a terminal reports it (1-based). */
function click(p: SchedulesPage, id: string, w = 120, h = 30) {
  const frame = p.render(w, h);
  const hit = frame.hits.find((x) => x.id === id);
  if (!hit) throw new Error(`no ${id} in ${frame.hits.map((x) => x.id).join(", ")}`);
  const at = { x: hit.x0 + 1, y: hit.line + 1 };
  p.handle({ type: "mouse", button: "left", press: true, motion: false, ...at });
  p.handle({ type: "mouse", button: "left", press: false, motion: false, ...at });
}
const key = (p: SchedulesPage, ch: string) =>
  p.handle({ type: "key", name: "char", ch } as InputEvent);
const type = (p: SchedulesPage, text: string) => p.handle({ type: "paste", text });
const enter = (p: SchedulesPage) => p.handle({ type: "key", name: "enter" });

describe("input parsing", () => {
  it("reads keys, SGR mouse clicks, hover, wheel, paste and cursor reports", () => {
    const { events, rest } = parseInput(
      "a\x1b[A\r\x1b[<0;12;5M\x1b[<0;12;5m\x1b[<35;3;4M\x1b[<65;1;1M\x1b[200~hi\nthere\x1b[201~\x1b[7;1R\x1b[<0;1",
    );
    expect(events).toEqual([
      { type: "key", name: "char", ch: "a" },
      { type: "key", name: "up" },
      { type: "key", name: "enter" },
      { type: "mouse", button: "left", x: 12, y: 5, press: true, motion: false },
      { type: "mouse", button: "left", x: 12, y: 5, press: false, motion: false },
      { type: "mouse", button: "none", x: 3, y: 4, press: true, motion: true },
      { type: "mouse", button: "wheeldown", x: 1, y: 1, press: true, motion: false },
      { type: "paste", text: "hi\nthere" },
      { type: "cursor", row: 7, col: 1 },
    ]);
    expect(rest).toBe("\x1b[<0;1"); // finished by the next chunk
    expect(parseInput("\x1b").events).toEqual([{ type: "key", name: "escape" }]);
  });
});

describe("the schedules page", () => {
  it("shows every thread's messages in a table with agent and thread columns, buttons and a tip", () => {
    seed();
    const frame = page().render(120, 30);
    const text = frame.lines.map(plain);
    expect(text[0]).toContain("Rewake · Scheduled messages");
    expect(text[0]?.endsWith(`Agent Rewake ${VERSION} `)).toBe(true);
    expect(text[2]).toMatch(/When\s+Agent\s+Thread\s+Message\s+Repeats\s+Status/);
    expect(text[3]).toMatch(
      /^› 15:00 today\s+Claude Agent\s+Refactor auth\s+Run the tests\s+—\s+Scheduled/,
    );
    expect(text[4]).toMatch(/16:00 today\s+Codex\s+Fix the build\s+Check CI/);
    expect(text.join("\n")).toContain("[n] New");
    expect(text.join("\n")).toContain("[d] Delete");
    expect(text.at(-1)).toMatch(/^ Tip: .*\[x\] hide tips/);
    for (const id of [
      "btn:new",
      "btn:edit",
      "btn:time",
      "btn:now",
      "btn:pause",
      "btn:delete",
      "btn:auto",
      "btn:help",
      "btn:quit",
      "row:0",
      "row:1",
      "tab:all",
      "tab:finished",
    ])
      expect(
        frame.hits.some((h) => h.id === id),
        id,
      ).toBe(true);
    expect(text).toHaveLength(30);
    for (const l of text) expect(l.length).toBeLessThanOrEqual(120);
  });

  it("explains a button on hover, with the matching /rewake command", () => {
    seed();
    const p = page();
    const frame = p.render(120, 30);
    const now = frame.hits.find((h) => h.id === "btn:now");
    p.handle({
      type: "mouse",
      button: "none",
      press: true,
      motion: true,
      x: (now?.x0 ?? 0) + 1,
      y: (now?.line ?? 0) + 1,
    });
    const hint = plain(p.render(120, 30).lines.at(-2) ?? "");
    expect(hint).toContain(
      "Send now: sends it within a few seconds if its thread is open in Zed. In its thread: /rewake now 1",
    );
  });

  it("schedules a new message with clicks: thread, text, then a time chip", () => {
    const store = seed();
    const p = page({ threadId: "s-2" });
    click(p, "btn:new");
    type(p, "Deploy to staging");
    enter(p);
    const frame = p.render(120, 30).lines.map(plain).join("\n");
    expect(frame).toContain("When should it be sent?");
    expect(frame).toContain("[ In 3 hours (17:00) ]");
    click(p, "preset:2"); // a preset saves at once: no more steps
    const created = store.listForSession("s-2").find((s) => s.text === "Deploy to staging");
    expect(created).toMatchObject({ dueAt: T0 + 3 * HOUR, createdBy: "tui" });
    expect(p.toast).toBe("Scheduled for 17:00 today. It's sent while that thread is open in Zed.");
  });

  it("asks which thread when opened outside a thread, and uses a typed cron time once", () => {
    const store = seed();
    const p = page();
    key(p, "n");
    expect(p.render(120, 30).lines.map(plain).join("\n")).toContain("Which thread?");
    p.handle({ type: "key", name: "down" });
    enter(p);
    type(p, "Ping");
    enter(p);
    type(p, "whenever");
    enter(p);
    expect(p.render(120, 30).lines.map(plain).join("\n")).toContain("has 5 parts");
    p.handle({ type: "key", name: "home" });
    for (let i = 0; i < 8; i++) p.handle({ type: "key", name: "delete" });
    type(p, "30 18 * * *");
    enter(p);
    // Only for a typed expression: how often?
    expect(p.render(120, 30).lines.map(plain).join("\n")).toContain("[ Only once (18:30 today) ]");
    click(p, "preset:1");
    expect(store.list().find((s) => s.text === "Ping")?.dueAt).toBe(T0 + 4.5 * HOUR);
  });

  it("repeats with a typed cron expression, explaining it live as you type", () => {
    const store = seed();
    const p = page({ threadId: "s-1" });
    key(p, "n");
    type(p, "Nightly summary");
    enter(p);
    type(p, "0 22 * * *");
    expect(p.render(120, 30).lines.map(plain).join("\n")).toContain(
      "Means: Every day at 22:00. Next: 22:00 today; 22:00 tomorrow, Monday; Tuesday at 22:00",
    );
    p.handle({ type: "key", name: "backspace" });
    expect(p.render(120, 30).lines.map(plain).join("\n")).toContain("has 5 parts");
    type(p, "*");
    enter(p);
    click(p, "preset:0"); // Every time it matches
    const created = store.list().find((s) => s.text === "Nightly summary");
    expect(created).toMatchObject({ repeat: { cron: "0 22 * * *" }, dueAt: T0 + 8 * HOUR });
    expect(p.toast).toContain("Repeats: Every day at 22:00.");
    expect(p.render(130, 30).lines.map(plain).join("\n")).toContain("Every day at 22:0");
  });

  it("confirms before deleting, and pauses and resumes with one button", () => {
    const store = seed();
    const p = page();
    click(p, "btn:delete");
    expect(p.render(120, 30).lines.map(plain).join("\n")).toContain(
      "Delete this scheduled message?",
    );
    click(p, "dlg:cancel");
    expect(store.list()).toHaveLength(2);
    click(p, "btn:pause");
    expect(store.list()[0]?.status).toBe("paused");
    expect(p.render(120, 30).lines.map(plain).join("\n")).toContain("[p] Resume");
    click(p, "btn:pause");
    expect(store.list()[0]?.status).toBe("scheduled");
    click(p, "btn:delete");
    click(p, "dlg:yes");
    expect(store.list().map((s) => s.text)).toEqual(["Check CI and summarise failures"]);
  });

  it("filters to the thread it was opened from, and shows a guide when there's nothing", () => {
    seed();
    const p = page({ threadId: "s-2" });
    expect(p.rows.map((r) => r.schedule.text)).toEqual(["Check CI and summarise failures"]);
    click(p, "tab:all");
    expect(p.rows).toHaveLength(2);
    const empty = new SchedulesPage({
      stateDir: mkdtempSync(join(tmpdir(), "rewake-empty-")),
      now: () => T0,
      noColor: true,
    });
    const text = empty.render(100, 24).lines.map(plain).join("\n");
    expect(text).toContain("Nothing is scheduled yet.");
    expect(text).toContain("type /rewake 09:00 Run the tests");
  });

  it("drops the Agent and Thread columns on narrow terminals and stays within the width", () => {
    seed();
    const text = page().render(60, 20).lines.map(plain);
    expect(text[2]).not.toContain("Agent");
    expect(text[2]).not.toContain("Thread");
    expect(text[0]).not.toContain(VERSION); // the version only where it fits
    for (const l of text) expect(l.length).toBeLessThanOrEqual(60);
  });

  it("shows Rewake's version on the title line, shortened to the number when the tabs leave less room", () => {
    seed();
    const full = plain(page().render(80, 20).lines[0] ?? "");
    expect(full.endsWith(` Agent Rewake ${VERSION} `)).toBe(true);
    const short = plain(page({ threadId: "s-1" }).render(80, 20).lines[0] ?? "");
    expect(short).not.toContain("Agent Rewake");
    expect(short.endsWith(` ${VERSION} `)).toBe(true);
    expect(short.length).toBeLessThanOrEqual(80);
  });

  it("hides tips for good with x, and opens help with ?", () => {
    seed();
    const p = page();
    key(p, "x");
    expect(page().showTips).toBe(false);
    key(p, "?");
    expect(p.render(120, 40).lines.map(plain).join("\n")).toContain(
      "/rewake 09:00 Run the tests · /rewake list",
    );
    expect(p.render(120, 40).lines.map(plain).join("\n")).toContain(
      `┌─ Help · Agent Rewake ${VERSION} ─`,
    );
    key(p, "q"); // closes help first
    expect(p.done).toBe(false);
    key(p, "q");
    expect(p.done).toBe(true);
  });
});

describe("resumes of agents outside Zed", () => {
  function hostRow() {
    registerHost("codex");
    const store = new ScheduleStore(dir);
    const s = store.create({
      sessionId: "019a-thread-codex",
      cwd: "/work/shop",
      text: "Continue.",
      dueAt: T0 + HOUR,
      kind: "limit_resume",
      createdBy: "auto",
      now: T0,
    });
    store.put({ ...s, host: "codex", sessionRef: { threadId: s.sessionId } });
    return s.scheduleId;
  }

  it("names the agent, and every change moves or removes its timer", () => {
    const id = hostRow();
    const changed: string[] = [];
    const p = new SchedulesPage({
      stateDir: dir,
      now: () => T0,
      locale: "en-GB",
      noColor: true,
      hostName: (h) => (h === "codex" ? "Codex" : undefined),
      onHostChange: (x) => changed.push(x),
    });
    const text = p.render(120, 30).lines.map(plain).join("\n");
    expect(text).toContain("Codex");
    expect(text).toContain("Session 019a-thr");
    p.action("pause");
    expect(new ScheduleStore(dir).get(id)?.status).toBe("paused");
    p.action("pause");
    p.action("now");
    expect(p.toast).toBe(
      "Resuming the Codex session within a few seconds. If it's open in Codex, Rewake won't send it and tells you in a desktop notification.",
    );
    expect(changed).toEqual([id, id, id]);
  });

  it("turns on the one automatic-resume setting for them, never a Zed thread's", () => {
    hostRow();
    const p = new SchedulesPage({
      stateDir: dir,
      now: () => T0,
      noColor: true,
      hostName: () => "Codex",
    });
    p.render(120, 30);
    expect(p.render(120, 30).lines.map(plain).join("\n")).toContain("Auto-resume: off");
    p.action("auto");
    expect(p.dialog).toMatchObject({ title: "Resume automatically after every usage limit?" });
    (p.dialog as { onYes: () => void }).onYes();
    expect(loadSettings(dir).newThreads).toBe("on");
    expect(new ThreadStore(dir).get("019a-thread-codex")).toBeUndefined();
    p.dialog = undefined;
    p.action("auto");
    expect(loadSettings(dir).newThreads).toBe("ask");
    expect(p.toast).toBe("Automatic resume is off: Rewake asks after each usage limit.");
  });
});
