import { RESET_MARGIN_MS } from "./core/resume.js";
import { loadSettings, saveSettings } from "./core/settings.js";
import { ScheduleStore, TERMINAL_STATUSES } from "./core/store.js";
import { formatAt, formatWhen, parseWhen } from "./core/time.js";
import {
  armClosed,
  armedText,
  type ClosedDeps,
  type ClosedHost,
  placeOf,
  unanswered,
} from "./hosts/closed.js";
import { type SessionRecord, SessionRecords } from "./hosts/sessions.js";

/**
 * `agent-rewake continue`: continue a closed agent session after its usage limit resets. For the
 * agents that can't ask inside the session (Copilot CLI, Grok, Gemini CLI, Antigravity CLI), the
 * notification at the end of a limited session names this command.
 *
 * One session waiting with a known reset: it's armed at once (the person asked to continue).
 * Several: a numbered list first. No reset time known: preset times, or another one.
 * `--always` / `--ask` turn automatic resume on or off; `--cancel` cancels pending resumes.
 */
export interface ContinueOptions {
  /** `--always`, `--ask` or `--cancel`; none: choose a session to continue. */
  mode?: "always" | "ask" | "cancel";
  hosts: ClosedHost[];
  deps: ClosedDeps;
  interactive: boolean;
  out: (text: string) => void;
  /** Ask a question; resolves with the typed answer. */
  ask: (question: string) => Promise<string>;
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
      if (record.open) continue;
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
        ? "From now on, when a session stops at a usage limit that resets within a day, Rewake continues it by itself once the session is closed. To be asked again: agent-rewake continue --ask\n"
        : 'Rewake will ask again: after a usage limit, run "agent-rewake continue" to continue a session.\n',
    );
    return 0;
  }
  if (o.mode === "cancel") {
    const store = new ScheduleStore(o.deps.stateDir);
    const ids = new Set(o.hosts.map((h) => h.id));
    const pending = store
      .list()
      .filter((s) => s.host !== undefined && ids.has(s.host) && !TERMINAL_STATUSES.has(s.status));
    if (pending.length === 0) {
      o.out("Nothing to cancel: Rewake isn't set to continue any session.\n");
      return 0;
    }
    for (const s of pending) {
      store.update(s.scheduleId, (x) => ({ ...x, status: "cancelled" }), now);
      o.deps.disarm(s.scheduleId);
      const host = o.hosts.find((h) => h.id === s.host);
      o.out(`Cancelled: ${host ? placeOf(host, s.cwd) : "a session"} ${formatAt(s.dueAt, now)}.\n`);
    }
    return 0;
  }
  const list = waiting(o);
  if (list.length === 0) {
    o.out("Nothing to continue: no closed session is stopped at a usage limit.\n");
    return 0;
  }
  const line = (c: Candidate) =>
    `${placeOf(c.host, c.record.cwd)}: stopped ${formatAt(c.record.limit?.seenAt ?? now, now)}${
      c.resetsAt && c.resetsAt + RESET_MARGIN_MS > now
        ? `; Rewake can continue it ${formatAt(c.resetsAt + RESET_MARGIN_MS, now)}`
        : ""
    }`;
  if (!o.interactive) {
    o.out(
      `${list.map((c) => `  ${line(c)}`).join("\n")}\nRun "agent-rewake continue" in a terminal to choose.\n`,
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
  let at: number;
  if (chosen.resetsAt && chosen.resetsAt + RESET_MARGIN_MS > now) {
    at = chosen.resetsAt + RESET_MARGIN_MS;
  } else {
    // The reset time isn't known: a few times with their clock time, or another one.
    const presets = [1, 3, 5].map((h) => ({ h, at: now + h * 3_600_000 }));
    o.out(
      `When should Rewake continue ${place}?\n${presets
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
  armClosed(chosen.host, chosen.record, at, o.deps);
  o.out(`${armedText(chosen.host, chosen.record.cwd, at, now)}\n`);
  if (settings.newThreads !== "on")
    o.out(
      "To let Rewake do this by itself next time (when the reset is within a day): agent-rewake continue --always\n",
    );
  return 0;
}
