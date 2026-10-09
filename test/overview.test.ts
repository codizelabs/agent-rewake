import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerHost, ScheduleStore } from "../src/core/store.js";
import { ThreadStore } from "../src/core/threads.js";
import { overview, overviewMarkdown, overviewText } from "../src/ui/overview.js";
import { VERSION } from "../src/version.js";

const NOW = new Date(2026, 9, 4, 14, 0).getTime();
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-overview-"));
  const store = new ScheduleStore(dir);
  const threads = new ThreadStore(dir);
  threads.update("s-1", "/work/api", { title: "Fix login", autoResume: true }, NOW);
  store.create({
    sessionId: "s-1",
    cwd: "/work/api",
    text: "Run | the tests",
    dueAt: NOW + 3_600_000,
    createdBy: "command",
    now: NOW,
  });
  store.create({
    sessionId: "s-2",
    cwd: "/work/web",
    text: "Resume",
    dueAt: NOW + 7_200_000,
    kind: "limit_resume",
    createdBy: "form",
    now: NOW,
  });
  const done = store.create({
    sessionId: "s-2",
    cwd: "/work/web",
    text: "Old",
    dueAt: NOW + 60_000,
    createdBy: "command",
    now: NOW,
  });
  store.update(done.scheduleId, (x) => ({ ...x, status: "sent" }), NOW);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("schedules overview", () => {
  it("groups by project and thread, and hides finished messages unless asked", () => {
    const groups = overview(dir);
    expect(groups.map((p) => p.name)).toEqual(["api", "web"]);
    expect(groups[0]?.threads[0]).toMatchObject({ title: "Fix login", autoResume: true });
    expect(groups[1]?.threads[0]?.title).toBe("Thread s-2");
    expect(groups[1]?.threads[0]?.schedules).toHaveLength(1);
    expect(overview(dir, true)[0]?.threads[0]?.schedules).toHaveLength(2);
  });

  it("--all lists everything newest first, and names the agent and the year (G66)", () => {
    new ThreadStore(dir).update("s-2", "/work/web", { agentName: "Codex" }, NOW);
    const groups = overview(dir, true, (h) => (h === "codex" ? "Codex" : undefined));
    // web's newest message (+2h) is newer than api's (+1h); inside web the Resume (+2h) comes
    // before the finished one (+1 min).
    expect(groups.map((p) => p.name)).toEqual(["web", "api"]);
    expect(groups[0]?.threads[0]?.schedules.map((s) => s.text)).toEqual(["Resume", "Old"]);
    const text = overviewText(groups, NOW, undefined, true);
    expect(text).toContain("Codex · Thread s-2");
    expect(text).toContain("Sunday October 4, 2026 at 16:00 · Planned · Resume");
    expect(text).toContain("Sunday October 4, 2026 at 14:01 · Sent · Old");
    expect(text.indexOf("Resume")).toBeLessThan(text.indexOf("Old"));
  });

  it("names the agent of a session outside Zed from its host", () => {
    const store = new ScheduleStore(dir);
    registerHost("codex");
    const made = store.create({
      sessionId: "019f-codex",
      cwd: "/work/cli",
      text: "Resume",
      dueAt: NOW + 3_600_000,
      kind: "limit_resume",
      createdBy: "auto",
      now: NOW,
    });
    store.put({ ...made, host: "codex", sessionRef: { threadId: "019f-codex" } });
    const t = overview(dir, false, (h) => (h === "codex" ? "Codex" : undefined))
      .flatMap((p) => p.threads)
      .find((x) => x.sessionId === "019f-codex");
    expect(t?.agent).toBe("Codex");
  });

  it("renders plain text and a Markdown table with escaped pipes", () => {
    const text = overviewText(overview(dir), NOW, "en-GB");
    expect(text).toContain("Fix login  [automatic resume on]");
    expect(text).toContain("15:00 today · Scheduled · Run | the tests");
    const md = overviewMarkdown(overview(dir), NOW, "en-GB");
    expect(md).toContain("| 15:00 today | Scheduled | Message | Run \\| the tests |");
    expect(md).toContain("| 16:00 today | Scheduled | Resume | Resume |");
    expect(md).toContain(`by Agent Rewake ${VERSION}.`);
  });
});
