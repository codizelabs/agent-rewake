import { ScheduleStore } from "../core/store.js";
import type { HostAdapter } from "../hosts/host.js";
import { type ArmResult, armTimer, type TimerHost, timerArmed } from "./timers.js";

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

/** Re-arm lost timers and fire due resumes. Returns how many of each, for tests and logs. */
export function sweep(deps: SweepDeps): { fired: number; armed: number } {
  let fired = 0;
  let armed = 0;
  if (deps.hosts.size === 0) return { fired, armed };
  for (const s of new ScheduleStore(deps.stateDir).list()) {
    if (!s.host || !deps.hosts.has(s.host) || s.status !== "scheduled") continue;
    if (s.dueAt - deps.now <= FIRE_NOW_MS) {
      deps.fireDetached(s.scheduleId);
      fired++;
    } else if (deps.timers && !timerArmed(s.scheduleId, deps.timers)) {
      if (armTimer(s.scheduleId, s.dueAt, deps.timers).ok) armed++;
    }
  }
  return { fired, armed };
}
