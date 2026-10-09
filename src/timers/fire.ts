import { basename } from "node:path";
import { SessionLock } from "../core/lock.js";
import {
  backoffMs,
  decideFire,
  FAR_RESET_MS,
  type FireDecision,
  MAX_REARMS,
  RESET_MARGIN_MS,
} from "../core/resume.js";
import { loadSettings } from "../core/settings.js";
import { type Schedule, ScheduleStore, TERMINAL_STATUSES } from "../core/store.js";
import { formatAt, formatWhen } from "../core/time.js";
import { type HostAdapter, type HostFacts, onResumeRun, RESUME_TIMEOUT_MS } from "../hosts/host.js";
import { rewake } from "../util/command.js";
import { type Wake, Wakefulness } from "../util/keep-awake.js";
import type { LogFields } from "../util/log.js";
import { killPidTree } from "../util/spawn.js";
import type { Notifier } from "./notify.js";
import { type SlotOptions, takeSlot } from "./slots.js";
import {
  armTimer,
  cancelTimer,
  nextGen,
  type TimerHost,
  timerArmed,
  timerName,
  timerStale,
} from "./timers.js";

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
/** How many times an early run sets a new timer for one resume before leaving it to the sweep. */
const MAX_EARLY_REARMS = 3;
/**
 * A send still marked "sending" after this long was cut off (a crash, a reboot): longer than any
 * host's resume run (RESUME_TIMEOUT_MS). Rewake can't tell whether the message got through, so it
 * never sends again; it tells the person instead.
 */
export const SENDING_STALE_MS = RESUME_TIMEOUT_MS + 10 * 60_000;

/** How often a running continue looks for the person's stop. */
const STOP_POLL_MS = 3_000;

/** Said when a headless continue starts: what's happening, and how to stop it. */
export function runningText(at: string, noun = "session"): string {
  return `${at}: Rewake is continuing the ${noun} now. You'll get a notification when it's done. To stop it: "${rewake("continue --cancel")}".`;
}

/** Said when a headless continue has finished. */
export function doneText(at: string, noun = "session", now: number = Date.now()): string {
  return `${at}: Rewake's run ended normally ${formatAt(now, now)}. Open the ${noun} to see what it did.`;
}

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
  /** Keeps the computer awake while the resumed turn runs (tests pass their own). */
  wake?: Wake;
  /** Which of the resume's timers started this run (`<id>-r<n>`: n), so a re-arm takes a new name. */
  timerGen?: number;
  /** Tests: how often a running continue looks for a stop. */
  stopPollMs?: number;
  /** Tests: how a running continue is stopped (default: the agent and everything it started). */
  stopRun?: (pid: number) => void;
  /** Tests: the limits on resumes starting together (src/timers/slots.ts). */
  slots?: Omit<SlotOptions, "stateDir">;
}

const LIVE = new Set<Schedule["status"]>(["scheduled", "waiting_for_limit", "cancelled"]);

/** "Codex in agent-rewake": the agent and the project folder's name, so the person knows which. */
function where(host: HostAdapter, s: Schedule): string {
  const folder = s.cwd ? basename(s.cwd) : "";
  return folder ? `${host.name} in the "${folder}" folder` : host.name;
}

/** Why a send failed, when the host knows: named so the person can fix it. */
export type FailCause =
  | "signed-out"
  | "archived"
  | "deleted"
  | "timeout"
  | "missing-key"
  | "window-closed"
  | "needs-approval"
  | "folder-gone";

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
  why: "late" | "open" | "changed" | "far-reset" | "expired" | "failed" | "unconfirmed",
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
    case "changed":
      return `${agent}: the usage limit has reset, but the ${n} has changed since it stopped, so Rewake didn't send anything. ${cap(reopen)} to see where it stands and continue.`;
    case "late":
      return `${agent}: Rewake was due to continue the ${n}${f.dueAt ? ` ${formatAt(f.dueAt, now)}` : ""}, but couldn't run then (the computer may have been off or asleep). ${cap(reopen)} to continue.`;
    case "far-reset":
      return f.again
        ? `${agent} hit its usage limit again, so Rewake didn't continue. ${later}`
        : `${agent} is limited again until ${f.resetsAt ? formatWhen(f.resetsAt, now) : "later"}, so Rewake didn't continue. ${cap(reopen)} after that to continue.`;
    case "expired":
      return `${agent} is still at its usage limit, so Rewake didn't continue. ${later}`;
    case "unconfirmed":
      return `${agent}: Rewake started continuing the ${n}${f.dueAt ? ` ${formatAt(f.dueAt, now)}` : ""}, but was interrupted (the computer may have restarted), so it can't tell whether its message was sent. It won't send it again. ${cap(reopen)} to check, and continue if needed.`;
    case "failed":
      if (f.cause === "timeout")
        return `${agent}: Rewake continued the ${n}${f.dueAt ? ` ${formatAt(f.dueAt, now)}` : ""}, but the agent was still working three hours later, so Rewake stopped the run. ${cap(reopen)} to see where it got to and continue.`;
      if (f.cause === "signed-out")
        return `${agent}: Rewake couldn't continue the ${n} because you're signed out of ${f.agentName}. Sign in, then ${reopen} to continue.`;
      if (f.cause === "archived")
        return `${agent}: Rewake couldn't continue the ${n} because it's archived. Unarchive it, then ${reopen} to continue.`;
      if (f.cause === "missing-key")
        return `${agent}: Rewake couldn't continue the ${n} because it used a key or token from your shell, and Rewake never stores those. ${cap(reopen)} to continue. Next time, sign in to ${f.agentName} and remove the key from your shell profile.`;
      if (f.cause === "window-closed")
        return `${agent}: the time you chose has come, but Rewake couldn't continue the ${n} (was its window closed or reloaded?). ${cap(reopen)} to continue.`;
      if (f.cause === "folder-gone")
        return `${agent}: Rewake couldn't continue the ${n} because the project folder is gone (moved, renamed or deleted). Open the ${n} from its new folder to continue.`;
      if (f.cause === "deleted")
        return `${agent}: Rewake couldn't continue the ${n} because it no longer exists.`;
      if (f.cause === "needs-approval")
        return `${agent}: Rewake continued the ${n}${f.dueAt ? ` ${formatAt(f.dueAt, now)}` : ""}, but ${f.agentName} refused a step that needs your approval, so the work may be unfinished. Rewake never approves for you. ${cap(reopen)} to see where it stopped, and approve it there.`;
      return `${agent}: Rewake couldn't continue the ${n}. ${cap(reopen)} to continue.`;
  }
}

/**
 * A timer ran before its resume's time (the time zone changed, the clock went back, or a repeated
 * daylight-saving hour made a wall-clock timer fire early). Nothing is sent. If no timer is left
 * for the right moment, one is armed again for the resume's absolute time, a new name so this
 * run's own timer is untouched. A timer that is still armed and correct (launchd runs a new job
 * once when it is loaded) is left alone, and the number of re-arms is bounded; a resume past
 * the bound waits for the next sweep, as before.
 */
function rearmEarly(id: string, store: ScheduleStore, deps: FireDeps, now: number): FireOutcome {
  const s = store.get(id);
  if (s?.status !== "scheduled" || !deps.timers) return "early";
  if ((s.earlyRearms ?? 0) >= MAX_EARLY_REARMS) return "early";
  if (timerArmed(id, deps.timers) && !timerStale(id, s.dueAt, deps.timers)) return "early";
  const gen = nextGen(id, deps.timerGen ?? 0, deps.timers);
  const armed = armTimer(id, Math.max(s.dueAt, now + MIN_ARM_MS), deps.timers, gen);
  if (armed.ok) {
    store.update(id, (x) => ({ ...x, earlyRearms: (x.earlyRearms ?? 0) + 1 }), now);
    cancelTimer(id, deps.timers, deps.fromTimer === true, timerName(id, gen));
  }
  deps.log?.("fire.early", { armed: armed.ok });
  return "early";
}

export async function fire(id: string, deps: FireDeps): Promise<FireOutcome> {
  const store = new ScheduleStore(deps.stateDir);
  const log = deps.log ?? (() => {});
  const removeTimer = () => {
    if (deps.timers) cancelTimer(id, deps.timers, deps.fromTimer === true);
  };
  const first = store.get(id);
  if (!first) {
    removeTimer();
    return "gone";
  }
  const host = first.host ? deps.hosts.get(first.host) : undefined;
  if (!host) {
    // Zed's own resumes never have timers; a host this version doesn't know keeps its record, but
    // its timer would only come back here.
    removeTimer();
    return "not-ours";
  }
  const now = deps.now();
  if (first.status === "sending") return settleStale(id, first, host, now, deps, removeTimer);
  if (!LIVE.has(first.status)) {
    removeTimer();
    return "gone";
  }
  const lock = new SessionLock(deps.stateDir);
  const lockKey = `fire:${id}`;
  if (first.status !== "cancelled" && now < first.dueAt - EARLY_MS) {
    // Under the lock, so two early runs don't both arm.
    if (!lock.acquire(lockKey)) return "early";
    try {
      return rearmEarly(id, store, deps, now);
    } finally {
      lock.release(lockKey);
    }
  }
  if (!lock.acquire(lockKey)) return "busy";
  const slot: { release?: () => void } = {};
  const giveBack = (): void => {
    slot.release?.();
  };
  try {
    // Re-read under the lock: another run may have sent or changed it since.
    const s = store.get(id);
    if (!s || !LIVE.has(s.status)) {
      removeTimer();
      return "gone";
    }
    if (s.status !== "cancelled" && now < s.dueAt - EARLY_MS)
      return rearmEarly(id, store, deps, now);
    // Tried again later: at `until` (at least a minute on), with a new timer name because this
    // run's own timer can't be replaced from inside it (see timers.ts). Waiting for a free place
    // (`count` false) isn't the agent's doing, so it doesn't use up the bounded re-arms.
    const wait = (until: number, why: string, count = true): FireOutcome => {
      const next = Math.max(until, now + MIN_ARM_MS);
      store.update(
        id,
        (x) => ({
          ...x,
          status: "scheduled",
          dueAt: next,
          ...(count && { rearms: (x.rearms ?? 0) + 1 }),
        }),
        now,
      );
      let armed: ReturnType<typeof armTimer> | undefined;
      if (deps.timers) {
        const gen = nextGen(id, deps.timerGen ?? 0, deps.timers);
        armed = armTimer(id, next, deps.timers, gen);
        if (armed.ok) cancelTimer(id, deps.timers, deps.fromTimer === true, timerName(id, gen));
      }
      log("fire.wait", { why, armed: armed?.ok ?? false });
      return "waiting";
    };
    // Several resumes due together: wait for one of a few places and for this one's turn, so they
    // don't all start in the same second (src/timers/slots.ts). Throttling never stops a resume.
    if (s.status !== "cancelled") {
      const place = await takeSlot({ stateDir: deps.stateDir, ...deps.slots }).catch(
        () => "error" as const,
      );
      if (place === undefined) return wait(now + MIN_ARM_MS, "no-free-place", false);
      // On an error, carried on without a place: throttling is best effort.
      if (place !== "error") slot.release = place;
    }
    // The person's 12- or 24-hour clock, for notifications, and whether to keep the computer awake.
    const settings = loadSettings(deps.stateDir);
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
    const settle = (status: Schedule["status"], failureReason?: string, failureMessage?: string) =>
      store.update(
        id,
        (x) => ({
          ...x,
          status,
          ...(failureReason !== undefined && { failureReason }),
          ...(failureMessage !== undefined && { failureMessage }),
          lastRun: { at: now, outcome: status },
        }),
        now,
      );
    const tell = (
      why: Parameters<typeof notice>[0],
      status: Schedule["status"],
      cause?: FailCause,
      message?: string,
    ): FireOutcome => {
      settle(status, cause ?? why, message);
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
        // Checked again as it's claimed: the person may have cancelled, or typed in the session,
        // while the host was being checked. Their change wins and nothing is sent.
        const claimed = store.update(
          id,
          (x) =>
            x.status !== s.status || x.dueAt !== s.dueAt
              ? undefined
              : {
                  ...x,
                  status: "sending",
                  attempts: [
                    ...x.attempts,
                    {
                      n: x.attempts.length + 1,
                      idempotencyKey: key,
                      startedAt: now,
                      outcome: "sending",
                    },
                  ],
                },
          now,
        );
        if (claimed?.status !== "sending") {
          log("fire.changed", { status: claimed?.status ?? "gone" });
          if (!claimed || TERMINAL_STATUSES.has(claimed.status) || claimed.status === "cancelled")
            removeTimer();
          return "gone";
        }
        let result: Awaited<ReturnType<HostAdapter["send"]>>;
        // Most hosts run the whole resumed turn here: don't let the computer idle to sleep in it.
        const wake = deps.wake ?? new Wakefulness();
        wake.set(true, settings.keepAwake);
        // A headless run is said when it starts, with how to stop it. `continue --cancel` marks the
        // attempt stopped; this process, which started the agent, then ends its own child.
        let watch: ReturnType<typeof setInterval> | undefined;
        onResumeRun((pid) => {
          store.update(
            id,
            (x) => ({
              ...x,
              attempts: x.attempts.map((a) => (a.idempotencyKey === key ? { ...a, pid } : a)),
            }),
            now,
          );
          deps.notify("Agent Rewake", runningText(at, host.noun));
          watch = setInterval(() => {
            if (!store.get(id)?.attempts.find((a) => a.idempotencyKey === key)?.stopped) return;
            clearInterval(watch);
            // The whole tree: on Windows, ending the agent alone leaves what it started running.
            (deps.stopRun ?? killPidTree)(pid);
          }, deps.stopPollMs ?? STOP_POLL_MS);
        });
        try {
          result = await host.send(s, key);
        } catch (err) {
          result = { ok: false, reason: "failed", detail: (err as Error).message };
        } finally {
          onResumeRun(undefined);
          if (watch) clearInterval(watch);
          wake.release();
        }
        // The person stopped the run (`continue --cancel`): nothing to report back to them.
        if (store.get(id)?.attempts.find((a) => a.idempotencyKey === key)?.stopped) {
          settle("stopped", "you");
          removeTimer();
          log("fire.stopped", {});
          return "skipped";
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
          // A headless run worked until now: say it's done (an app-delivered send has nothing more).
          if (store.get(id)?.attempts.find((a) => a.idempotencyKey === key)?.pid !== undefined)
            deps.notify("Agent Rewake", doneText(at, host.noun, deps.now()));
          return "sent";
        }
        // Limited again or busy: try later, within the same bound as decideFire. A reset the run's
        // output gave is waited for, as a usage check's would be (a weekly limit outlasts backoff).
        if (result.reason === "limited" || result.reason === "busy") {
          const rearms = s.rearms ?? 0;
          const reset = result.reason === "limited" ? result.resetsAt : undefined;
          if (reset !== undefined && reset > now) facts = { ...facts, newResetsAt: reset };
          if (rearms >= MAX_REARMS) return tell("expired", "failed");
          if (reset !== undefined && reset > now) {
            if (reset - now > FAR_RESET_MS) return tell("far-reset", "needs_attention");
            return wait(reset + RESET_MARGIN_MS, "still-limited");
          }
          return wait(now + backoffMs(rearms), result.reason);
        }
        const cause = [
          "signed-out",
          "archived",
          "deleted",
          "timeout",
          "missing-key",
          "window-closed",
          "needs-approval",
          "folder-gone",
        ].includes(result.detail ?? "")
          ? (result.detail as FailCause)
          : undefined;
        return tell("failed", "failed", cause, result.message);
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
    giveBack();
    lock.release(lockKey);
  }
}

/**
 * A resume left "sending": either its run is still going (it holds the lock) or it was cut off.
 * Cut off and old enough, it's settled as needs-attention and the person is told; never re-sent.
 */
function settleStale(
  id: string,
  s: Schedule,
  host: HostAdapter,
  now: number,
  deps: FireDeps,
  removeTimer: () => void,
): FireOutcome {
  const started = s.attempts.at(-1)?.startedAt ?? s.updatedAt;
  if (now - started < SENDING_STALE_MS) return "busy";
  const lock = new SessionLock(deps.stateDir);
  const lockKey = `fire:${id}`;
  if (!lock.acquire(lockKey)) return "busy";
  try {
    const store = new ScheduleStore(deps.stateDir);
    if (store.get(id)?.status !== "sending") return "gone";
    // The agent's own files show the message arrived: it was sent, nothing to tell.
    if (host.delivered?.(s) === true) {
      store.update(
        id,
        (x) => ({ ...x, status: "sent", lastRun: { at: now, outcome: "sent" } }),
        now,
      );
      removeTimer();
      return "sent";
    }
    store.update(
      id,
      (x) => ({
        ...x,
        status: "needs_attention",
        failureReason: "unconfirmed",
        lastRun: { at: now, outcome: "needs_attention" },
      }),
      now,
    );
    deps.notify(
      "Agent Rewake",
      notice("unconfirmed", where(host, s), now, {
        noun: host.noun,
        agentName: host.name,
        ...(host.reopen !== undefined && { reopen: host.reopen }),
        dueAt: s.dueAt,
      }),
    );
    deps.log?.("fire.unconfirmed", { host: host.id });
    removeTimer();
    return "notified";
  } finally {
    lock.release(lockKey);
  }
}
