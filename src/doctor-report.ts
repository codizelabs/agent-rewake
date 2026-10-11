import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Schedule } from "./core/store.js";
import { writeFileAtomic } from "./core/store.js";
import { type Finding, type LogRecord, render } from "./doctor.js";
import type { SessionRecord } from "./hosts/sessions.js";
import { ensurePrivateDir } from "./util/paths.js";
import { REPO_URL } from "./version.js";

/** Where people open an issue: printed by `doctor --report`, never opened by Rewake. */
export const ISSUE_URL = `${REPO_URL}/issues/new/choose`;

/** The days a report looks back. */
export const REPORT_DAYS = 14;

/** Log fields that could carry message text, if one were ever added: never copied. */
const LEFT_OUT = new Set(["pid", "text", "prompt", "body", "content", "title", "cwd", "folder"]);

/** Log events that show what Rewake decided when a timer fired. */
const FIRE_EVENTS = /^(fire\.|hook$|hook\.|limit\.|schedule\.settled|schedule\.delivering)/;

export interface ReportInput {
  version: string;
  nodeVersion: string;
  platform: string;
  now: number;
  home: string;
  findings: Finding[];
  /** `doctor --details` lines. */
  details: string[];
  /** Log records from the last REPORT_DAYS days, oldest first. */
  logs: LogRecord[];
  schedules: Schedule[];
  /** Whether a system timer exists for a planned resume; undefined when this computer has none. */
  timerArmed: (scheduleId: string) => boolean | undefined;
  timerKind: string | undefined;
  /** Sessions Rewake's hooks know of, per agent outside Zed. */
  sessions: { host: string; name: string; records: SessionRecord[] }[];
}

const short = (s: string) => s.slice(0, 8);
const hash = (id: string) => createHash("sha256").update(id).digest("hex");

/** The text with the home folder as ~ and every session or schedule id replaced by a short hash. */
export function redactor(home: string, ids: string[]): (text: string) => string {
  const homes = [...new Set([home, home.replace(/\\/g, "/")])].filter((h) => h.length > 1);
  const known = [...new Set(ids)].filter((id) => id.length >= 6);
  return (text) => {
    let t = text;
    for (const h of homes) t = t.split(h).join("~");
    for (const id of known) t = t.split(id).join(`id-${short(hash(id))}`);
    return t.replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      (u) => `id-${short(hash(u))}`,
    );
  };
}

const iso = (t: number) => new Date(t).toISOString();

function fields(r: LogRecord): string {
  return Object.entries(r)
    .filter(([k, v]) => !["t", "level", "event"].includes(k) && !LEFT_OUT.has(k) && v !== undefined)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => `${k}=${String(v).slice(0, 120)}`)
    .join(" ");
}

function counts(xs: string[]): string {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].map(([k, n]) => `${k} ${n}`).join(", ") || "none";
}

/**
 * The text of `doctor --report`: what a maintainer needs to understand a problem, with nothing
 * private in it. Metadata only: no message text, thread titles or folder names; the home folder is
 * `~` and ids are hashes. It is written to a file for the person to read and attach by hand.
 */
export function buildReport(i: ReportInput): string {
  const lines: string[] = [
    `Agent Rewake bug report, made ${iso(i.now)}`,
    "",
    "Made by `doctor --report` on this computer. Nothing was sent anywhere: the file stays here",
    "until you attach it to an issue. Your home folder is shown as ~, ids are replaced by short",
    "hashes, and message text, thread titles and folder names are left out. Read it before sharing.",
    "",
    "== Setup (what doctor says) ==",
    render(i.findings, { version: i.version, ascii: true }).trimEnd(),
    "",
    "== Versions and folders ==",
    ...i.details,
    "",
    `== Warnings and errors, last ${REPORT_DAYS} days ==`,
  ];
  const bad = i.logs.filter((r) => r.level === "warn" || r.level === "error");
  if (bad.length === 0) lines.push("none");
  for (const r of bad.slice(-60))
    lines.push(`${iso(r.t)} ${String(r.level)} ${r.event} ${fields(r)}`.trimEnd());

  const planned = i.schedules.filter((s) => s.host !== undefined && s.status === "scheduled");
  const armed = planned.filter((s) => i.timerArmed(s.scheduleId) === true);
  lines.push(
    "",
    "== Timers: planned resumes on file against timers set ==",
    `Scheduler: ${i.timerKind ?? "none on this computer"}`,
    `Planned resumes outside Zed on file: ${planned.length}; with a timer set: ${armed.length}; without: ${planned.length - armed.length}`,
  );
  for (const s of planned)
    lines.push(
      `- ${s.scheduleId} ${s.host} due ${iso(s.dueAt)}: ${i.timerArmed(s.scheduleId) === true ? "timer set" : "NO TIMER"}`,
    );

  lines.push("", "== Sessions and messages per agent ==");
  const byHost = new Map<string, Schedule[]>();
  for (const s of i.schedules)
    byHost.set(s.host ?? "zed", [...(byHost.get(s.host ?? "zed") ?? []), s]);
  for (const [host, list] of [...byHost].sort(([a], [b]) => a.localeCompare(b)))
    lines.push(`${host}: messages ${counts(list.map((s) => s.status))}`);
  if (byHost.size === 0) lines.push("no messages on file");
  for (const h of i.sessions) {
    if (h.records.length === 0) continue;
    lines.push(
      `${h.name}: ${h.records.length} session${h.records.length === 1 ? "" : "s"} known (${h.records.filter((r) => r.open).length} open)`,
    );
    for (const r of h.records.slice(0, 10))
      lines.push(
        `  ${r.sessionId} ${r.open ? "open" : `closed ${r.closedAt ? iso(r.closedAt) : "(time unknown)"}`}${r.lastPromptAt ? `, last prompt ${iso(r.lastPromptAt)}` : ""}${r.limit ? `, limit ${r.limit.kind}${r.limit.billing ? " (billing)" : ""}${r.limit.resetsAt ? ` resets ${iso(r.limit.resetsAt)}` : ""}, seen ${iso(r.limit.seenAt)}` : ""}`,
      );
  }

  lines.push("", `== What Rewake decided, last ${REPORT_DAYS} days (newest last) ==`);
  const fires = i.logs.filter((r) => FIRE_EVENTS.test(r.event));
  if (fires.length === 0) lines.push("nothing recorded");
  for (const r of fires.slice(-40)) lines.push(`${iso(r.t)} ${r.event} ${fields(r)}`.trimEnd());

  lines.push("", `To report the problem, open ${ISSUE_URL} and attach this file.`, "");
  const text = lines.join("\n");
  const redact = redactor(i.home, [
    ...i.schedules.flatMap((s) => [s.sessionId, s.scheduleId]),
    ...i.sessions.flatMap((h) => h.records.map((r) => r.sessionId)),
  ]);
  return redact(text);
}

/** Write a report into Rewake's own folder, owner-only; returns its path. */
export function writeReport(stateDir: string, now: number, text: string): string {
  const dir = ensurePrivateDir(join(stateDir, "reports"));
  const name = `agent-rewake-report-${iso(now).replace(/[:.]/g, "-").slice(0, 19)}.txt`;
  writeFileAtomic(dir, name, text);
  return join(dir, name);
}
