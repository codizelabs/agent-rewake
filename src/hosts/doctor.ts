import { ScheduleStore } from "../core/store.js";
import type { Finding } from "../doctor.js";
import type { PlaceId } from "../install/detect.js";
import type { TimerKind } from "../timers/timers.js";
import { waiterNote } from "../timers/waiter.js";
import { rewake } from "../util/command.js";
import { claudeCodeRecords } from "./claude-code/records.js";
import type { HostAdapter } from "./host.js";
import { hooksTurnedOff } from "./policy.js";
import { AGENT_VERSIONS, newerThanTested, tooOld, untestedText } from "./versions.js";

/**
 * `doctor`'s "Outside Zed" section: the previews set up here (plan §6). Offline: Rewake's own
 * records, the agents' settings files (src/hosts/policy.ts) and whether this computer offers a
 * timer. No folders, files or message text in what it says.
 */
export interface OutsideFacts {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  home: string;
  now: number;
  platform: NodeJS.Platform;
  /** The previews set up here, with their names (src/hosts/previews.ts). */
  previews: { id: PlaceId; name: string }[];
  /** The agents' adapters, for their names in resume lines. */
  hosts: ReadonlyMap<string, HostAdapter>;
  /** Whether this computer offers a one-shot timer (src/timers/timers.ts timerKind). */
  hasTimer: boolean;
  /** Which one (only "waiter" changes what doctor says). */
  timerKind?: TimerKind;
  /** Linux in WSL (for the waiter's fix). */
  wsl?: boolean;
  /** The agents' terminal programs here, with their versions (src/install/detect.ts terminalAgents). */
  agents?: { id: PlaceId; version?: string }[];
  when: (at: number, now: number) => string;
}

const DAY = 24 * 60 * 60 * 1000;

export function diagnoseOutside(f: OutsideFacts): Finding[] {
  const out: Finding[] = [];
  const add = (x: Omit<Finding, "area">) => out.push({ area: "Outside Zed", ...x });

  // Versions: an agent too old for Rewake, set up or not, and one newer than Rewake was tested with.
  const setUp = new Set(f.previews.map((p) => p.id));
  for (const a of f.agents ?? []) {
    const v = AGENT_VERSIONS[a.id];
    if (!v || !a.version) continue;
    if (tooOld(a.id, a.version)) {
      const set = setUp.has(a.id);
      add({
        level: set ? "problem" : "info",
        text: `${v.name} ${a.version} is too old for Rewake (it needs ${v.min} or newer), so ${set ? "Rewake may miss its usage limits" : "Rewake isn't set up for it"}.`,
        fix: `Update it with: ${v.update}${set ? "" : `, then run: agent-rewake install --only ${a.id}`}`,
      });
    } else if (setUp.has(a.id) && newerThanTested(a.id, a.version))
      add({ level: "info", text: untestedText(a.id, a.version) });
  }
  if (f.previews.length === 0) return out;

  for (const p of f.previews) {
    const off = hooksTurnedOff(p.id, f.env, f.home);
    if (off)
      add({
        level: "problem",
        text: `${p.name} has its hooks turned off, so Rewake can't see its usage limits.`,
        fix: `Turn hooks back on in ${p.name}'s settings, or take Rewake out of it: ${rewake(`uninstall --only ${p.id}`)}`,
      });
  }

  if (!f.hasTimer)
    add({
      level: "problem",
      text: "Rewake can't continue sessions outside Zed by itself on this computer: it has no scheduler Rewake can use.",
      fix:
        f.platform === "linux"
          ? "Sign in to a normal desktop session, or install and start the at service."
          : `Run ${rewake("doctor")} again after a restart; if it stays, report it with ${rewake("doctor --details")}.`,
    });

  if (f.timerKind === "waiter") add({ level: "info", ...waiterNote(f.wsl ?? false) });

  const resumes = new ScheduleStore(f.stateDir).list().filter((s) => s.host !== undefined);
  const name = (host: string | undefined) =>
    (host && f.hosts.get(host)?.name) || (host === "claude-code" ? "Claude Code" : host) || "";
  // Claude Code's continues live in its own plugin; its copies say what's planned there.
  const cc = setUp.has("claude-code") ? claudeCodeRecords(f.stateDir, f.now) : [];
  const upcoming = [
    ...resumes.filter((s) => s.status === "scheduled" || s.status === "sending"),
    ...cc
      .filter((r) => r.state === "armed" && r.fireAt !== undefined && r.fireAt > f.now - 5 * 60_000)
      .map((r) => ({ host: "claude-code", dueAt: r.fireAt as number })),
  ].sort((a, b) => a.dueAt - b.dueAt);
  const asking = cc.filter((r) => r.state === "offered" || r.state === "waiting");
  const needsYou = resumes.filter((s) => s.status === "needs_attention");
  const recent = (s: { dueAt: number }) => s.dueAt > f.now - 7 * DAY;
  const missed = resumes.filter((s) => s.status === "missed" && recent(s));
  const failed = resumes.filter((s) => s.status === "failed" && recent(s));
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;

  const next = upcoming[0];
  if (next)
    add({
      level: "ok",
      text: `${n(upcoming.length, "planned resume")}; the next one continues ${name(next.host)} ${
        next.dueAt <= f.now ? "now" : f.when(next.dueAt, f.now)
      }. Keep this computer on and awake${next.host === "claude-code" ? ", and Claude Code open," : ""} then.`,
    });
  if (asking.length > 0) {
    const where = (r: { cwd?: string }) =>
      r.cwd ? ` (in the "${r.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? r.cwd}" folder)` : "";
    add({
      level: "todo",
      text:
        asking.length === 1
          ? `1 Claude Code session${where(asking[0] as { cwd?: string })} is waiting for your answer: continue it after the reset?`
          : `${asking.length} Claude Code sessions are waiting for your answer: continue them after the reset?`,
      fix: "Answer Rewake's question there, or type /rewake.",
    });
  }
  if (needsYou.length > 0)
    add({
      level: "todo",
      text: `${n(needsYou.length, "resume")} need${needsYou.length === 1 ? "s" : ""} you.`,
      fix: `Review ${needsYou.length === 1 ? "it" : "them"} with: ${rewake("ui")}`,
    });
  if (missed.length > 0)
    add({
      level: "info",
      text: `${n(missed.length, "resume")} ${missed.length === 1 ? "was" : "were"} missed in the last 7 days (the computer was off or asleep at the time).`,
    });
  const lastFailed = [...failed].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (failed.length > 0)
    add({
      level: "info",
      text: `${n(failed.length, "resume")} failed in the last 7 days.${
        lastFailed?.failureMessage
          ? ` The last one, in ${name(lastFailed.host)}, ended with: "${lastFailed.failureMessage}"`
          : ""
      }`,
      fix: lastFailed?.failureMessage
        ? `See all of them with: ${rewake("ui")}`
        : `See why with: ${rewake("ui")}`,
    });
  if (out.length === 0)
    add({
      level: "ok",
      text: `Set up in ${f.previews.map((p) => p.name).join(", ")}. Nothing planned right now.`,
    });
  return out;
}
