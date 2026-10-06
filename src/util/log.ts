import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, stateDir } from "./paths.js";

export type LogFields = Record<string, string | number | boolean | undefined>;

/**
 * Metadata-only JSON-lines logger. It never writes to stdout (stdout carries the ACP protocol)
 * and must never be given message content, credentials or environment values (SECURITY.md).
 * The log directory is created lazily, so a cold start with an empty HOME doesn't fail.
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
  }

  private write(level: string, event: string, fields: LogFields): void {
    if (this.disabled) return;
    try {
      if (!this.file) {
        const dir = ensurePrivateDir(join(stateDir(this.env), "logs"));
        const day = new Date().toISOString().slice(0, 10);
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
