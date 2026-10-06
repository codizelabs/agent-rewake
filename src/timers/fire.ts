import { basename } from "node:path";
import { SessionLock } from "../core/lock.js";
import {
  backoffMs,
  decideFire,
  type FireDecision,
  MAX_REARMS,
  RESET_MARGIN_MS,
} from "../core/resume.js";
import { loadSettings } from "../core/settings.js";
import { type Schedule, ScheduleStore } from "../core/store.js";
import { formatAt, formatWhen } from "../core/time.js";
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
  return folder ? `${host.name} in the "${folder}" folder` : host.name;
}

/** Why a send failed, when the host knows: named so the person can fix it. */
export type FailCause = "signed-out" | "archived" | "deleted";

export interface NoticeFacts {
  /** "thread" (Codex, Zed) or "session" (Copilot, Grok): the host's own word. */
  noun: string;
  /** The agent's name for sign-in hints: "Codex". */
  agentName: string;
  /** How the person gets back to it: "resume the thread in Codex" (default "open the thread"). */
  reopen?: string;
  /** How the person asks again (HostAdapter.again). */
  again?: (at: string | undefined) => string;
  /** When the resume was due (for "late"). */
  dueAt?: number;
  /** A later reset the agent reported (for "far-reset" and "expired"). */
  resetsAt?: number;
  cause?: FailCause;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The notification for a resume Rewake won't send on its own. Plain words, no message text. */
export function notice(
  why: "late" | "open" | "far-reset" | "expired" | "failed",
  agent: string,
  now: number,
  f: NoticeFacts,
): string {
  const n = f.noun;
  const reopen = f.reopen ?? `open the ${n}`;
  // How the person asks again: for the reset the agent reported, else with a time of their own.
  const later = f.again
    ? f.again(f.resetsAt ? formatAt(f.resetsAt + RESET_MARGIN_MS, now) : undefined)
    : f.resetsAt
      ? `${cap(reopen)} after ${formatWhen(f.resetsAt, now)} to continue.`
      : `${cap(reopen)} when the limit resets to continue.`;
  switch (why) {
    case "open":
      return `${agent}: the usage limit has reset. The ${n} is open, so Rewake didn't send anything. Continue it there.`;
    case "late":
      return `${agent}: Rewake was due to continue the ${n}${f.dueAt ? ` ${formatAt(f.dueAt, now)}` : ""}, but couldn't run then (the computer may have been off or asleep). ${cap(reopen)} to continue.`;
    case "far-reset":
      return f.again
        ? `${agent} hit its usage limit again, so Rewake didn't continue. ${later}`
        : `${agent} is limited again until ${f.resetsAt ? formatWhen(f.resetsAt, now) : "later"}, so Rewake didn't continue. ${cap(reopen)} after that to continue.`;
    case "expired":
      return `${agent} is still at its usage limit, so Rewake didn't continue. ${later}`;
    case "failed":
      if (f.cause === "signed-out")
        return `${agent}: Rewake couldn't continue the ${n} because you're signed out of ${f.agentName}. Sign in, then ${reopen} to continue.`;
      if (f.cause === "archived")
        return `${agent}: Rewake couldn't continue the ${n} because it's archived. Unarchive it, then ${reopen} to continue.`;
      if (f.cause === "deleted")
        return `${agent}: Rewake couldn't continue the ${n} because it no longer exists.`;
      return `${agent}: Rewake couldn't continue the ${n}. ${cap(reopen)} to continue.`;
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
    const tell = (
      why: Parameters<typeof notice>[0],
      status: Schedule["status"],
      cause?: FailCause,
    ): FireOutcome => {
      settle(status, cause ?? why);
      // Keep the later reset the agent reported, so asking again ("rewake") continues then.
      if (facts.newResetsAt !== undefined && (why === "far-reset" || why === "expired"))
        store.update(id, (x) => ({ ...x, dueAt: (facts.newResetsAt ?? 0) + RESET_MARGIN_MS }), now);
      deps.notify(
        "Agent Rewake",
        notice(why, at, now, {
          noun: host.noun,
          agentName: host.name,
          ...(host.reopen !== undefined && { reopen: host.reopen }),
          ...(host.again !== undefined && { again: host.again }),
          dueAt: s.dueAt,
          ...(facts.newResetsAt !== undefined && { resetsAt: facts.newResetsAt }),
          ...(cause && { cause }),
        }),
      );
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
        const cause = ["signed-out", "archived", "deleted"].includes(result.detail ?? "")
          ? (result.detail as FailCause)
          : undefined;
        return tell("failed", "failed", cause);
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
