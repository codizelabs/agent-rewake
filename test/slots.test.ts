import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_REARMS } from "../src/core/resume.js";
import { registerHost, type Schedule, ScheduleStore } from "../src/core/store.js";
import type { HostAdapter } from "../src/hosts/host.js";
import { type FireDeps, fire } from "../src/timers/fire.js";
import {
  MAX_CONCURRENT_RESUMES,
  MAX_STAGGER_WAIT_MS,
  STAGGER_MS,
  setStagger,
  takeSlot,
} from "../src/timers/slots.js";

registerHost("test");

const NOW = Date.parse("2026-10-07T12:00:00Z");
let dir: string;
let store: ScheduleStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-slots-"));
  store = new ScheduleStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A clock and a pause that only move when the code under test pauses: no real waiting. */
function virtual(start = NOW) {
  let t = start;
  const slept: number[] = [];
  return {
    clock: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("the limits on resumes that start together", () => {
  it("documents small defaults: two at once, 5 seconds apart, at most a minute of waiting", () => {
    expect(MAX_CONCURRENT_RESUMES).toBe(2);
    expect(STAGGER_MS).toBe(5_000);
    expect(MAX_STAGGER_WAIT_MS).toBe(60_000);
  });

  it("gives out two places and makes a third resume wait for one to be given back", async () => {
    const v = virtual();
    const o = { stateDir: dir, ...v, staggerMs: 0, pollMs: 100 };
    const a = await takeSlot(o);
    const b = await takeSlot(o);
    expect(a && b).toBeTruthy();
    // The third finds no place; a place is given back during its first wait.
    let third: (() => void) | undefined;
    const waiting = takeSlot({
      ...o,
      sleep: async (ms) => {
        await v.sleep(ms);
        a?.();
      },
    });
    third = await waiting;
    expect(third).toBeTypeOf("function");
    // Now the places are b's and the third's: a fourth finds none and gives up after its time.
    const fourth = await takeSlot({ ...o, maxWaitMs: 1_000 });
    expect(fourth).toBeUndefined();
    b?.();
    third?.();
    expect(await takeSlot({ ...o, maxWaitMs: 1_000 })).toBeTypeOf("function");
  });

  it("starts resumes 5 seconds apart, however many fall due in the same minute", async () => {
    const v = virtual();
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const release = await takeSlot({ stateDir: dir, ...v, staggerMs: STAGGER_MS });
      starts.push(v.clock());
      release?.();
    }
    expect(starts[0]).toBe(NOW);
    for (let i = 1; i < starts.length; i++)
      expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(STAGGER_MS);
  });

  it("never makes a resume wait more than a minute for its turn", async () => {
    const v = virtual();
    const first = await takeSlot({ stateDir: dir, ...v, staggerMs: 600_000 });
    first?.();
    const before = v.clock();
    const second = await takeSlot({ stateDir: dir, ...v, staggerMs: 600_000 });
    expect(second).toBeTypeOf("function");
    expect(v.clock() - before).toBeLessThanOrEqual(MAX_STAGGER_WAIT_MS);
  });

  it("uses the real gap unless told otherwise (test/setup.ts turns it off for other tests)", async () => {
    setStagger(STAGGER_MS);
    try {
      const v = virtual();
      (await takeSlot({ stateDir: dir, ...v }))?.();
      const before = v.clock();
      (await takeSlot({ stateDir: dir, ...v }))?.();
      expect(v.clock() - before).toBe(STAGGER_MS);
    } finally {
      setStagger(0);
    }
  });
});

function resume(i: number, extra: Partial<Schedule> = {}): Schedule {
  const s = store.create({
    sessionId: `thread-${i}`,
    cwd: "/work/shop",
    text: "Continue.",
    dueAt: NOW,
    kind: "limit_resume",
    createdBy: "auto",
    now: NOW - 3_600_000,
  });
  store.put({ ...s, host: "test", sessionRef: { threadId: `thread-${i}` }, ...extra });
  return store.get(s.scheduleId) as Schedule;
}

/** A host whose sends stay open until released, counting how many run at once. */
function gated() {
  const state = { running: 0, peak: 0, started: [] as string[] };
  const gates: (() => void)[] = [];
  const host: HostAdapter = {
    id: "test",
    name: "Codex",
    noun: "thread",
    check: async () => ({}),
    send: (_s, key) => {
      state.started.push(key);
      state.running++;
      state.peak = Math.max(state.peak, state.running);
      return new Promise((resolve) => {
        gates.push(() => {
          state.running--;
          resolve({ ok: true });
        });
      });
    },
  };
  return { host, state, gates };
}

function deps(host: HostAdapter, slots: FireDeps["slots"]): FireDeps {
  return {
    stateDir: dir,
    now: () => NOW + 60_000,
    hosts: new Map([["test", host]]),
    notify: () => true,
    slots: { staggerMs: 0, pollMs: 5, ...slots },
  };
}

const until = async (test: () => boolean) => {
  for (let i = 0; i < 400 && !test(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(test()).toBe(true);
};

describe("fire with several resumes due at once", () => {
  it("runs at most two at a time and starts the third when one ends", async () => {
    const { host, state, gates } = gated();
    const ids = [1, 2, 3].map((i) => resume(i).scheduleId);
    const runs = ids.map((id) => fire(id, deps(host, {})));

    await until(() => state.started.length === 2);
    // The third is waiting for a place, not sending: it stays planned.
    await new Promise((r) => setTimeout(r, 60));
    expect(state.started).toHaveLength(2);
    expect(state.peak).toBe(2);
    expect(ids.map((id) => store.get(id)?.status).sort()).toEqual([
      "scheduled",
      "sending",
      "sending",
    ]);

    gates.shift()?.();
    await until(() => state.started.length === 3);
    expect(state.peak).toBe(2);
    while (state.running > 0 || gates.length > 0) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await Promise.all(runs)).toEqual(["sent", "sent", "sent"]);
    expect(ids.map((id) => store.get(id)?.status)).toEqual(["sent", "sent", "sent"]);
  });

  it("puts a resume back for a minute when no place frees up, without using its re-arms", async () => {
    const { host, state, gates } = gated();
    const a = resume(1);
    const b = resume(2);
    const c = resume(3, { rearms: MAX_REARMS });
    const first = fire(a.scheduleId, deps(host, {}));
    const second = fire(b.scheduleId, deps(host, {}));
    await until(() => state.started.length === 2);

    // Both places are taken and stay so: the third gives up its wait and is set for later.
    const outcome = await fire(c.scheduleId, deps(host, { maxWaitMs: 30 }));

    expect(outcome).toBe("waiting");
    expect(state.started).toHaveLength(2);
    const after = store.get(c.scheduleId);
    expect(after?.status).toBe("scheduled");
    expect(after?.rearms).toBe(MAX_REARMS);
    expect(after?.dueAt).toBeGreaterThanOrEqual(NOW + 120_000);
    // Let the two that run finish.
    for (const g of gates.splice(0)) g();
    expect(await Promise.all([first, second])).toEqual(["sent", "sent"]);
  });

  it("gives its place back when the send fails, so the next resume can start", async () => {
    const failing: HostAdapter = {
      id: "test",
      name: "Codex",
      noun: "thread",
      check: async () => ({}),
      send: async () => {
        throw new Error("boom");
      },
    };
    for (let i = 1; i <= 4; i++) {
      const id = resume(i).scheduleId;
      expect(await fire(id, deps(failing, { maxWaitMs: 30 }))).not.toBe("waiting");
    }
  });
});
