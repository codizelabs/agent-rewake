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
import type { FireOutcome } from "./timers/fire.js";
import { oneLine } from "./ui/overview.js";
import { rewake } from "./util/command.js";
import { printable } from "./util/printable.js";
import { SLEEP_DOCS_URL, type SleepSettings, sleepRisks } from "./util/sleep-settings.js";

/**
 * `agent-rewake continue`: continue a closed agent session after its usage limit resets. For the
 * agents that can't ask inside the session (Copilot CLI, Grok, Gemini CLI, Qwen Code, OpenCode, Antigravity CLI), the
 * notification at the end of a limited session names this command.
 *
 * One session waiting with a known reset: it's armed at once (the person asked to continue).
 * Several: a numbered list first. No reset time known: preset times, or another one.
 * `--always` / `--ask` turn automatic resume on or off; `--cancel` cancels pending resumes, and
 * `--cancel <id>` one of them, by the id `agent-rewake schedules` shows. `--now [<id>]` runs one
 * planned resume at once, the way its timer would at the reset, for when the limit lifted early.
 */
export interface ContinueOptions {
  /** `--always`, `--ask`, `--cancel` or `--now`; none: choose a session to continue. */
  mode?: "always" | "ask" | "cancel" | "now";
  /** With `--cancel`: only the planned resume whose id starts with this (the lists show eight). */
  cancelId?: string;
  /** With `--now`: only the planned resume whose id starts with this (the lists show eight). */
  nowId?: string;
  /** With `--now`: don't ask "y/N" (`--yes`); required where there is no terminal. */
  yes?: boolean;
  /** With `--now`: what the resume's timer would run at its time (src/timers/fire.ts), at once. */
  fireNow?: (id: string) => Promise<FireOutcome>;
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
        ? `From now on, when an agent stops at a usage limit that resets within a day, Rewake continues it by itself, without asking: in new Zed threads, in Claude Code, and in closed Copilot CLI, Gemini CLI, Grok Build, Qwen Code, OpenCode and Antigravity CLI sessions. To be asked again, everywhere: ${rewake("continue --ask")}\n`
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
  if (o.mode === "now") return runNow(o);
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

/**
 * The planned resume outside Zed that an id (the start of one: the lists show eight characters)
 * names; else the exit status, after saying why not.
 */
function findOne(o: ContinueOptions, store: ScheduleStore, id: string): Schedule | number {
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
  return s;
}

/** `continue --cancel <id>`: one planned resume, by the start of its id (the lists show eight). */
async function cancelOne(o: ContinueOptions, store: ScheduleStore, id: string): Promise<number> {
  const s = findOne(o, store, id);
  if (typeof s === "number") return s;
  if (TERMINAL_STATUSES.has(s.status)) {
    const host = hostFor(o, s.host);
    o.out(
      `Nothing to cancel: the resume of ${host ? placeOf(host, s.cwd) : "that session"} ${s.status === "cancelled" ? "was already cancelled" : "has already ended"}.\n`,
    );
    return 0;
  }
  return (await cancel(o, store, s)) ? 0 : 1;
}

/** Why a host's chat can't be continued from the command line (Cursor). */
const windowReason = (h: Pick<ClosedHost, "name">) =>
  `${h.name} can only be continued from the window that is waiting for it, within 4 hours of its usage limit`;

/** What a planned resume waits in: the only states its timer's run (src/timers/fire.ts) takes up. */
const WAITING = new Set<Schedule["status"]>(["scheduled", "waiting_for_limit"]);

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * `continue --now [<id>]`: don't wait for the reset. It runs what the resume's timer would run at
 * its time, at once: every check still applies (the session open, the person having typed after
 * the limit, the agent having continued, billing limits, once only). A limit that hasn't lifted
 * changes nothing: the resume stays planned for its time.
 */
async function runNow(o: ContinueOptions): Promise<number> {
  const now = o.deps.now;
  const store = new ScheduleStore(o.deps.stateDir);
  if (!o.interactive && (o.nowId === undefined || o.yes !== true)) {
    (o.err ?? o.out)(
      `agent-rewake: There is no terminal to ask in, so nothing was sent. Give the id and --yes: ${rewake("continue --now <id> --yes")}. The ids are in ${rewake("schedules")}, in square brackets.\n`,
    );
    return 1;
  }
  let s: Schedule;
  if (o.nowId !== undefined) {
    const found = findOne(o, store, o.nowId);
    if (typeof found === "number") return found;
    s = found;
  } else {
    // Cursor's chat is continued only by its waiting window, never from here.
    const windowOf = (x: Schedule) =>
      o.hosts.find((h) => h.id === x.host && h.maxWaitAfterLimitMs !== undefined);
    const waitingHere = store
      .list()
      .filter((x) => x.host !== undefined && x.host !== "acp" && WAITING.has(x.status));
    const pending = waitingHere.filter((x) => !windowOf(x));
    if (pending.length === 0) {
      const blocked = waitingHere.map(windowOf).find((h) => h !== undefined);
      o.out(
        blocked
          ? `Nothing here can be continued now: ${windowReason(blocked)}.\n`
          : "Nothing to resume now: Rewake isn't set to continue any session.\n",
      );
      return 0;
    }
    s = pending[0] as Schedule;
    // Several: pick one by its number, as `--cancel` does.
    if (pending.length > 1) {
      // Two in folders of the same name: the full path tells them apart.
      const placeIn = (x: Schedule) => {
        const h = hostFor(o, x.host);
        return h ? placeOf(h, x.cwd) : "";
      };
      const twin = (x: Schedule) => pending.filter((y) => placeIn(y) === placeIn(x)).length > 1;
      o.out(
        `Planned resumes:\n${pending.map((x, i) => `  ${i + 1}. ${about(o, x)}${twin(x) ? ` (${printable(x.cwd)})` : ""}  [${x.scheduleId.slice(0, 8)}]`).join("\n")}\n`,
      );
      const answer = await o.ask(
        `Which one should Rewake continue now? (1-${pending.length}, or Enter to keep waiting) `,
      );
      const one = pending[Number(answer.trim()) - 1];
      if (!one) {
        o.out("Nothing was changed.\n");
        return 1;
      }
      s = one;
    }
  }
  const host = hostFor(o, s.host);
  const noun = host?.noun ?? "session";
  const place = host ? placeOf(host, s.cwd) : "that session";
  const reopen = host?.reopen ?? `open the ${noun}`;
  if (TERMINAL_STATUSES.has(s.status)) {
    o.out(
      `Nothing to continue: the resume of ${place} ${s.status === "sent" ? "was already sent" : s.status === "cancelled" ? "was cancelled" : "has already ended"}.\n`,
    );
    return 0;
  }
  if (s.status === "sending") {
    o.out(`Rewake is already continuing ${place}. It finishes on its own.\n`);
    return 1;
  }
  if (!WAITING.has(s.status)) {
    o.out(
      `The resume of ${place} isn't waiting for the reset any more (${s.status.replace("_", " ")}), so there is nothing to run now. ${capital(reopen)} to continue it yourself.\n`,
    );
    return 1;
  }
  const window = o.hosts.find((h) => h.id === s.host && h.maxWaitAfterLimitMs !== undefined);
  if (window) {
    o.out(
      `Rewake can't continue ${place} from here: ${windowReason(window)}. Type /rewake in the ${noun}, or ${reopen} to continue it yourself.\n`,
    );
    return 1;
  }
  o.out(
    `Rewake will continue ${place} now, without waiting for the reset (planned ${formatAt(s.dueAt, now)}).\n  Message, sent once as if you had typed it: "${oneLine(s.text)}"\nNothing is sent, and your resume stays planned for its time, if you typed in the ${noun} since the limit, if it is open or has changed, if the agent has already continued, if the usage limit is still on, or if the message can't reach the agent (signed out, session deleted or archived, folder gone).\nThis window stays busy until the agent finishes (up to 3 hours); waiting for a free place to run can take a few minutes. Ctrl+C stops it and cancels this planned resume.\n`,
  );
  if (o.yes !== true && !/^y(es)?$/i.test((await o.ask("Continue it now? [y/N] ")).trim())) {
    o.out("Nothing was changed.\n");
    return 1;
  }
  const outcome = (await o.fireNow?.(s.scheduleId)) ?? "not-ours";
  const after = store.get(s.scheduleId);
  switch (outcome) {
    case "sent":
      o.out(`Rewake continued ${place}. ${capital(reopen)} to see what it did.\n`);
      return 0;
    case "limited":
      o.out(
        `The usage limit is still on, so nothing was sent. Your resume is still planned for ${formatAt(s.dueAt, now)}.\n`,
      );
      return 0;
    case "open":
      o.out(
        `The ${noun} is open, so nothing was sent. Close it and run this again, or it still resumes at ${formatAt(s.dueAt, now)}.\n`,
      );
      return 1;
    case "changed":
      o.out(
        `The ${noun} has changed since it stopped, so nothing was sent. Your resume is still planned for ${formatAt(s.dueAt, now)}, and will send nothing then either. ${capital(reopen)} to continue it yourself, or cancel the plan: ${rewake(`continue --cancel ${s.scheduleId.slice(0, 8)}`)}\n`,
      );
      return 1;
    case "typed":
    case "native":
      o.out(
        `${outcome === "typed" ? `You typed in the ${noun} after the limit` : "The agent has already continued by itself"}, so nothing was sent. Your resume is still planned for ${formatAt(s.dueAt, now)}, and will send nothing then either. To remove it: ${rewake(`continue --cancel ${s.scheduleId.slice(0, 8)}`)}\n`,
      );
      return 1;
    case "skipped":
      // Stopped by the person (Ctrl+C here, or `--cancel`): that was said already.
      if (after?.failureReason !== "you") o.out("Rewake sent nothing.\n");
      return 1;
    case "busy":
      o.out(`Rewake is already working on ${place}. Try again in a minute.\n`);
      return 1;
    case "notified":
    case "failed":
      // The reason was said already, as the resume's own notice.
      if (after && WAITING.has(after.status))
        o.out(`Your resume is still planned for ${formatAt(after.dueAt, now)}.\n`);
      return 1;
    default:
      o.out(`Nothing was sent: the resume of ${place} had changed or ended.\n`);
      return 1;
  }
}
