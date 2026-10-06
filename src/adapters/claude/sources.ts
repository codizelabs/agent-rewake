import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, win32 } from "node:path";
import { readJsonFile } from "../../util/fs.js";

/** Where Claude Code keeps its data: CLAUDE_CONFIG_DIR or ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Claude's project-directory encoding: every non-alphanumeric character becomes "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

const TAIL_BYTES = 256 * 1024;

/**
 * Reset time from Claude's transcript: the newest record with
 * `isApiErrorMessage`, `error: "rate_limit"` and `quotaLimits.status: "rejected"`, written at or
 * after `since`. The format is internal to Claude Code, so anything unexpected yields undefined.
 * Only these metadata fields are read; message content is never kept.
 */
export function resetFromTranscript(
  env: NodeJS.ProcessEnv,
  cwd: string,
  sessionId: string,
  since: number,
): { resetAt: number; rateLimitType?: string } | undefined {
  if (!/^[0-9a-zA-Z-]+$/.test(sessionId)) return undefined;
  const projects = join(claudeConfigDir(env), "projects");
  const candidates = [join(projects, encodeProjectDir(cwd), `${sessionId}.jsonl`)];
  try {
    for (const dir of readdirSync(projects))
      candidates.push(join(projects, dir, `${sessionId}.jsonl`));
  } catch {
    return undefined;
  }
  for (const file of candidates) {
    const tail = readTail(file);
    if (tail === undefined) continue;
    const lines = tail.split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"quotaLimits"')) continue;
      try {
        const r = JSON.parse(line) as {
          isApiErrorMessage?: unknown;
          error?: unknown;
          timestamp?: unknown;
          quotaLimits?: { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown };
        };
        if (r.isApiErrorMessage !== true || r.error !== "rate_limit") continue;
        const q = r.quotaLimits;
        if (q?.status !== "rejected" || typeof q.resetsAt !== "number") continue;
        const written = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : Number.NaN;
        if (Number.isFinite(written) && written < since - 60_000) return undefined; // older episode
        return {
          resetAt: q.resetsAt * 1000,
          ...(typeof q.rateLimitType === "string" && { rateLimitType: q.rateLimitType }),
        };
      } catch {
        // partial first line of the tail, or a record we don't understand
      }
    }
    return undefined;
  }
  return undefined;
}

function readTail(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Where an administrator's managed settings for Claude Code live. On Windows the Claude adapter
 * reads C:\Program Files\ClaudeCode (claude-agent-acp 0.85.1 src/settings.ts); the older
 * C:\ProgramData location is read too, so either one can turn automatic continuation off.
 */
export function managedSettingsFiles(
  env: NodeJS.ProcessEnv,
  p: NodeJS.Platform = platform(),
): string[] {
  if (p === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (p === "win32")
    return [
      win32.join(env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode", "managed-settings.json"),
      win32.join(env.ProgramData ?? "C:\\ProgramData", "ClaudeCode", "managed-settings.json"),
    ];
  return ["/etc/claude-code/managed-settings.json"];
}

/**
 * Claude Code's own off-switch for unattended continuation. If managed, user or project settings set it to false, Rewake never
 * resumes automatically. Project files can only turn it off, as in Claude Code.
 */
export function claudeAutoContinueDisabled(env: NodeJS.ProcessEnv, cwd: string): boolean {
  const files = [
    ...managedSettingsFiles(env),
    join(claudeConfigDir(env), "settings.json"),
    ...(cwd
      ? [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")]
      : []),
  ];
  return files.some((f) => {
    try {
      const s = readJsonFile(f) as { autoContinueAtUsageLimit?: unknown };
      return s.autoContinueAtUsageLimit === false;
    } catch {
      return false;
    }
  });
}
