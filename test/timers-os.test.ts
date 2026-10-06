import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        expect(lines.at(-1)).toBe(`fire ${id}`);
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
});
