import { basename } from "node:path";
import { explainResume } from "../core/explain.js";
import { type Schedule, ScheduleStore, TERMINAL_STATUSES } from "../core/store.js";
import { ThreadStore } from "../core/threads.js";
import { formatWhen, formatWhenFull, TEXT_LOCALE } from "../core/time.js";
import { rewake } from "../util/command.js";
import { printable } from "../util/printable.js";
import { VERSION } from "../version.js";
import { outcomeText } from "./outcome.js";

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
  /** A session of an agent outside Zed (Codex, Copilot CLI…), resumed by Rewake's own timers. */
  outsideZed: boolean;
  schedules: Schedule[];
}

export interface ProjectGroup {
  cwd: string;
  name: string;
  threads: ThreadGroup[];
}

/**
 * All schedules, grouped by project then thread. Finished ones only with `all`, which also lists
 * everything newest first (a long history is read from the top). `hostName` names the agent of a
 * session outside Zed ("Codex"), which has no thread settings of its own, and `hostNoun` says what
 * that agent calls one ("thread" in Codex; "session" when it doesn't say).
 */
export function overview(
  stateDir: string,
  all = false,
  hostName?: (host: string) => string | undefined,
  hostNoun?: (host: string) => string | undefined,
): ProjectGroup[] {
  const store = new ScheduleStore(stateDir);
  const threads = new ThreadStore(stateDir);
  const schedules = store.list().filter((s) => all || !TERMINAL_STATUSES.has(s.status));
  const byThread = new Map<string, ThreadGroup>();
  for (const s of schedules) {
    let t = byThread.get(s.sessionId);
    if (!t) {
      const settings = threads.get(s.sessionId);
      const outsideZed = isOutsideZed(s);
      const noun = outsideZed ? (hostNoun?.(s.host ?? "") ?? "session") : "thread";
      t = {
        sessionId: s.sessionId,
        title: printable(settings?.title ?? `${capital(noun)} ${s.sessionId.slice(0, 8)}`),
        agentId: settings?.agentId,
        agent:
          settings?.agentName ??
          settings?.agentId ??
          (s.host ? (hostName?.(s.host) ?? s.host) : undefined) ??
          "—",
        cwd: printable(s.cwd || settings?.cwd || ""),
        autoResume: settings?.autoResume ?? false,
        outsideZed,
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
  const projects = [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (all) {
    // Newest first at every level: schedules, threads, then projects by their newest message.
    const newest = (xs: Schedule[]) => Math.max(...xs.map((s) => s.dueAt));
    for (const p of projects)
      for (const t of p.threads) t.schedules.sort((a, b) => b.dueAt - a.dueAt);
    for (const p of projects) p.threads.sort((a, b) => newest(b.schedules) - newest(a.schedules));
    projects.sort(
      (a, b) =>
        Math.max(...b.threads.map((t) => newest(t.schedules))) -
        Math.max(...a.threads.map((t) => newest(t.schedules))),
    );
  }
  return projects;
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

/**
 * Plain-text listing for `agent-rewake schedules`. With `years` every time carries its year (a
 * listing of finished messages reaches back months), and a finished one says how it ended.
 */
export function overviewText(
  groups: ProjectGroup[],
  now: number,
  locale?: string,
  years = false,
): string {
  if (groups.length === 0) return "No scheduled messages.";
  const out: string[] = [];
  for (const p of groups) {
    out.push(`${p.name}  (${p.cwd})`);
    for (const t of p.threads) {
      const who = t.agent === "—" ? "" : `${t.agent} · `;
      out.push(
        `  ${who}${t.title}${t.outsideZed ? "  [outside Zed]" : ""}${t.autoResume ? "  [automatic resume on]" : ""}`,
      );
      for (const s of t.schedules) {
        out.push(
          `    ${years ? formatWhenFull(s.dueAt, locale) : formatWhen(s.dueAt, now, locale)} · ${years ? outcomeText(s) : STATUS_WORDS[s.status]} · ${oneLine(s.text)}  [${s.scheduleId.slice(0, 8)}]`,
        );
      }
    }
  }
  // The schedules page deletes any row; a resume outside Zed can also be cancelled from here.
  if (groups.some((p) => p.threads.some((t) => t.outsideZed && t.schedules.some(planned))))
    out.push(
      "",
      `To cancel a resume outside Zed: ${rewake("continue --cancel")} lets you pick it (or add its id from the square brackets), or delete it on the schedules page (${rewake("ui")}).`,
    );
  return out.join("\n");
}

/** A resume of an agent outside Zed: its own host, not the Zed (ACP) add-on's. */
export function isOutsideZed(s: Schedule): boolean {
  return s.host !== undefined && s.host !== "acp";
}

const planned = (s: Schedule) => !TERMINAL_STATUSES.has(s.status);

/** "Session" from "session". */
export function capital(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/** How late the Zed add-on still sends a resume on its own (src/addon.ts `missedGraceMs`). */
const ZED_LATE_MS = 15 * 60_000;

/** The resume `--explain` names: a full id, or the start of one (the lists show eight characters). */
export function explainSchedule(
  stateDir: string,
  idPrefix: string,
  now: number,
  hostOf: (hostId: string) => { name: string; noun: string } | undefined,
  locale?: string,
): { ok: true; text: string } | { ok: false; error: string } {
  const wanted = idPrefix.trim().toLowerCase();
  const found = wanted
    ? new ScheduleStore(stateDir)
        .list()
        .filter((s) => s.scheduleId.toLowerCase().startsWith(wanted))
    : [];
  if (found.length === 0)
    return {
      ok: false,
      error: `No scheduled message starts with "${idPrefix}". The ids are in ${rewake("schedules --all")}, in square brackets.`,
    };
  if (found.length > 1)
    return {
      ok: false,
      error: `More than one starts with "${idPrefix}". Give a few more characters of the id.`,
    };
  const s = found[0] as Schedule;
  const host = s.host && s.host !== "acp" ? hostOf(s.host) : undefined;
  const folder = s.cwd ? basename(s.cwd) : "";
  const title = new ThreadStore(stateDir).get(s.sessionId)?.title;
  const where = host
    ? folder
      ? `${host.name} in the "${folder}" folder`
      : host.name
    : title
      ? `The Zed thread "${title}"`
      : `The Zed thread ${s.sessionId.slice(0, 8)}`;
  const lines = explainResume(
    {
      dueAt: s.dueAt,
      status: s.status,
      statusWord: STATUS_WORDS[s.status],
      kind: s.kind,
      text: s.text,
      where,
      noun: host?.noun ?? "thread",
      outsideZed: host !== undefined,
      ...(host === undefined && { lateMs: ZED_LATE_MS }),
      cancel: host
        ? `To cancel it: ${rewake(`continue --cancel ${s.scheduleId.slice(0, 8)}`)}`
        : `To cancel it, use the schedules page: ${rewake("ui")}`,
    },
    now,
    locale,
  );
  return { ok: true, text: lines.join("\n") };
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
