import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TimerHost } from "../src/timers/timers.js";
import { isWsl, runWaiter, WAITER_POLL_MS } from "../src/timers/waiter.js";

let dir: string;
let timers: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-waiter-"));
  timers = join(dir, "timers");
  mkdirSync(timers);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;
const A = "0f6c3a1e-6b1d-4d7a-9a51-2b8c4f1e9d10";
const B = "1a2b3c4d-0000-4000-8000-000000000000";

const host = (running: (pid: number) => boolean = () => false): TimerHost => ({
  platform: "linux",
  stateDir: dir,
  node: "/n",
  cli: "/c.js",
  run: () => ({ status: 0, stdout: "", stderr: "" }),
  detached: () => {},
  exists: () => false,
  uid: () => 1000,
  waiterRunning: running,
});

describe("Rewake's waiter", () => {
  it("fires each resume at its time, picks up new ones, and ends when none is left", async () => {
    writeFileSync(join(timers, `${A}.wait`), String(NOW + 90_000));
    let clock = NOW;
    const fired: [string, number][] = [];
    const sleeps: number[] = [];
    const code = await runWaiter({
      timers: host(),
      pid: 77,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        expect(readFileSync(join(timers, "waiter.pid"), "utf8")).toBe("77");
        // Armed while it waits.
        if (sleeps.length === 1) writeFileSync(join(timers, `${B}.wait`), String(NOW + 40_000));
        clock += ms;
      },
      fire: (name) => fired.push([name, clock]),
    });
    expect(code).toBe(0);
    expect(fired).toEqual([
      [B, NOW + 40_000],
      [A, NOW + 90_000],
    ]);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(WAITER_POLL_MS);
    expect(existsSync(join(timers, "waiter.pid"))).toBe(false);
    expect(existsSync(join(timers, `${A}.wait`))).toBe(false);
  });

  it("doesn't fire a resume cancelled meanwhile", async () => {
    writeFileSync(join(timers, `${A}.wait`), String(NOW + 10_000));
    let clock = NOW;
    const fired: string[] = [];
    await runWaiter({
      timers: host(),
      pid: 77,
      now: () => clock,
      sleep: async (ms) => {
        rmSync(join(timers, `${A}.wait`));
        clock += ms;
      },
      fire: (name) => fired.push(name),
    });
    expect(fired).toEqual([]);
  });

  it("leaves the work to a waiter that's already running", async () => {
    writeFileSync(join(timers, `${A}.wait`), String(NOW));
    writeFileSync(join(timers, "waiter.pid"), "55");
    const fired: string[] = [];
    const code = await runWaiter({
      timers: host((pid) => pid === 55),
      pid: 77,
      now: () => NOW,
      sleep: async () => {},
      fire: (name) => fired.push(name),
    });
    expect(code).toBe(0);
    expect(fired).toEqual([]);
    expect(readFileSync(join(timers, "waiter.pid"), "utf8")).toBe("55");
  });

  it("knows WSL by its kernel", () => {
    expect(isWsl("Linux version 6.6.87.2-microsoft-standard-WSL2 (root@...)")).toBe(true);
    expect(isWsl("Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075)")).toBe(false);
  });
});
