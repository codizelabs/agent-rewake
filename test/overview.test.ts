import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/core/store.js";
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
    expect(overview(dir, true)[1]?.threads[0]?.schedules).toHaveLength(2);
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
