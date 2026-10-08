import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../util/paths.js";
import { type TimerHost, waiterAlive } from "./timers.js";

/**
 * `agent-rewake wait`: Rewake's own timer, for Linux without a systemd user session or the at
 * service (WSL, containers). Started detached by `armTimer` (its own session, so closing the
 * terminal doesn't end it); one per state folder. It runs `fire` for each `<name>.wait` file in
 * `<stateDir>/timers` when its time comes, re-reads them every half minute (new resumes, cancelled
 * ones, a computer that slept), and ends when none is left. It doesn't outlive a logout or restart:
 * the login item's sweep, or the next hook, starts it again.
 */

/** How long it sleeps at most between looks at the files. */
export const WAITER_POLL_MS = 30_000;

export interface WaiterDeps {
  timers: TimerHost;
  pid: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Start `fire <name>` detached. */
  fire: (name: string) => void;
}

const WAIT = /^([a-z0-9-]{1,64})\.wait$/;

function due(dir: string): { name: string; at: number }[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    const name = WAIT.exec(f)?.[1];
    if (!name) return [];
    try {
      const at = Number(readFileSync(join(dir, f), "utf8").trim());
      return Number.isFinite(at) ? [{ name, at }] : [];
    } catch {
      return [];
    }
  });
}

export async function runWaiter(d: WaiterDeps): Promise<number> {
  const dir = ensurePrivateDir(join(d.timers.stateDir, "timers"));
  const pidFile = join(dir, "waiter.pid");
  const other = waiterAlive(d.timers);
  if (other !== undefined && other !== d.pid) return 0;
  writeFileSync(pidFile, String(d.pid), { mode: 0o600 });
  const mine = () => {
    try {
      return readFileSync(pidFile, "utf8").trim() === String(d.pid);
    } catch {
      return false;
    }
  };
  for (;;) {
    // Another waiter took over (two started at once): leave the work to it.
    if (!mine()) return 0;
    const waits = due(dir);
    const now = d.now();
    for (const w of waits.filter((x) => x.at <= now)) {
      rmSync(join(dir, `${w.name}.wait`), { force: true });
      d.fire(w.name);
    }
    const left = waits.filter((x) => x.at > now);
    if (left.length === 0) {
      rmSync(pidFile, { force: true });
      // A resume armed in that moment saw this waiter running and didn't start another.
      if (due(dir).length === 0) return 0;
      writeFileSync(pidFile, String(d.pid), { mode: 0o600 });
      continue;
    }
    const next = Math.min(...left.map((x) => x.at));
    await d.sleep(Math.max(1000, Math.min(WAITER_POLL_MS, next - now)));
  }
}

/** WSL: its kernel names Microsoft (/proc/version). */
export function isWsl(version = readProcVersion()): boolean {
  return /microsoft/i.test(version);
}

function readProcVersion(): string {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}

/**
 * What `install` and `doctor` say when the waiter is the timer, and the one fix: systemd in WSL
 * (learn.microsoft.com/windows/wsl/systemd, 2026-06-02), the at service elsewhere (tested in Debian
 * 12: `apt install at`, `service atd start`, then Rewake uses at).
 */
export function waiterNote(wsl: boolean): { text: string; fix: string } {
  return {
    text: "Planned resumes run at their times while this computer stays on. With no systemd or at service here, Rewake runs them with its own background process, which stops when you log out or restart and starts again the next time you use an agent. A resume missed by more than half an hour isn't sent.",
    fix: wsl
      ? "So resumes don't wait for you after a restart, turn on systemd in WSL: add the lines [boot] and systemd=true to /etc/wsl.conf, then run wsl.exe --shutdown in Windows and open WSL again."
      : "So resumes don't wait for you after a restart, install and start the at service (Debian, Ubuntu: sudo apt install at, then sudo service atd start).",
  };
}
