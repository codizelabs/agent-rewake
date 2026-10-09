import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Claude Code's limits as Rewake's plugin sees them: the plugin (mod/hooks/register.js) runs inside
 * Claude Code and keeps its own records there; it writes a metadata copy of each, never message
 * text, to `<stateDir>/hosts/claude-code/sessions/<sessionId>.json` so `doctor` (and later the
 * schedules page) can show them. Read-only here: the plugin is the only writer.
 */
export interface ClaudeCodeRecord {
  sessionId: string;
  cwd?: string;
  /** armed: Rewake continues at fireAt · offered/waiting: needs the person · native: Claude Code continues · sent/none: done */
  state: string;
  resetAt?: number;
  fireAt?: number;
  updatedAt: number;
}

/** Records older than this are leftovers of sessions long gone. */
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

export function claudeCodeRecords(stateDir: string, now: number): ClaudeCodeRecord[] {
  const dir = join(stateDir, "hosts", "claude-code", "sessions");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ClaudeCodeRecord[] = [];
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, n), "utf8")) as Record<string, unknown>;
      if (r.host !== "claude-code" || typeof r.sessionId !== "string") continue;
      if (typeof r.state !== "string" || typeof r.updatedAt !== "number") continue;
      if (now - r.updatedAt > STALE_MS) continue;
      out.push({
        sessionId: r.sessionId,
        state: r.state,
        updatedAt: r.updatedAt,
        ...(typeof r.cwd === "string" && r.cwd !== "" && { cwd: r.cwd }),
        ...(typeof r.resetAt === "number" && { resetAt: r.resetAt }),
        ...(typeof r.fireAt === "number" && { fireAt: r.fireAt }),
      });
    } catch {
      // A file mid-write or not Rewake's: skipped.
    }
  }
  return out;
}
