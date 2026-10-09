import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linuxStartTime, processStartTime, SessionLock } from "../src/core/lock.js";
import { MAX_TEXT_BYTES, registerHost, ScheduleStore } from "../src/core/store.js";

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

  it("keeps records with the optional host fields, and ignores hosts it doesn't know", () => {
    const store = new ScheduleStore(dir);
    const s = store.create({ ...base, text: "resume", dueAt: 5000 });
    const write = (id: string, extra: Record<string, unknown>) =>
      writeFileSync(
        join(store.dir, `${id}.json`),
        JSON.stringify({ ...s, scheduleId: id, ...extra }),
      );
    const acp = "00000000-0000-0000-0000-000000000001";
    const newer = "00000000-0000-0000-0000-000000000002";
    write(acp, { host: "acp", sessionRef: { cwd: "/p" }, rearms: 2 });
    // Written by a newer Rewake for an integration this version can't deliver for.
    write(newer, { host: "some-future-host", sessionRef: { threadId: "t-1" } });
    expect(store.get(acp)?.rearms).toBe(2);
    expect(store.get(newer)).toBeUndefined();
    expect(
      store
        .listForSession("s-1")
        .map((x) => x.scheduleId)
        .sort(),
    ).toEqual([acp, s.scheduleId].sort());
    // Never changed or deleted by this version either.
    expect(store.update(newer, (x) => ({ ...x, status: "cancelled" }), 2000)).toBeUndefined();
    expect(store.remove(newer)).toBe(false);
    expect(readdirSync(store.dir)).toContain(`${newer}.json`);
  });

  it("lists a session's schedules for their owner only, so Zed and Codex never both deliver one", () => {
    registerHost("codex");
    const store = new ScheduleStore(dir);
    const zed = store.create({ ...base, text: "zed", dueAt: 5000 });
    const codex = store.create({ ...base, text: "codex", dueAt: 6000 });
    store.put({ ...codex, host: "codex" });
    expect(store.listForSession("s-1").map((s) => s.scheduleId)).toEqual([zed.scheduleId]);
    expect(store.listForSession("s-1", "codex").map((s) => s.scheduleId)).toEqual([
      codex.scheduleId,
    ]);
    expect(store.list()).toHaveLength(2);
  });

  it("rejects malformed host fields", () => {
    const store = new ScheduleStore(dir);
    const s = store.create({ ...base, text: "resume", dueAt: 5000 });
    const id = "00000000-0000-0000-0000-000000000003";
    for (const extra of [
      { host: 1 },
      { sessionRef: "t-1" },
      { sessionRef: ["t-1"] },
      { sessionRef: { threadId: 1 } },
      { sessionRef: { big: "x".repeat(5000) } },
      { rearms: -1 },
      { rearms: 1.5 },
    ]) {
      writeFileSync(
        join(store.dir, `${id}.json`),
        JSON.stringify({ ...s, scheduleId: id, ...extra }),
      );
      expect(store.get(id), JSON.stringify(extra).slice(0, 40)).toBeUndefined();
    }
  });
});

describe("SessionLock: a lock file still being written", () => {
  it("isn't taken over while it's empty and new (its owner may be writing it)", () => {
    const a = new SessionLock(dir);
    expect(a.acquire("s")).toBe(true);
    const lockDir = join(dir, "locks");
    const [file] = readdirSync(lockDir);
    writeFileSync(join(lockDir, file as string), "");
    expect(new SessionLock(dir).acquire("s")).toBe(false);
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

  it("takes over when the owner's PID was reused by another process (a different start time)", () => {
    const first = new SessionLock(
      dir,
      () => true,
      () => "Thu Oct  8 09:00:00 2026",
    );
    expect(first.acquire("s-1")).toBe(true);
    // The same PID is alive, but it started at another time: a different process.
    const next = new SessionLock(
      dir,
      () => true,
      () => "Thu Oct  8 11:30:00 2026",
    );
    expect(next.acquire("s-1")).toBe(true);
  });

  it("keeps a lock whose owner is the same process, even after the computer's name changed", () => {
    const owner = new SessionLock(dir);
    expect(owner.acquire("s-1")).toBe(true);
    const lockDir = join(dir, "locks");
    const [file] = readdirSync(lockDir);
    const path = join(lockDir, file as string);
    const held = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // macOS renames the computer when the network changes.
    writeFileSync(path, JSON.stringify({ ...held, hostname: "Kashans-MacBook-Pro-2.local" }));
    expect(new SessionLock(dir).acquire("s-1")).toBe(false);
  });

  it("keeps a lock when the system can't give the start time now or before", () => {
    const owner = new SessionLock(
      dir,
      () => true,
      () => undefined,
    );
    expect(owner.acquire("s-1")).toBe(true);
    expect(
      new SessionLock(
        dir,
        () => true,
        () => "any",
      ).acquire("s-1"),
    ).toBe(false);
    const named = new SessionLock(
      dir,
      () => true,
      () => "t1",
    );
    expect(named.acquire("s-2")).toBe(true);
    expect(
      new SessionLock(
        dir,
        () => true,
        () => undefined,
      ).acquire("s-2"),
    ).toBe(false);
  });

  it("reads Linux's start time after a program name with spaces and brackets", () => {
    const stat = `4242 (my (odd) prog) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 200 18446744073709551615`;
    expect(linuxStartTime(stat)).toBe("987654");
    expect(linuxStartTime("garbage")).toBeUndefined();
  });

  it("gives this process's own start time where the system can say", () => {
    if (process.platform === "win32") return;
    const a = processStartTime(process.pid);
    expect(a).toBeTruthy();
    expect(processStartTime(process.pid)).toBe(a);
  });
});
