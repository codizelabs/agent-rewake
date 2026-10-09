import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerHost, type Schedule, ScheduleStore } from "../src/core/store.js";
import { type SessionRecord, SessionRecords } from "../src/hosts/sessions.js";
import { KEEP_DAYS, pruneState, TEMP_MAX_AGE_MS } from "../src/timers/prune.js";

registerHost("test");

const DAY = 24 * 3_600_000;
const NOW = Date.parse("2026-10-08T12:00:00Z");
const OLD = NOW - (KEEP_DAYS + 5) * DAY;
const RECENT = NOW - 2 * DAY;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-prune-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
/** A schedule written straight to the folder (the store's own create would stamp today's time). */
function schedule(status: Schedule["status"], updatedAt: number, extra: Partial<Schedule> = {}) {
  counter++;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  const s: Schedule = {
    schemaVersion: 1,
    scheduleId: id,
    sessionId: `session-${counter}`,
    cwd: "/work/shop",
    kind: "limit_resume",
    text: "Continue.",
    dueAt: updatedAt,
    createdBy: "auto",
    status,
    attempts: [],
    createdAt: updatedAt - 1000,
    updatedAt,
    host: "test",
    ...extra,
  };
  const folder = join(dir, "schedules");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify(s));
  return s;
}

function record(sessionId: string, o: Partial<SessionRecord> = {}) {
  const folder = join(dir, "hosts", "test", "sessions");
  mkdirSync(folder, { recursive: true });
  const r: SessionRecord = {
    schemaVersion: 1,
    host: "test",
    sessionId,
    cwd: "/work/shop",
    open: false,
    updatedAt: RECENT,
    ...o,
  };
  writeFileSync(join(folder, `${sessionId}.json`), JSON.stringify(r));
}

const store = () => new ScheduleStore(dir);
const records = () => new SessionRecords(dir, "test");

describe("pruning the state folder", () => {
  it("removes finished resumes older than 30 days and keeps everything else", () => {
    const old = (["sent", "failed", "stopped", "cancelled"] as const).map((s) => schedule(s, OLD));
    // Never touched: still to come, waiting for the person, or paused, however old.
    const keep = (
      [
        "scheduled",
        "paused",
        "queued",
        "waiting_for_limit",
        "sending",
        "missed",
        "needs_attention",
      ] as const
    ).map((s) => schedule(s, OLD));
    const recent = (["sent", "failed", "cancelled"] as const).map((s) => schedule(s, RECENT));

    const done = pruneState(dir, NOW);

    expect(done?.schedules).toBe(old.length);
    for (const s of old) expect(store().get(s.scheduleId)).toBeUndefined();
    for (const s of [...keep, ...recent]) expect(store().get(s.scheduleId)).toBeDefined();
  });

  it("removes a closed session's record after 30 days, unless a resume still waiting needs it", () => {
    record("closed-old", { updatedAt: OLD, closedAt: OLD });
    record("closed-recent", { updatedAt: RECENT, closedAt: RECENT });
    record("open-old", { open: true, updatedAt: OLD });
    record("needed", { updatedAt: OLD, closedAt: OLD });
    record("typed-lately", { updatedAt: OLD, lastPromptAt: RECENT });
    schedule("scheduled", RECENT, { sessionId: "needed" });

    const done = pruneState(dir, NOW);

    expect(done?.sessions).toBe(1);
    expect(records().get("closed-old")).toBeUndefined();
    for (const id of ["closed-recent", "open-old", "needed", "typed-lately"])
      expect(records().get(id), id).toBeDefined();
  });

  it("keeps a record only a finished resume of the same session points at, once it is old", () => {
    record("done", { updatedAt: OLD, closedAt: OLD });
    schedule("sent", OLD, { sessionId: "done" });
    pruneState(dir, NOW);
    expect(records().get("done")).toBeUndefined();
  });

  it("removes daily logs older than 30 days, by the date in the name, and leaves other files", () => {
    const logs = join(dir, "logs");
    mkdirSync(logs, { recursive: true });
    for (const name of [
      "rewake-2026-08-01.jsonl",
      "rewake-2026-09-01.jsonl",
      "rewake-2026-09-07.jsonl",
      "rewake-2026-09-08.jsonl",
      "rewake-2026-10-07.jsonl",
      "npm-install.log",
      "notes.txt",
    ])
      writeFileSync(join(logs, name), "{}\n");

    const done = pruneState(dir, NOW);

    expect(done?.logs).toBe(3);
    expect(readdirSync(logs).sort()).toEqual([
      "notes.txt",
      "npm-install.log",
      "rewake-2026-09-08.jsonl",
      "rewake-2026-10-07.jsonl",
    ]);
  });

  it("removes temporary files a failed write left, older than an hour, and nothing else", () => {
    const stale = [
      join(dir, "schedules", ".a.json.123.deadbeef.tmp"),
      join(dir, "hosts", "test", "sessions", ".s.json.9.cafe0000.tmp"),
      join(dir, ".settings.json.1.00000000.tmp"),
      join(dir, "bin", ".rewake-node.agent-rewake.1.abcdef.tmp"),
    ];
    const fresh = join(dir, "schedules", ".b.json.124.deadbeef.tmp");
    const keep = [
      join(dir, "schedules", "plain.json"),
      join(dir, "schedules", ".hidden-but-not-temp"),
      // Another program's files, in a folder Rewake never enters.
      join(dir, "agents", "tool", ".cache.tmp"),
    ];
    for (const f of [...stale, fresh, ...keep]) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "x");
    }
    const old = new Date(NOW - TEMP_MAX_AGE_MS - 60_000);
    for (const f of [...stale, ...keep]) utimesSync(f, old, old);
    utimesSync(fresh, new Date(NOW - 5 * 60_000), new Date(NOW - 5 * 60_000));

    const done = pruneState(dir, NOW);

    expect(done?.temp).toBe(stale.length);
    for (const f of stale) expect(existsSync(f), f).toBe(false);
    for (const f of [fresh, ...keep]) expect(existsSync(f), f).toBe(true);
  });

  it("looks over the folder once a day, and when told to", () => {
    const a = schedule("sent", OLD);
    expect(pruneState(dir, NOW)?.schedules).toBe(1);
    const b = schedule("sent", OLD);
    // Later the same day: no scan at all.
    expect(pruneState(dir, NOW + 3_600_000)).toBeUndefined();
    expect(store().get(b.scheduleId)).toBeDefined();
    expect(pruneState(dir, NOW + 3_600_000, { force: true })?.schedules).toBe(1);
    const c = schedule("sent", OLD);
    expect(pruneState(dir, NOW + 25 * 3_600_000)?.schedules).toBe(1);
    expect(store().get(c.scheduleId)).toBeUndefined();
    expect(store().get(a.scheduleId)).toBeUndefined();
  });

  it("creates nothing where Rewake has no folder yet", () => {
    const none = join(dir, "never-made");
    expect(pruneState(none, NOW)).toBeUndefined();
    expect(existsSync(none)).toBe(false);
  });

  it("copes with thousands of records: old ones go, the rest stay, pending ones are untouched", () => {
    const N = 600;
    const sent: string[] = [];
    const pending: string[] = [];
    for (let i = 0; i < N; i++) {
      sent.push(schedule("sent", OLD).scheduleId);
      schedule("sent", RECENT);
      record(`old-${i}`, { updatedAt: OLD, closedAt: OLD });
      record(`new-${i}`);
      if (i % 100 === 0)
        pending.push(schedule("scheduled", OLD, { sessionId: `old-${i}` }).scheduleId);
    }

    const done = pruneState(dir, NOW);

    // The sessions of the pending resumes keep their records.
    expect(done).toMatchObject({ schedules: N, sessions: N - pending.length });
    expect(store().list()).toHaveLength(N + pending.length);
    expect(records().list()).toHaveLength(N + pending.length);
    for (const id of sent.slice(0, 20)) expect(store().get(id)).toBeUndefined();
    for (const id of pending) expect(store().get(id)?.status).toBe("scheduled");
  }, 60_000);
});
