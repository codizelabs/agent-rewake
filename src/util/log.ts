import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, stateDir } from "./paths.js";

export type LogFields = Record<string, string | number | boolean | undefined>;

/**
 * Metadata-only JSON-lines logger. It never writes to stdout (stdout carries the ACP protocol)
 * and must never be given message content, credentials or environment values (SECURITY.md).
 * The log directory is created lazily, so a cold start with an empty HOME doesn't fail.
 *
 * Every `error()` call also goes through Rewake's opt-in error reporting (src/errors/report.ts):
 * a local ledger entry always, and a queued Sentry event when the person has turned reporting on.
 * That import is dynamic so a circular-import mistake here can never crash logging itself, which
 * must keep working even when reporting can't.
 */
export class Logger {
  private file: string | undefined;
  private disabled = false;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
    this.reportToErrors(event);
  }

  private reportToErrors(event: string): void {
    try {
      // Dynamic import: errors/report.ts never throws, but keep logging independent of it even
      // if that ever changed.
      import("../errors/report.js")
        .then(({ reportError }) =>
          reportError(stateDir(this.env), { name: event, tags: { place: "cli" } }, this.env),
        )
        .catch(() => {});
    } catch {
      // Never let reporting break logging.
    }
  }

  private write(level: string, event: string, fields: LogFields): void {
    if (this.disabled) return;
    try {
      // One file per day, also for a process that runs for days.
      const day = new Date().toISOString().slice(0, 10);
      if (!this.file?.endsWith(`rewake-${day}.jsonl`)) {
        const dir = ensurePrivateDir(join(stateDir(this.env), "logs"));
        this.file = join(dir, `rewake-${day}.jsonl`);
      }
      const record = { t: new Date().toISOString(), level, event, pid: process.pid, ...fields };
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break the protocol stream: give up silently on I/O errors.
      this.disabled = true;
    }
  }
}
