import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Codex's session files ("rollouts", `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`):
 * what Rewake reads to notice a usage limit, because Codex runs no hook when a turn fails.
 *
 * Shapes from codex-rs @ rust-v0.160.1 (protocol/src/protocol.rs TokenCountEvent,
 * RateLimitSnapshot, TurnCompleteEvent; protocol/src/codex_error_info.rs). No real capture of a
 * limit exists yet (experiment X-C2), so the parser is tolerant: unknown lines are skipped.
 *
 *   {"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":100,
 *     "window_minutes":300,"resets_at":1791303600},"secondary":{…},"rate_limit_reached_type":…}}}
 *   {"type":"event_msg","payload":{"type":"task_complete","turn_id":"…",
 *     "error":{"codex_error_info":"usage_limit_exceeded","message":"…"},"completed_at":1791300004}}
 *
 * Only `usage_limit_exceeded` counts. `rate_limit_reached_type` values ending in
 * `_credits_depleted`, and a `spend_control_reached` snapshot, are billing: never resumed.
 */

export interface CodexLimit {
  limited: boolean;
  /** Credits or a spending cap ran out: waiting doesn't fix it. */
  billing?: boolean;
  /** When the limit resets (ms), from the newest rate-limit snapshot before the failure. */
  resetsAt?: number;
  window?: "session" | "weekly" | "other";
  /** When the failed turn ended (ms). */
  at?: number;
}

/** The last `bytes` of a file, without a partial first line. */
export function readTail(path: string, bytes = 256 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

interface Window {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}
interface RateLimits {
  primary?: Window | null;
  secondary?: Window | null;
  rate_limit_reached_type?: string | null;
  spend_control_reached?: unknown;
}

function pickReset(rl: RateLimits | undefined, nowSec: number): Partial<CodexLimit> {
  if (!rl) return {};
  const windows = [rl.primary, rl.secondary].filter(
    (w): w is Window =>
      !!w &&
      typeof w.resets_at === "number" &&
      Number.isFinite(w.resets_at) &&
      w.resets_at > nowSec,
  );
  const full = windows.filter((w) => (w.used_percent ?? 0) >= 100);
  const pool = full.length > 0 ? full : windows;
  if (pool.length === 0) return {};
  const w = pool.reduce((a, b) => ((b.resets_at ?? 0) > (a.resets_at ?? 0) ? b : a));
  const window =
    w.window_minutes === 300 ? "session" : w.window_minutes === 10080 ? "weekly" : "other";
  return { resetsAt: (w.resets_at ?? 0) * 1000, window };
}

function isBilling(rl: RateLimits | undefined): boolean {
  if (!rl) return false;
  const t = rl.rate_limit_reached_type ?? "";
  return /_credits_depleted$/.test(t) || (rl.spend_control_reached ?? null) !== null;
}

/**
 * Whether the thread's last turn ended at a usage limit. A later turn (the person typed again)
 * clears it.
 */
export function findCodexLimit(tail: string, now: number = Date.now()): CodexLimit {
  const nowSec = Math.floor(now / 1000);
  let rateLimits: RateLimits | undefined;
  let verdict: CodexLimit = { limited: false };
  for (const line of tail.split("\n")) {
    if (!line.startsWith("{")) continue;
    let rec: { type?: string; payload?: Record<string, unknown> };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const p = rec.payload;
    if (rec.type !== "event_msg" || !p || typeof p !== "object") continue;
    if (p.type === "token_count" && p.rate_limits && typeof p.rate_limits === "object")
      rateLimits = p.rate_limits as RateLimits;
    if (p.type === "task_started" || p.type === "turn_started") verdict = { limited: false };
    if (p.type === "task_complete" || p.type === "turn_complete") {
      const error = p.error as { codex_error_info?: unknown } | null | undefined;
      if (error?.codex_error_info === "usage_limit_exceeded") {
        const completed = typeof p.completed_at === "number" ? p.completed_at * 1000 : now;
        verdict = {
          limited: true,
          at: completed,
          ...(isBilling(rateLimits) ? { billing: true } : pickReset(rateLimits, nowSec)),
        };
      } else verdict = { limited: false };
    }
  }
  return verdict;
}

/** The thread id in a rollout's file name: `rollout-<time>-<uuid>.jsonl`. */
export function threadIdOf(transcriptPath: string): string | undefined {
  return /rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    transcriptPath,
  )?.[1];
}

/** Whether the path looks like a Codex rollout (the cross-talk guard: other agents' hooks differ). */
export function isCodexRollout(path: unknown): path is string {
  return (
    typeof path === "string" &&
    /[\\/]sessions[\\/]\d{4}[\\/]\d\d[\\/]\d\d[\\/]rollout-[^\\/]+\.jsonl$/.test(path)
  );
}
