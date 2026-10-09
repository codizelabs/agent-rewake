import { RESET_MARGIN_MS } from "./core/resume.js";
import { loadSettings, saveSettings } from "./core/settings.js";
import { type Schedule, ScheduleStore, TERMINAL_STATUSES } from "./core/store.js";
import { formatAt, formatWhen, parseWhen } from "./core/time.js";
import {
  armClosed,
  armedText,
  type ClosedDeps,
  type ClosedHost,
  largeHistoryText,
  placeOf,
  stillOpen,
  unanswered,
} from "./hosts/closed.js";
import { type SessionRecord, SessionRecords } from "./hosts/sessions.js";
import { rewake } from "./util/command.js";
import { printable } from "./util/printable.js";
import { SLEEP_DOCS_URL, type SleepSettings, sleepRisks } from "./util/sleep-settings.js";

/**
 * `agent-rewake continue`: continue a closed agent session after its usage limit resets. For the
 * agents that can't ask inside the session (Copilot CLI, Grok, Gemini CLI, Antigravity CLI), the
 * notification at the end of a limited session names this command.
 *
 * One session waiting with a known reset: it's armed at once (the person asked to continue).
 * Several: a numbered list first. No reset time known: preset times, or another one.
 * `--always` / `--ask` turn automatic resume on or off; `--cancel` cancels pending resumes, and
 * `--cancel <id>` one of them, by the id `agent-rewake schedules` shows.
 */
export interface ContinueOptions {
  /** `--always`, `--ask` or `--cancel`; none: choose a session to continue. */
  mode?: "always" | "ask" | "cancel";
  /** With `--cancel`: only the planned resume whose id starts with this (the lists show eight). */
  cancelId?: string;
  /** Names a host that isn't in `hosts` (Codex), for a resume `cancelId` names. */
  hostOf?: (hostId: string) => NamedHost | undefined;
  hosts: ClosedHost[];
  deps: ClosedDeps;
  interactive: boolean;
  out: (text: string) => void;
  /** Where a mistake is said (stderr); `out` when absent. */
  err?: (text: string) => void;
  /** Ask a question; resolves with the typed answer. */
  ask: (question: string) => Promise<string>;
  /** Reads this computer's own sleep settings; not checked when absent. */
  sleepSettings?: () => SleepSettings;
}

interface Candidate {
  host: ClosedHost;
  record: SessionRecord;
  resetsAt?: number;
}

export function waiting(o: Pick<ContinueOptions, "hosts" | "deps">): Candidate[] {
  const out: Candidate[] = [];
  for (const host of o.hosts)
    for (const record of new SessionRecords(o.deps.stateDir, host.id).list()) {
      if (stillOpen(record, o.deps.running)) continue;
      const limit = unanswered(o.deps.stateDir, record);
      if (!limit) continue;
      out.push({ host, record, ...(limit.resetsAt !== undefined && { resetsAt: limit.resetsAt }) });
    }
  return out.sort((a, b) => (b.record.limit?.seenAt ?? 0) - (a.record.limit?.seenAt ?? 0));
}

export async function runContinue(o: ContinueOptions): Promise<number> {
  const now = o.deps.now;
  const settings = loadSettings(o.deps.stateDir);
  if (o.mode === "always" || o.mode === "ask") {
    saveSettings(o.deps.stateDir, { ...settings, newThreads: o.mode === "always" ? "on" : "ask" });
    o.out(
      o.mode === "always"
        ? `From now on, when an agent stops at a usage limit that resets within a day, Rewake continues it by itself, without asking: in new Zed threads, in Claude Code, and in closed Copilot CLI, Gemini CLI, Grok Build and Antigravity CLI sessions. To be asked again, everywhere: ${rewake("continue --ask")}\n`
        : `Rewake will ask again, in every agent: after a usage limit, run "${rewake("continue")}" to continue a closed session.\n`,
    );
    return 0;
  }
  if (o.mode === "cancel") {
    const store = new ScheduleStore(o.deps.stateDir);
    if (o.cancelId !== undefined) return cancelOne(o, store, o.cancelId);
    const ids = new Set(o.hosts.map((h) => h.id));
    const pending = store
      .list()
      .filter((s) => s.host !== undefined && ids.has(s.host) && !TERMINAL_STATUSES.has(s.status));
    if (pending.length === 0) {
      o.out("Nothing to cancel: Rewake isn't set to continue any session.\n");
      return 0;
    }
    let chosen = pending;
    // Several, in a terminal: pick one by its number, or all of them.
    if (pending.length > 1 && o.interactive) {
      o.out(
        `Planned resumes:\n${pending.map((s, i) => `  ${i + 1}. ${about(o, s)}  [${s.scheduleId.slice(0, 8)}]`).join("\n")}\n`,
      );
      const answer = (
        await o.ask(
          `Which one should Rewake cancel? (1-${pending.length}, "all" for every one, or Enter to keep them) `,
        )
      )
        .trim()
        .toLowerCase();
      const one = pending[Number(answer) - 1];
      if (answer !== "all" && !one) {
        o.out("Nothing was changed.\n");
        return 0;
      }
      chosen = one ? [one] : pending;
    }
    for (const s of chosen) await cancel(o, store, s);
    return 0;
  }
  const list = waiting(o);
  if (list.length === 0) {
    o.out("Nothing to continue: no closed session is stopped at a usage limit.\n");
    return 0;
  }
  const failedTry = (c: Candidate) =>
    new ScheduleStore(o.deps.stateDir)
      .listForSession(c.record.sessionId, c.host.id)
      .filter((s) => s.status === "failed" && s.updatedAt >= (c.record.limit?.seenAt ?? 0))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const line = (c: Candidate) => {
    const f = failedTry(c);
    return `${placeOf(c.host, c.record.cwd)}: stopped ${formatAt(c.record.limit?.seenAt ?? now, now)}${
      c.resetsAt && c.resetsAt + RESET_MARGIN_MS > now
        ? `; Rewake can continue it ${formatAt(c.resetsAt + RESET_MARGIN_MS, now)}`
        : ""
    }${
      f
        ? `; Rewake tried ${formatAt(f.lastRun?.at ?? f.updatedAt, now)}${
            f.failureMessage
              ? ` and ${c.host.name} ended with: "${f.failureMessage}"`
              : ", without success"
          }`
        : ""
    }`;
  };
  if (!o.interactive) {
    o.out(
      `${list.map((c) => `  ${line(c)}`).join("\n")}\nRun "${rewake("continue")}" in a terminal to choose.${
        list.some((c) => failedTry(c))
          ? " If a try failed, open that session in its agent to continue it yourself."
          : ""
      }\n`,
    );
    return 1;
  }

  let chosen = list[0] as Candidate;
  if (list.length > 1) {
    o.out(
      `Sessions stopped at a usage limit:\n${list.map((c, i) => `  ${i + 1}. ${line(c)}`).join("\n")}\n`,
    );
    const n = Number(
      (
        await o.ask(`Which one should Rewake continue? (1-${list.length}, or Enter to cancel) `)
      ).trim(),
    );
    const pick = Number.isInteger(n) ? list[n - 1] : undefined;
    if (!pick) {
      o.out("Nothing was changed.\n");
      return 1;
    }
    chosen = pick;
  }

  const place = placeOf(chosen.host, chosen.record.cwd);
  // Cursor's hook waits only so long after the limit: nothing later is offered or taken.
  const latest =
    chosen.host.maxWaitAfterLimitMs === undefined
      ? undefined
      : (chosen.record.limit?.seenAt ?? now) + chosen.host.maxWaitAfterLimitMs;
  const tooLate = () =>
    `Rewake can continue ${place} only until ${formatWhen(latest ?? now, now)}, 4 hours after its usage limit. Choose an earlier time, or open the ${chosen.host.noun ?? "session"} later and continue it yourself.\n`;
  if (latest !== undefined && latest - now < 5 * 60_000) {
    o.out(
      `Rewake can continue ${place} only within 4 hours of its usage limit, and that time has passed. Open the ${chosen.host.noun ?? "session"} and continue it yourself.\n`,
    );
    return 1;
  }
  let at: number;
  if (chosen.resetsAt && chosen.resetsAt + RESET_MARGIN_MS > now) {
    at = chosen.resetsAt + RESET_MARGIN_MS;
  } else {
    // The reset time isn't known: a few times with their clock time, or another one.
    const presets = [1, 3, 5]
      .map((h) => ({ h, at: now + h * 3_600_000 }))
      .filter((p) => latest === undefined || p.at <= latest);
    o.out(
      `When should Rewake continue ${place}?${latest === undefined ? "" : ` (It can wait until ${formatWhen(latest, now)}, 4 hours after the limit.)`}\n${presets
        .map(
          (p, i) => `  ${i + 1}. In ${p.h} hour${p.h === 1 ? "" : "s"} (${formatWhen(p.at, now)})`,
        )
        .join("\n")}\n  ${presets.length + 1}. Another time\n`,
    );
    const pick = (await o.ask(`Choose 1-${presets.length + 1} (Enter to cancel): `)).trim();
    const preset = presets[Number(pick) - 1];
    if (preset) at = preset.at;
    else if (pick === String(presets.length + 1)) {
      let typed = (
        await o.ask('Which time? For example "3:30pm" or "in 2h" (Enter to cancel): ')
      ).trim();
      let when = typed ? parseWhen(typed, now) : undefined;
      for (let tries = 0; typed && when && !when.ok && tries < 2; tries++) {
        typed = (
          await o.ask(
            `Rewake didn't understand "${typed}". Try "3:30pm" or "in 2h" (Enter to cancel): `,
          )
        ).trim();
        when = typed ? parseWhen(typed, now) : undefined;
      }
      if (!when?.ok) {
        o.out("Nothing was changed.\n");
        return 1;
      }
      at = when.at;
    } else {
      o.out("Nothing was changed.\n");
      return 1;
    }
  }
  if (latest !== undefined && at > latest) {
    o.out(tooLate());
    return 1;
  }
  armClosed(chosen.host, chosen.record, at, o.deps);
  o.out(`${armedText(chosen.host, chosen.record.cwd, at, now)}\n`);
  const large = largeHistoryText(chosen.host, chosen.record.historyBytes);
  if (large) o.out(`${large}\n`);
  // Nothing of Rewake's runs while it waits here, so any sleep setting counts.
  const risks = o.sleepSettings ? sleepRisks(o.sleepSettings(), "none") : [];
  if (risks.length > 0)
    o.out(
      `This computer may sleep before then: ${risks.join("; ")}. To keep it awake: ${SLEEP_DOCS_URL}\n`,
    );
  if (settings.newThreads !== "on" && latest === undefined)
    o.out(
      `To let Rewake do this by itself next time, in every agent (Zed, Claude Code and closed sessions) when the reset is within a day: ${rewake("continue --always")}\n`,
    );
  return 0;
}

/** The host of a resume, for what Rewake says about it. */
type NamedHost = Pick<ClosedHost, "name" | "noun" | "reopen">;

function hostFor(o: ContinueOptions, id: string | undefined): NamedHost | undefined {
  if (id === undefined) return undefined;
  return o.hosts.find((h) => h.id === id) ?? o.hostOf?.(id);
}

/**
 * Cancel one planned resume outside Zed. One already being sent isn't cancelled (and can be
 * stopped, if the person says so): returns whether it was cancelled or stopped.
 */
async function cancel(o: ContinueOptions, store: ScheduleStore, s: Schedule): Promise<boolean> {
  const now = o.deps.now;
  const host = hostFor(o, s.host);
  const place = host ? placeOf(host, s.cwd) : "a session";
  if (store.cancel(s.scheduleId, now)) {
    o.deps.disarm(s.scheduleId);
    o.out(`Cancelled: ${place} ${formatAt(s.dueAt, now)}.\n`);
    return true;
  }
  // A continue already under way: its message was sent, but its run can be stopped.
  const reopen = host?.reopen ?? `open the session in ${host?.name ?? "its agent"}`;
  const run = store.get(s.scheduleId)?.attempts.at(-1);
  if (s.status === "sending" && run?.pid !== undefined && !run.stopped && o.interactive) {
    const stop = /^y(es)?$/i.test(
      (
        await o.ask(
          `Rewake is continuing ${place} now. Stop it? What it has done so far stays. [y/N] `,
        )
      ).trim(),
    );
    if (stop) {
      store.update(
        s.scheduleId,
        (x) => ({
          ...x,
          attempts: x.attempts.map((a, i) =>
            i === x.attempts.length - 1 ? { ...a, stopped: true } : a,
          ),
        }),
        now,
      );
      o.out(
        `Stopping: ${place}. It ends within a few seconds, with no further notification; ${reopen} to see where it got to.\n`,
      );
      return true;
    }
  }
  o.out(
    `Not cancelled: Rewake is already continuing ${place}. It finishes on its own; ${reopen} afterwards to see what it did.\n`,
  );
  return false;
}

/** "GitHub Copilot CLI in the "shop" folder at 3:00 PM today" (a Zed message: its time only). */
function about(o: ContinueOptions, s: Schedule): string {
  const host = hostFor(o, s.host);
  return `${host ? `${placeOf(host, s.cwd)} ` : s.host === undefined ? "Zed thread " : ""}${formatAt(s.dueAt, o.deps.now)}`;
}

/** `continue --cancel <id>`: one planned resume, by the start of its id (the lists show eight). */
async function cancelOne(o: ContinueOptions, store: ScheduleStore, id: string): Promise<number> {
  const wanted = id.trim().toLowerCase();
  const found = wanted
    ? store.list().filter((s) => s.scheduleId.toLowerCase().startsWith(wanted))
    : [];
  const fail = (text: string) => {
    (o.err ?? o.out)(`agent-rewake: ${text}\n`);
    return 1;
  };
  if (found.length === 0)
    return fail(
      `No planned resume starts with "${printable(id)}". The ids are in ${rewake("schedules")}, in square brackets.`,
    );
  if (found.length > 1)
    return fail(
      `More than one starts with "${printable(id)}". Give one of these:\n${found
        .map((s) => `  ${s.scheduleId.slice(0, 8)}  ${about(o, s)}`)
        .join("\n")}`,
    );
  const s = found[0] as Schedule;
  if (s.host === undefined || s.host === "acp")
    return fail(
      `That's a message in a Zed thread: change or delete it on the schedules page (${rewake("ui")}), or in the thread's Rewake menu.`,
    );
  if (TERMINAL_STATUSES.has(s.status)) {
    const host = hostFor(o, s.host);
    o.out(
      `Nothing to cancel: the resume of ${host ? placeOf(host, s.cwd) : "that session"} ${s.status === "cancelled" ? "was already cancelled" : "has already ended"}.\n`,
    );
    return 0;
  }
  return (await cancel(o, store, s)) ? 0 : 1;
}
