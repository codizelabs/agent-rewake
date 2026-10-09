import { ScheduleStore, TERMINAL_STATUSES } from "../core/store.js";
import type { HostAdapter } from "../hosts/host.js";
import { SENDING_STALE_MS } from "./fire.js";
import {
  type ArmResult,
  armTimer,
  cancelTimer,
  type TimerHost,
  timerArmed,
  timerIds,
  timerStale,
} from "./timers.js";

/**
 * Keeping resumes on time without a background process (plan §5). Timers can be lost: macOS
 * doesn't reload a plist from Rewake's folder at login, and Linux's transient units go with a
 * reboot. So every Rewake run that can (each hook, `doctor`, `ui`, `install`) sweeps: a resume
 * without a live timer gets one, and one that is due is handed to a detached `fire`. A hook never
 * sends itself: hooks have budgets of seconds and may be starting the very session concerned.
 */

/** Closer than this, arming isn't worth it (systemd never fires a past time): fire instead. */
export const FIRE_NOW_MS = 30_000;

export interface SweepDeps {
  stateDir: string;
  now: number;
  hosts: ReadonlyMap<string, HostAdapter>;
  timers?: TimerHost;
  /** Start `fire <id>` detached, so this process can exit. */
  fireDetached: (id: string) => void;
}

/** Arm a resume's timer, or fire it now when its time is close or past. */
export function scheduleFire(id: string, at: number, deps: SweepDeps): ArmResult | "fired" {
  if (at - deps.now <= FIRE_NOW_MS) {
    deps.fireDetached(id);
    return "fired";
  }
  if (!deps.timers) return { ok: false, reason: "no-scheduler" };
  return armTimer(id, at, deps.timers);
}

/**
 * Timers whose resume is gone or finished (a cancelled or sent resume whose timer was never
 * removed, a state folder cleaned by hand) are taken out. Removed after a short delay where a
 * timer may still be finishing its own run (src/timers/timers.ts cancelTimer).
 */
function removeOrphanTimers(deps: SweepDeps, all: ReturnType<ScheduleStore["list"]>): number {
  if (!deps.timers) return 0;
  const byId = new Map(all.map((s) => [s.scheduleId, s]));
  let removed = 0;
  for (const id of timerIds(deps.timers)) {
    const s = byId.get(id);
    if (s && !TERMINAL_STATUSES.has(s.status)) continue;
    cancelTimer(id, deps.timers, true);
    removed++;
  }
  return removed;
}

/** Re-arm lost timers and fire due resumes. Returns how many of each, for tests and logs. */
export function sweep(deps: SweepDeps): { fired: number; armed: number; removed: number } {
  let fired = 0;
  let armed = 0;
  const all = new ScheduleStore(deps.stateDir).list();
  const removed = removeOrphanTimers(deps, all);
  if (deps.hosts.size === 0) return { fired, armed, removed };
  for (const s of all) {
    if (!s.host || !deps.hosts.has(s.host)) continue;
    // A send cut off by a crash or reboot: `fire` settles it and tells the person.
    if (s.status === "sending") {
      const started = s.attempts.at(-1)?.startedAt ?? s.updatedAt;
      if (deps.now - started >= SENDING_STALE_MS) {
        deps.fireDetached(s.scheduleId);
        fired++;
      }
      continue;
    }
    if (s.status !== "scheduled") continue;
    if (s.dueAt - deps.now <= FIRE_NOW_MS) {
      deps.fireDetached(s.scheduleId);
      fired++;
    } else if (
      deps.timers &&
      (!timerArmed(s.scheduleId, deps.timers) || timerStale(s.scheduleId, s.dueAt, deps.timers))
    ) {
      // Lost, or set for another time zone or Node.js: armed again for the right moment.
      if (armTimer(s.scheduleId, s.dueAt, deps.timers).ok) armed++;
    }
  }
  return { fired, armed, removed };
}
