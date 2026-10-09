import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  armTimer,
  cancelTimer,
  defaultTimerHost,
  timerArmed,
  timerKind,
} from "../src/timers/timers.js";

/**
 * A real one-shot timer on this computer: armed for the next minute, it must run the program once
 * and then be gone. Slow (up to two minutes) and it touches the OS scheduler, so it runs only with
 * REWAKE_OS_TIMERS=1 (the `timers` CI job on macOS, Linux and Windows). The program it runs is a
 * stub that writes its arguments to a file, not Rewake.
 */
const enabled = process.env.REWAKE_OS_TIMERS === "1";

describe.runIf(enabled)("OS timer", () => {
  it(
    "fires once at its time and removes itself",
    async (ctx) => {
      const dir = mkdtempSync(join(tmpdir(), "rewake-os-timer-"));
      const marker = join(dir, "fired.txt");
      const stub = join(dir, "stub.mjs");
      // Each run writes when it ran (ms) and its arguments, so runs are told apart by time.
      writeFileSync(
        stub,
        `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, Date.now() + " " + process.argv.slice(2).join(" ") + "\\n");\n`,
      );
      const h = defaultTimerHost(dir, process.execPath, stub);
      const kind = timerKind(h);
      // Rewake's own waiter runs the real CLI, not a stub: test/waiter-os.test.ts.
      if (kind === "waiter") {
        rmSync(dir, { recursive: true, force: true });
        ctx.skip();
      }
      if (!kind) {
        rmSync(dir, { recursive: true, force: true });
        // On CI a missing scheduler is a broken runner, not a pass.
        if (process.env.CI)
          throw new Error("No OS timer on this CI runner (no systemd user manager or at).");
        ctx.skip("No OS timer on this computer (no systemd user manager or at)");
      }
      const id = `test-${Date.now().toString(36)}`;
      const at = Date.now() + 65_000;
      const runs = () =>
        (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : []).map((l) => {
          const space = l.indexOf(" ");
          return { t: Number(l.slice(0, space)), args: l.slice(space + 1) };
        });
      // launchd runs a job once when it's loaded (RunAtLoad), a minute before its time: that run
      // isn't the timer firing. A run at the time is one at or after it (less a second of skew).
      const onTime = () => runs().filter((r) => r.t >= at - 1000);
      try {
        expect(armTimer(id, at, h)).toEqual({ ok: true, via: kind });
        expect(timerArmed(id, h)).toBe(true);
        const deadline = at + 60_000;
        while (Date.now() < deadline && onTime().length === 0)
          await new Promise((r) => setTimeout(r, 1000));
        // A second run would come at once (a duplicate timer) or never: give it a few seconds.
        await new Promise((r) => setTimeout(r, 5000));
        // Exactly one run at the time; the only other one allowed is launchd's load-time run.
        // The timer names Rewake's state folder: it runs without Rewake's environment.
        expect(onTime().map((r) => r.args)).toEqual([`fire ${id} --state-dir ${dir}`]);
        const early = runs().filter((r) => r.t < at - 1000);
        expect(early.length).toBeLessThanOrEqual(kind === "launchd" ? 1 : 0);
        // `fire` removes its own timer on macOS and Windows; systemd and at remove theirs.
        cancelTimer(id, h);
        await new Promise((r) => setTimeout(r, 2000));
        expect(timerArmed(id, h)).toBe(false);
      } finally {
        cancelTimer(id, h);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    3 * 60_000,
  );

  it(
    "re-arms from inside its own run under a new name, which then fires too",
    async (ctx) => {
      const dir = mkdtempSync(join(tmpdir(), "rewake-os-rearm-"));
      const marker = join(dir, "fired.txt");
      // The real timer code, bundled for the stub to load (it runs outside the test's process).
      buildSync({
        entryPoints: [join(import.meta.dirname, "../src/timers/timers.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: join(dir, "timers.mjs"),
        logLevel: "silent",
      });
      const stub = join(dir, "stub.mjs");
      const h = defaultTimerHost(dir, process.execPath, stub);
      const kind = timerKind(h);
      if (kind === "waiter") {
        rmSync(dir, { recursive: true, force: true });
        ctx.skip();
      }
      if (!kind) {
        rmSync(dir, { recursive: true, force: true });
        // On CI a missing scheduler is a broken runner, not a pass.
        if (process.env.CI) throw new Error("No OS timer on this CI runner.");
        ctx.skip("No OS timer on this computer");
      }
      const id = `test-${Date.now().toString(36)}`;
      const at = Date.now() + 65_000;
      const rearmAt = at + 60_000;
      // Like `fire` when the agent is still limited: arm `<id>-r1`, retire its own timer.
      writeFileSync(
        stub,
        [
          `import { appendFileSync } from "node:fs";`,
          `import { armTimer, cancelTimer, defaultTimerHost, timerName } from "./timers.mjs";`,
          `const name = process.argv[3];`,
          `const h = defaultTimerHost(${JSON.stringify(dir)}, process.execPath, ${JSON.stringify(stub)});`,
          // launchd's load-time run comes before the time: ignore it, as fire does.
          // Each job's own time: the re-armed job's load-time run (launchd) must not count either.
          `if (Date.now() < (name === ${JSON.stringify(id)} ? ${at} : ${rearmAt}) - 1000) process.exit(0);`,
          `appendFileSync(${JSON.stringify(marker)}, "fire " + name + "\\n");`,
          `if (name === ${JSON.stringify(id)}) {`,
          `  const r = armTimer(${JSON.stringify(id)}, ${rearmAt}, h, 1);`,
          `  appendFileSync(${JSON.stringify(marker)}, "armed " + r.ok + "\\n");`,
          `  cancelTimer(${JSON.stringify(id)}, h, true, timerName(${JSON.stringify(id)}, 1));`,
          `}`,
        ].join("\n"),
      );
      try {
        expect(armTimer(id, at, h)).toEqual({ ok: true, via: kind });
        const lines = () =>
          existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [];
        const deadline = rearmAt + 60_000;
        while (Date.now() < deadline && !lines().includes(`fire ${id}-r1`))
          await new Promise((r) => setTimeout(r, 1000));
        expect(lines()).toEqual([`fire ${id}`, "armed true", `fire ${id}-r1`]);
      } finally {
        cancelTimer(id, h);
        await new Promise((r) => setTimeout(r, 2500));
        expect(timerArmed(id, h)).toBe(false);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    4 * 60_000,
  );
});
