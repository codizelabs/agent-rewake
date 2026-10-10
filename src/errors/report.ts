import { loadSettings } from "../core/settings.js";
import { FROM_SOURCE } from "../version.js";
import { errorReportsEnabled } from "./consent.js";
import { DEFAULT_DSN, parseDsn } from "./dsn.js";
import { appendLedger, cleanOldLogs } from "./ledger.js";
import { buildEvent, newEventId, type ReportTags } from "./payload.js";
import { enqueue, flushQueue } from "./queue.js";

/**
 * The one function the rest of Rewake calls to report an error: `log.error` call sites, uncaught
 * exceptions and rejections in CLI commands, timer `fire`/`sweep` silent failures, and hook entry
 * points. It never throws, never prints, never awaits the network (AGENTS.md "Reliability rules").
 *
 * It always writes a local ledger entry, whether or not error reporting is turned on, so `doctor`
 * (and a future `report` command) can show what happened. When reporting is on, the event is only
 * appended to a local queue here — sending happens in `flushPendingReports`, called at the end of a
 * non-hook command.
 */
export interface ReportInput {
  name: string;
  error?: unknown;
  message?: string;
  level?: "error" | "warning" | "info";
  tags: ReportTags;
}

export function reportError(
  stateDir: string,
  input: ReportInput,
  env: NodeJS.ProcessEnv = process.env,
  home: string = process.env.HOME ?? process.env.USERPROFILE ?? "",
): void {
  try {
    const settings = loadSettings(stateDir);
    const eventId = newEventId();
    const event = buildEvent({ ...input, fromSource: FROM_SOURCE, home }, eventId, new Date());
    const type = event.exception?.values[0]?.type ?? "Error";
    const value = event.exception?.values[0]?.value ?? input.name;
    appendLedger(stateDir, {
      t: event.timestamp,
      name: input.name,
      type,
      message: value,
      sent: errorReportsEnabled(settings, env),
    });
    if (errorReportsEnabled(settings, env)) enqueue(stateDir, event);
  } catch {
    // Observability must never break the caller (AGENTS.md, env-vars rule #3).
  }
}

/**
 * Flush whatever is queued, and tidy old logs. Call once, at the end of a command that isn't a
 * hook and doesn't own stdout for the ACP protocol (proxy mode). Bounded by queue.ts's own
 * 3-second-per-event timeout; never throws.
 */
export async function flushPendingReports(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    cleanOldLogs(stateDir, Date.now());
    const settings = loadSettings(stateDir);
    if (!errorReportsEnabled(settings, env)) return;
    const dsn = parseDsn(env.AGENT_REWAKE_SENTRY_DSN || DEFAULT_DSN);
    if (!dsn) return;
    await flushQueue(stateDir, dsn, Date.now());
  } catch {
    // Never let flushing break command exit.
  }
}

/** Commands that must never await the network themselves (AGENTS.md "Reliability rules"). */
export const NO_FLUSH_COMMANDS = new Set(["hook", "ui"]);
