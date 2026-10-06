import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findCodexLimit,
  isCodexRollout,
  readTail,
  threadIdOf,
} from "../src/hosts/codex/rollout.js";

// Synthetic lines in the 0.160.1 shapes (no real capture yet: experiment X-C2).
const NOW = Date.parse("2026-10-07T12:00:00Z");
const sec = (ms: number) => Math.floor(ms / 1000);
const line = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-10-07T11:59:00Z", type: "event_msg", payload });
const tokens = (rl: Record<string, unknown>) =>
  line({ type: "token_count", info: null, rate_limits: rl });
const started = line({ type: "task_started", turn_id: "t1" });
const limited = line({
  type: "task_complete",
  turn_id: "t1",
  last_agent_message: null,
  error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" },
  completed_at: sec(NOW - 60_000),
});
const session = {
  used_percent: 100,
  window_minutes: 300,
  resets_at: sec(NOW + 2 * 3_600_000),
};
const weekly = { used_percent: 41, window_minutes: 10080, resets_at: sec(NOW + 5 * 86_400_000) };

describe("findCodexLimit", () => {
  it("finds a usage limit with the reset of the full window", () => {
    const tail = [
      started,
      tokens({
        primary: session,
        secondary: weekly,
        rate_limit_reached_type: "rate_limit_reached",
      }),
      limited,
    ].join("\n");
    expect(findCodexLimit(tail, NOW)).toEqual({
      limited: true,
      at: sec(NOW - 60_000) * 1000,
      resetsAt: session.resets_at * 1000,
      window: "session",
    });
  });

  it("takes the latest of several full windows (a weekly limit outlasts the session one)", () => {
    const tail = [
      tokens({ primary: session, secondary: { ...weekly, used_percent: 100 } }),
      limited,
    ].join("\n");
    expect(findCodexLimit(tail, NOW)).toMatchObject({
      resetsAt: weekly.resets_at * 1000,
      window: "weekly",
    });
  });

  it("treats credits and spending caps as billing: never resumed", () => {
    for (const rl of [
      { primary: session, rate_limit_reached_type: "workspace_owner_credits_depleted" },
      { primary: session, spend_control_reached: { limit: 1 } },
    ]) {
      const v = findCodexLimit([tokens(rl), limited].join("\n"), NOW);
      expect(v).toMatchObject({ limited: true, billing: true });
      expect(v.resetsAt).toBeUndefined();
    }
  });

  it("is cleared when the person typed again", () => {
    expect(findCodexLimit([limited, started].join("\n"), NOW)).toEqual({ limited: false });
  });

  it("ignores other errors and unknown or broken lines", () => {
    const other = line({
      type: "task_complete",
      error: { codex_error_info: "server_overloaded" },
    });
    expect(findCodexLimit(["not json", "{broken", other].join("\n"), NOW)).toEqual({
      limited: false,
    });
  });

  it("knows a limit without a reset time when no snapshot came before it", () => {
    expect(findCodexLimit(limited, NOW)).toEqual({ limited: true, at: sec(NOW - 60_000) * 1000 });
  });

  it("ignores resets already past", () => {
    const old = { ...session, resets_at: sec(NOW - 1000) };
    expect(
      findCodexLimit([tokens({ primary: old }), limited].join("\n"), NOW).resetsAt,
    ).toBeUndefined();
  });
});

describe("rollout files", () => {
  it("reads the tail without a partial first line", () => {
    const dir = mkdtempSync(join(tmpdir(), "rewake-rollout-"));
    try {
      const file = join(dir, "r.jsonl");
      writeFileSync(file, `${"x".repeat(100)}\n${started}\n${limited}\n`);
      expect(readTail(file, limited.length + started.length + 10).split("\n")[0]).toBe(started);
      expect(findCodexLimit(readTail(file), NOW).limited).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gets the thread id from the file name and recognises Codex's layout", () => {
    const p =
      "/h/.codex/sessions/2026/10/07/rollout-2026-10-07T11-58-00-0199a7f2-1b2c-7d3e-8f40-142dd9b73ad5.jsonl";
    expect(threadIdOf(p)).toBe("0199a7f2-1b2c-7d3e-8f40-142dd9b73ad5");
    expect(isCodexRollout(p)).toBe(true);
    expect(isCodexRollout("C:\\u\\.codex\\sessions\\2026\\10\\07\\rollout-x.jsonl")).toBe(true);
    expect(isCodexRollout("/h/.claude/projects/p/abc.jsonl")).toBe(false);
    expect(isCodexRollout(undefined)).toBe(false);
  });
});
