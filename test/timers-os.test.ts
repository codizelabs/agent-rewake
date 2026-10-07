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
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rewake-os-timer-"));
      const marker = join(dir, "fired.txt");
      const stub = join(dir, "stub.mjs");
      writeFileSync(
        stub,
        `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      );
      const h = defaultTimerHost(dir, process.execPath, stub);
      const kind = timerKind(h);
      if (!kind) {
        console.warn("No OS timer on this computer (no systemd user manager or at): skipped.");
        return;
      }
      const id = `test-${Date.now().toString(36)}`;
      const at = Date.now() + 65_000;
      try {
        expect(armTimer(id, at, h)).toEqual({ ok: true, via: kind });
        expect(timerArmed(id, h)).toBe(true);
        const deadline = at + 60_000;
        // launchd runs a job once when it's loaded (RunAtLoad): ignore that early run.
        const due = () =>
          existsSync(marker) &&
          readFileSync(marker, "utf8")
            .trim()
            .split("\n")
            .filter(() => Date.now() >= at - 1000).length > 0;
        while (Date.now() < deadline && !(Date.now() >= at && due()))
          await new Promise((r) => setTimeout(r, 1000));
        const lines = readFileSync(marker, "utf8").trim().split("\n");
        // The timer names Rewake's state folder: it runs without Rewake's environment.
        expect(lines.at(-1)).toBe(`fire ${id} --state-dir ${dir}`);
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
    async () => {
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
      if (!kind) {
        console.warn("No OS timer on this computer: skipped.");
        return;
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
          `if (Date.now() < ${at} - 1000) process.exit(0);`,
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
