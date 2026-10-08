import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { armTimer, defaultTimerHost, timerArmed, timerKind } from "../src/timers/timers.js";

/**
 * Rewake's waiter for real (Linux without systemd or at): the built CLI's `wait` runs `fire` for
 * two resumes at their times, then ends. Runs with REWAKE_OS_TIMERS=1 where the waiter is the
 * timer (the `timers` CI job's container); REWAKE_EXPECT_WAITER=1 makes any other timer a failure.
 * Needs `npm run build` first. `fire` finds no such resumes and logs "gone": what's checked is that
 * it ran, at the right time.
 */
const enabled = process.env.REWAKE_OS_TIMERS === "1";
const cli = join(import.meta.dirname, "../dist/agent-rewake.js");

describe.runIf(enabled)("Rewake's waiter", () => {
  it(
    "fires each resume at its time, then ends",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rewake-waiter-os-"));
      const h = defaultTimerHost(dir, process.execPath, cli);
      if (timerKind(h) !== "waiter") {
        if (process.env.REWAKE_EXPECT_WAITER === "1")
          throw new Error(`Expected Rewake's waiter here, found: ${timerKind(h)}`);
        console.warn("This computer has another timer: the waiter isn't used, skipped.");
        return;
      }
      expect(existsSync(cli)).toBe(true);
      const a = "0f6c3a1e-6b1d-4d7a-9a51-2b8c4f1e9d10";
      const b = "1a2b3c4d-0000-4000-8000-000000000000";
      const start = Date.now();
      try {
        expect(armTimer(a, start + 15_000, h)).toEqual({ ok: true, via: "waiter" });
        expect(armTimer(b, start + 20_000, h)).toEqual({ ok: true, via: "waiter" });
        await new Promise((r) => setTimeout(r, 2000));
        expect(timerArmed(a, h)).toBe(true);
        const fired = () =>
          (existsSync(join(dir, "logs")) ? readdirSync(join(dir, "logs")) : [])
            .flatMap((f) =>
              readFileSync(join(dir, "logs", f), "utf8")
                .trim()
                .split("\n"),
            )
            .map((l) => JSON.parse(l) as { t: string; event: string })
            .filter((l) => l.event === "fire.done")
            .map((l) => Date.parse(l.t));
        while (Date.now() < start + 60_000 && fired().length < 2)
          await new Promise((r) => setTimeout(r, 1000));
        const times = fired();
        expect(times).toHaveLength(2);
        expect(times[0]).toBeGreaterThanOrEqual(start + 15_000 - 1000);
        expect(times[1]).toBeGreaterThanOrEqual(start + 20_000 - 1000);
        await new Promise((r) => setTimeout(r, 2000));
        expect(existsSync(join(dir, "timers", "waiter.pid"))).toBe(false);
        expect(timerArmed(a, h) || timerArmed(b, h)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    2 * 60_000,
  );
});
