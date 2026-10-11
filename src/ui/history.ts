import { basename } from "node:path";
import { type Schedule, ScheduleStore } from "../core/store.js";
import { ThreadStore } from "../core/threads.js";
import { formatWhenFull } from "../core/time.js";
import { eventTime, outcomeText } from "./outcome.js";

const DAY = 24 * 60 * 60 * 1000;

export interface HistoryRow {
  at: number;
  agent: string;
  folder: string;
  /** "Message" for one the person scheduled, "Resume" for one after a usage limit. */
  kind: "Message" | "Resume";
  outcome: string;
  scheduleId: string;
}

/**
 * What happened to Rewake's scheduled messages and resumes in the last `days` days, newest first.
 * Read from the schedule files; never includes message text. `hostName` names an agent outside
 * Zed ("Codex").
 */
export function history(
  stateDir: string,
  now: number,
  days: number,
  hostName?: (host: string) => string | undefined,
): HistoryRow[] {
  const since = now - days * DAY;
  const threads = new ThreadStore(stateDir);
  const rows: HistoryRow[] = [];
  for (const s of new ScheduleStore(stateDir).list()) {
    const at = eventTime(s);
    if (at < since) continue;
    const settings = threads.get(s.sessionId);
    const cwd = s.cwd || settings?.cwd || "";
    rows.push({
      at,
      agent: agentOf(s, settings?.agentName ?? settings?.agentId, hostName),
      folder: cwd ? basename(cwd) : "(unknown folder)",
      kind: s.kind === "user" ? "Message" : "Resume",
      outcome: outcomeText(s),
      scheduleId: s.scheduleId,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

function agentOf(
  s: Schedule,
  fromThread: string | undefined,
  hostName?: (host: string) => string | undefined,
): string {
  return fromThread ?? (s.host ? (hostName?.(s.host) ?? s.host) : "an agent");
}

const span = (days: number) => (days === 1 ? "day" : `${days} days`);

/** The plain-text listing for `agent-rewake history`. */
export function historyText(rows: HistoryRow[], days: number): string {
  if (rows.length === 0)
    return `Nothing in the last ${span(days)}: no messages or resumes were planned, sent or missed.`;
  const lines = [`The last ${span(days)}, newest first:`, ""];
  for (const r of rows)
    lines.push(
      formatWhenFull(r.at),
      `  ${r.agent} in the "${r.folder}" folder · ${r.kind}: ${r.outcome}`,
    );
  return lines.join("\n");
}
