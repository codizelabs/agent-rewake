import { ScheduleStore } from "../core/store.js";
import type { Finding } from "../doctor.js";
import type { PlaceId } from "../install/detect.js";
import type { HostAdapter } from "./host.js";
import { hooksTurnedOff } from "./policy.js";

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
  when: (at: number, now: number) => string;
}

const DAY = 24 * 60 * 60 * 1000;

export function diagnoseOutside(f: OutsideFacts): Finding[] {
  const out: Finding[] = [];
  if (f.previews.length === 0) return out;
  const add = (x: Omit<Finding, "area">) => out.push({ area: "Outside Zed", ...x });

  for (const p of f.previews) {
    const off = hooksTurnedOff(p.id, f.env, f.home);
    if (off)
      add({
        level: "problem",
        text: `${p.name} has its hooks turned off, so Rewake can't see its usage limits.`,
        fix: `Turn hooks back on in ${p.name}'s settings, or take Rewake out of it: agent-rewake uninstall --only ${p.id}`,
      });
  }

  if (!f.hasTimer)
    add({
      level: "problem",
      text: "Rewake can't continue sessions outside Zed by itself on this computer: it has no scheduler Rewake can use.",
      fix:
        f.platform === "linux"
          ? "Sign in to a normal desktop session, or install and start the at service."
          : "Run agent-rewake doctor again after a restart; if it stays, report it with agent-rewake doctor --details.",
    });

  const resumes = new ScheduleStore(f.stateDir).list().filter((s) => s.host !== undefined);
  const name = (host: string | undefined) => (host && f.hosts.get(host)?.name) || host || "";
  const upcoming = resumes
    .filter((s) => s.status === "scheduled" || s.status === "sending")
    .sort((a, b) => a.dueAt - b.dueAt);
  const needsYou = resumes.filter((s) => s.status === "needs_attention");
  const recent = (s: { dueAt: number }) => s.dueAt > f.now - 7 * DAY;
  const missed = resumes.filter((s) => s.status === "missed" && recent(s));
  const failed = resumes.filter((s) => s.status === "failed" && recent(s));
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;

  const next = upcoming[0];
  if (next)
    add({
      level: "ok",
      text: `${n(upcoming.length, "planned resume")}; the next one continues ${name(next.host)} ${f.when(next.dueAt, f.now)}. Keep this computer on and awake then.`,
    });
  if (needsYou.length > 0)
    add({
      level: "todo",
      text: `${n(needsYou.length, "resume")} need${needsYou.length === 1 ? "s" : ""} you.`,
      fix: `Review ${needsYou.length === 1 ? "it" : "them"} with: agent-rewake ui`,
    });
  if (missed.length > 0)
    add({
      level: "info",
      text: `${n(missed.length, "resume")} ${missed.length === 1 ? "was" : "were"} missed in the last 7 days (the computer was off or asleep at the time).`,
    });
  if (failed.length > 0)
    add({
      level: "info",
      text: `${n(failed.length, "resume")} failed in the last 7 days.`,
      fix: "See why with: agent-rewake ui",
    });
  if (out.length === 0)
    add({
      level: "ok",
      text: `Set up in ${f.previews.map((p) => p.name).join(", ")}. Nothing planned right now.`,
    });
  return out;
}
