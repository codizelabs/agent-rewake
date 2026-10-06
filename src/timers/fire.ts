import { basename } from "node:path";
import { SessionLock } from "../core/lock.js";
import { backoffMs, decideFire, type FireDecision, MAX_REARMS } from "../core/resume.js";
import { loadSettings } from "../core/settings.js";
import { type Schedule, ScheduleStore } from "../core/store.js";
import { formatWhen } from "../core/time.js";
import type { HostAdapter, HostFacts } from "../hosts/host.js";
import type { LogFields } from "../util/log.js";
import type { Notifier } from "./notify.js";
import { armTimer, cancelTimer, type TimerHost } from "./timers.js";

/**
 * `agent-rewake fire <id>`: what an OS timer runs at a resume's time, for integrations outside Zed.
 * It is safe to run at any time and any number of times: it locks the resume, re-reads it, checks
 * the session through its host, lets `decideFire` (src/core/resume.ts) choose, and records the
 * result before removing its own timer. Early runs (launchd's RunAtLoad, a sweep) do nothing.
 */

/** A timer may run this much before the time and still count as on time (launchd: minute steps). */
const EARLY_MS = 30_000;
/** Never arm a timer closer than this: systemd never fires a time in the past. */
const MIN_ARM_MS = 60_000;

export type FireOutcome =
  | "early"
  | "gone"
  | "not-ours"
  | "busy"
  | "sent"
  | "waiting"
  | "notified"
  | "skipped"
  | "failed";

export interface FireDeps {
  stateDir: string;
  now: () => number;
  hosts: ReadonlyMap<string, HostAdapter>;
  /** The OS timers, or undefined where there are none. */
  timers?: TimerHost;
  notify: Notifier;
  /** Metadata-only log (src/util/log.ts). */
  log?: (event: string, fields: LogFields) => void;
  /** This run was started by the resume's own timer (macOS removes it from a detached child). */
  fromTimer?: boolean;
}

const LIVE = new Set<Schedule["status"]>(["scheduled", "waiting_for_limit", "cancelled"]);

/** "Codex in agent-rewake": the agent and the project folder's name, so the person knows which. */
function where(host: HostAdapter, s: Schedule): string {
  const folder = s.cwd ? basename(s.cwd) : "";
  return folder ? `${host.name} in ${folder}` : host.name;
}

/** The notification for a resume Rewake won't send on its own. Plain words, no message text. */
export function notice(
  why: "late" | "open" | "far-reset" | "expired" | "failed",
  agent: string,
  now: number,
  resetsAt?: number,
): string {
  switch (why) {
    case "open":
      return `${agent}: the usage limit has reset. The session is open, so Rewake didn't send anything. Continue it there.`;
    case "late":
      return `${agent}: the usage limit reset a while ago, while Rewake couldn't run, so it didn't continue on its own. Open the session to continue.`;
    case "far-reset":
      return `${agent} is limited again until ${resetsAt ? formatWhen(resetsAt, now) : "later"}. Rewake won't continue on its own; open the session after that.`;
    case "expired":
      return `${agent} is still limited, so Rewake stopped trying. Open the session when the limit resets.`;
    case "failed":
      return `${agent}: Rewake couldn't continue the session. Open it to continue.`;
  }
}

export async function fire(id: string, deps: FireDeps): Promise<FireOutcome> {
  const store = new ScheduleStore(deps.stateDir);
  const log = deps.log ?? (() => {});
  const removeTimer = () => {
    if (deps.timers) cancelTimer(id, deps.timers, deps.fromTimer === true);
  };
  const s = store.get(id);
  if (!s) {
    removeTimer();
    return "gone";
  }
  const host = s.host ? deps.hosts.get(s.host) : undefined;
  if (!host) return "not-ours";
  if (!LIVE.has(s.status)) {
    removeTimer();
    return "gone";
  }
  const now = deps.now();
  if (s.status !== "cancelled" && now < s.dueAt - EARLY_MS) return "early";

  const lock = new SessionLock(deps.stateDir);
  const lockKey = `fire:${id}`;
  if (!lock.acquire(lockKey)) return "busy";
  try {
    loadSettings(deps.stateDir); // the person's 12- or 24-hour clock, for notifications
    const key = `${id}:${s.dueAt}`;
    let facts: HostFacts = {};
    if (s.status !== "cancelled")
      try {
        facts = await host.check(s, now);
      } catch {
        // Unknown facts: decideFire treats them as "nothing stands in the way" only where safe.
      }
    const decision: FireDecision = decideFire({
      resume: {
        dueAt: s.dueAt,
        status: s.status,
        ...(s.rearms !== undefined && { rearms: s.rearms }),
      },
      now,
      ...facts,
      alreadySent: s.attempts.some((a) => a.idempotencyKey === key),
    });
    const at = where(host, s);
    const settle = (status: Schedule["status"], failureReason?: string) =>
      store.update(
        id,
        (x) => ({
          ...x,
          status,
          ...(failureReason !== undefined && { failureReason }),
          lastRun: { at: now, outcome: status },
        }),
        now,
      );
    const wait = (until: number, why: string): FireOutcome => {
      const next = Math.max(until, now + MIN_ARM_MS);
      store.update(
        id,
        (x) => ({ ...x, status: "scheduled", dueAt: next, rearms: (x.rearms ?? 0) + 1 }),
        now,
      );
      const armed = deps.timers ? armTimer(id, next, deps.timers) : undefined;
      log("fire.wait", { why, armed: armed?.ok ?? false });
      return "waiting";
    };
    const tell = (why: Parameters<typeof notice>[0], status: Schedule["status"]): FireOutcome => {
      settle(status, why);
      deps.notify("Agent Rewake", notice(why, at, now, facts.newResetsAt));
      removeTimer();
      return why === "failed" || why === "expired" ? "failed" : "notified";
    };

    log("fire.decide", {
      host: host.id,
      action: decision.action,
      why: "why" in decision ? decision.why : undefined,
    });
    switch (decision.action) {
      case "send": {
        store.update(
          id,
          (x) => ({
            ...x,
            status: "sending",
            attempts: [
              ...x.attempts,
              { n: x.attempts.length + 1, idempotencyKey: key, startedAt: now, outcome: "sending" },
            ],
          }),
          now,
        );
        let result: Awaited<ReturnType<HostAdapter["send"]>>;
        try {
          result = await host.send(s, key);
        } catch (err) {
          result = { ok: false, reason: "failed", detail: (err as Error).message };
        }
        const outcome = result.ok ? "sent" : result.reason;
        store.update(
          id,
          (x) => ({
            ...x,
            attempts: x.attempts.map((a) => (a.idempotencyKey === key ? { ...a, outcome } : a)),
          }),
          now,
        );
        if (result.ok) {
          settle("sent");
          removeTimer();
          return "sent";
        }
        // Limited again or busy: try later, within the same bound as decideFire.
        if (result.reason === "limited" || result.reason === "busy") {
          const rearms = s.rearms ?? 0;
          if (rearms >= MAX_REARMS) return tell("expired", "failed");
          return wait(now + backoffMs(rearms), result.reason);
        }
        return tell("failed", "failed");
      }
      case "wait":
        return wait(decision.until, decision.why);
      case "notify":
        return tell(decision.why, decision.why === "late" ? "missed" : "needs_attention");
      case "skip":
        if (decision.why === "expired") return tell("expired", "failed");
        if (decision.why === "typed" || decision.why === "native") settle("stopped", decision.why);
        removeTimer();
        return "skipped";
    }
  } finally {
    lock.release(lockKey);
  }
}
