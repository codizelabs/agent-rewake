import { basename } from "node:path";
import { type Schedule, ScheduleStore, TERMINAL_STATUSES } from "../core/store.js";
import { ThreadStore } from "../core/threads.js";
import { formatWhen, TEXT_LOCALE } from "../core/time.js";
import { rewake } from "../util/command.js";
import { printable } from "../util/printable.js";
import { VERSION } from "../version.js";

/** User-facing status words. */
export const STATUS_WORDS: Record<Schedule["status"], string> = {
  scheduled: "Scheduled",
  paused: "Paused",
  queued: "Queued",
  waiting_for_limit: "Waiting for limit",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  missed: "Missed",
  stopped: "Stopped",
  cancelled: "Cancelled",
  needs_attention: "Needs you",
};

export interface ThreadGroup {
  sessionId: string;
  title: string;
  /** Zed's agent id, e.g. "claude-acp" (unknown for threads from older versions). */
  agentId: string | undefined;
  /** The agent's name for people, e.g. "Claude Agent". */
  agent: string;
  cwd: string;
  autoResume: boolean;
  schedules: Schedule[];
}

export interface ProjectGroup {
  cwd: string;
  name: string;
  threads: ThreadGroup[];
}

/** All schedules, grouped by project then thread. Finished ones only with `all`. */
export function overview(stateDir: string, all = false): ProjectGroup[] {
  const store = new ScheduleStore(stateDir);
  const threads = new ThreadStore(stateDir);
  const schedules = store.list().filter((s) => all || !TERMINAL_STATUSES.has(s.status));
  const byThread = new Map<string, ThreadGroup>();
  for (const s of schedules) {
    let t = byThread.get(s.sessionId);
    if (!t) {
      const settings = threads.get(s.sessionId);
      t = {
        sessionId: s.sessionId,
        title: printable(settings?.title ?? `Thread ${s.sessionId.slice(0, 8)}`),
        agentId: settings?.agentId,
        agent: settings?.agentName ?? settings?.agentId ?? "—",
        cwd: printable(s.cwd || settings?.cwd || ""),
        autoResume: settings?.autoResume ?? false,
        schedules: [],
      };
      byThread.set(s.sessionId, t);
    }
    t.schedules.push(s);
  }
  const byProject = new Map<string, ProjectGroup>();
  for (const t of byThread.values()) {
    const key = projectKey(t.cwd);
    let p = byProject.get(key);
    if (!p) {
      p = {
        cwd: t.cwd,
        name: t.cwd ? printable(basename(t.cwd)) : "(unknown project)",
        threads: [],
      };
      byProject.set(key, p);
    }
    p.threads.push(t);
  }
  return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One key per project folder. Windows paths are case-insensitive and accept either slash, so
 * `c:\\work\\api` and `C:/work/api/` are the same project there.
 */
export function projectKey(cwd: string, p: NodeJS.Platform = process.platform): string {
  if (p !== "win32" && !/^[A-Za-z]:[\\/]/.test(cwd)) return cwd;
  return cwd.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function oneLine(text: string, max = 70): string {
  const t = printable(text).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Plain-text listing for `agent-rewake schedules`. */
export function overviewText(groups: ProjectGroup[], now: number, locale?: string): string {
  if (groups.length === 0) return "No scheduled messages.";
  const out: string[] = [];
  for (const p of groups) {
    out.push(`${p.name}  (${p.cwd})`);
    for (const t of p.threads) {
      out.push(`  ${t.title}${t.autoResume ? "  [automatic resume on]" : ""}`);
      for (const s of t.schedules) {
        out.push(
          `    ${formatWhen(s.dueAt, now, locale)} · ${STATUS_WORDS[s.status]} · ${oneLine(s.text)}  [${s.scheduleId.slice(0, 8)}]`,
        );
      }
    }
  }
  return out.join("\n");
}

/** Markdown overview, opened in a Zed tab via `/rewake page`. */
export function overviewMarkdown(groups: ProjectGroup[], now: number, locale?: string): string {
  const generated = new Intl.DateTimeFormat(locale ?? TEXT_LOCALE, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(now);
  const lines = [
    "# Agent Rewake: scheduled messages",
    "",
    `Snapshot taken ${generated} by Agent Rewake ${VERSION}. To manage them, run the "Agent Rewake: schedules" task in Zed (\`${rewake("ui")}\`), or use \`/rewake list\` in a thread.`,
    "",
  ];
  if (groups.length === 0) lines.push("No scheduled messages.");
  for (const p of groups) {
    lines.push(`## ${p.name}`, "", `\`${p.cwd}\``, "");
    for (const t of p.threads) {
      lines.push(`### ${t.title}`, "");
      if (t.autoResume) lines.push("Automatic resume after usage limits: **on**", "");
      lines.push("| When | Status | Kind | Message |", "|---|---|---|---|");
      for (const s of t.schedules) {
        const kind = s.kind === "user" ? "Message" : "Resume";
        lines.push(
          `| ${formatWhen(s.dueAt, now, locale)} | ${STATUS_WORDS[s.status]} | ${kind} | ${oneLine(s.text).replace(/\|/g, "\\|")} |`,
        );
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}
