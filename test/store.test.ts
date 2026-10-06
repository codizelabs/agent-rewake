import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionLock } from "../src/core/lock.js";
import { MAX_TEXT_BYTES, ScheduleStore } from "../src/core/store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = { sessionId: "s-1", cwd: "/p", createdBy: "command" as const, now: 1000 };

describe("ScheduleStore", () => {
  it("creates, lists by due time, updates and removes schedules", () => {
    const store = new ScheduleStore(dir);
    const late = store.create({ ...base, text: "later", dueAt: 9000 });
    const early = store.create({ ...base, text: "sooner", dueAt: 5000 });
    store.create({ ...base, sessionId: "s-2", text: "other thread", dueAt: 7000 });
    expect(store.listForSession("s-1").map((s) => s.text)).toEqual(["sooner", "later"]);
    const paused = store.update(early.scheduleId, (s) => ({ ...s, status: "paused" }), 2000);
    expect(paused?.status).toBe("paused");
    expect(paused?.updatedAt).toBe(2000);
    expect(store.remove(late.scheduleId)).toBe(true);
    expect(store.get(late.scheduleId)).toBeUndefined();
    expect(store.list()).toHaveLength(2);
  });

  it("writes owner-only files and leaves no temp files behind", () => {
    const store = new ScheduleStore(dir);
    const s = store.create({ ...base, text: "hi", dueAt: 5000 });
    const files = readdirSync(store.dir);
    expect(files).toEqual([`${s.scheduleId}.json`]);
    if (process.platform !== "win32") {
      expect(statSync(store.dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(store.dir, files[0] ?? "")).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects empty or oversized text", () => {
    const store = new ScheduleStore(dir);
    expect(() => store.create({ ...base, text: "   ", dueAt: 5000 })).toThrow();
    expect(() =>
      store.create({ ...base, text: "x".repeat(MAX_TEXT_BYTES + 1), dueAt: 5000 }),
    ).toThrow();
  });

  it("skips files that aren't valid schedules instead of trusting them", () => {
    const store = new ScheduleStore(dir);
    store.create({ ...base, text: "real", dueAt: 5000 });
    writeFileSync(
      join(store.dir, "00000000-0000-0000-0000-000000000000.json"),
      '{"text":"injected"}',
    );
    writeFileSync(join(store.dir, "garbage.json"), "not json");
    expect(store.list().map((s) => s.text)).toEqual(["real"]);
  });
});

describe("SessionLock", () => {
  it("gives a session to one owner at a time", () => {
    const a = new SessionLock(dir);
    const b = new SessionLock(dir);
    expect(a.acquire("s-1")).toBe(true);
    expect(b.acquire("s-1")).toBe(false);
    expect(b.acquire("s-2")).toBe(true);
    a.release("s-1");
    expect(b.acquire("s-1")).toBe(true);
  });

  it("takes over a lock whose owner process is dead, regardless of the file's age", () => {
    const dead = new SessionLock(dir);
    expect(dead.acquire("s-1")).toBe(true);
    const next = new SessionLock(dir, () => false); // every other PID looks dead
    expect(next.acquire("s-1")).toBe(true);
  });
});
