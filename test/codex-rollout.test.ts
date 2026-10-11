import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blockingReset } from "../src/hosts/codex/cli.js";
import {
  findCodexLimit,
  isCodexRollout,
  readTail,
  threadIdOf,
  userMessages,
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
  it("reads the reset from the bucket that has windows when a later bucket has none", () => {
    // Codex sends one snapshot per limit bucket: "codex" at 100%, then an empty "premium" one.
    const tail = [
      started,
      tokens({ limit_id: "codex", primary: session, secondary: weekly }),
      tokens({ limit_id: "premium", primary: null, secondary: null }),
      limited,
    ].join("\n");
    expect(findCodexLimit(tail, NOW)).toEqual({
      limited: true,
      at: sec(NOW - 60_000) * 1000,
      resetsAt: session.resets_at * 1000,
      window: "session",
    });
  });

  it("falls back to the reset in the message when no snapshot has a window", () => {
    const withText = line({
      type: "task_complete",
      turn_id: "t1",
      last_agent_message: null,
      error: {
        message: "You've hit your usage limit. Try again in 3 hours.",
        codex_error_info: "usage_limit_exceeded",
      },
      completed_at: sec(NOW - 60_000),
    });
    const tail = [started, tokens({ limit_id: "premium", primary: null }), withText].join("\n");
    // Before, the empty snapshot hid the message's reset: "doesn't know when the limit resets".
    expect(findCodexLimit(tail, NOW)).toEqual({
      limited: true,
      at: sec(NOW - 60_000) * 1000,
      resetsAt: NOW + 3 * 3_600_000,
    });
  });

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
    // The plan windows here are not spent (a spent one is read separately, below).
    const notSpent = { ...session, used_percent: 60 };
    for (const rl of [
      { primary: notSpent, rate_limit_reached_type: "workspace_owner_credits_depleted" },
      { primary: session, spend_control_reached: true },
    ]) {
      const v = findCodexLimit([tokens(rl), limited].join("\n"), NOW);
      expect(v).toMatchObject({ limited: true, billing: true });
      expect(v.resetsAt).toBeUndefined();
    }
  });

  // Business and Team workspaces. Source: unsnooze 1.19.1 and 1.19.2 (community project,
  // src/watchers/codex.js "workspaceWall" and test/watchers-codex.test.js): a workspace stop whose
  // plan window is spent as well comes back at that window's reset. No capture from Codex itself.
  describe("a workspace limit with a spent plan window", () => {
    const withMessage = (message: string) =>
      line({
        type: "task_complete",
        turn_id: "t1",
        error: { message, codex_error_info: "usage_limit_exceeded" },
        completed_at: sec(NOW - 60_000),
      });
    const SPEND_CAP = "You hit your spend cap set in your workspace.";
    const cases: [string, string][] = [
      ["workspace_owner_credits_depleted", "Your workspace is out of credits."],
      ["workspace_member_credits_depleted", "Your workspace is out of credits."],
      ["workspace_owner_usage_limit_reached", SPEND_CAP],
      ["workspace_member_usage_limit_reached", SPEND_CAP],
    ];
    it.each(cases)("%s resumes at the spent window's reset, and asks first", (reason, message) => {
      const v = findCodexLimit(
        [
          tokens({ primary: session, secondary: weekly, rate_limit_reached_type: reason }),
          withMessage(message),
        ].join("\n"),
        NOW,
      );
      expect(v).toEqual({
        limited: true,
        at: sec(NOW - 60_000) * 1000,
        resetsAt: session.resets_at * 1000,
        window: "session",
        askFirst: true,
      });
    });

    it("counts a window at 99% as spent, and takes the latest of several spent windows", () => {
      const v = findCodexLimit(
        [
          tokens({
            primary: { ...session, used_percent: 99.5 },
            secondary: { ...weekly, used_percent: 100 },
            rate_limit_reached_type: "workspace_member_usage_limit_reached",
          }),
          withMessage(SPEND_CAP),
        ].join("\n"),
        NOW,
      );
      expect(v).toMatchObject({
        resetsAt: weekly.resets_at * 1000,
        window: "weekly",
        askFirst: true,
      });
    });

    it("stays billing when the spent window's reset has passed, or a spend cap is on", () => {
      const past = { ...session, resets_at: sec(NOW - 3_600_000) };
      for (const rl of [
        { primary: past, rate_limit_reached_type: "workspace_owner_credits_depleted" },
        {
          primary: session,
          spend_control_reached: true,
          rate_limit_reached_type: "workspace_owner_credits_depleted",
        },
      ]) {
        const v = findCodexLimit([tokens(rl), limited].join("\n"), NOW);
        expect(v).toMatchObject({ limited: true, billing: true });
        expect(v.resetsAt).toBeUndefined();
        expect(v.askFirst).toBeUndefined();
      }
    });
  });

  it("reads spend_control_reached as the yes/no flag Codex sends: false is an ordinary limit", () => {
    const v = findCodexLimit(
      [tokens({ primary: session, secondary: weekly, spend_control_reached: false }), limited].join(
        "\n",
      ),
      NOW,
    );
    expect(v).toMatchObject({ limited: true, resetsAt: session.resets_at * 1000 });
    expect(v.billing).toBeUndefined();
  });

  it("with no full window, takes the one closest to full, not the weekly one", () => {
    const nearlyFull = { ...session, used_percent: 99 };
    const v = findCodexLimit(
      [tokens({ primary: nearlyFull, secondary: weekly }), limited].join("\n"),
      NOW,
    );
    expect(v).toMatchObject({ resetsAt: session.resets_at * 1000, window: "session" });
  });

  it("treats Codex's credit, spend-cap and plan messages as billing, even without a snapshot", () => {
    for (const message of [
      "Your workspace is out of credits. Add credits to continue.",
      "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
      "Quota exceeded. Check your plan and billing details.",
      "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
    ]) {
      const failed = line({
        type: "task_complete",
        turn_id: "t1",
        error: { message, codex_error_info: "usage_limit_exceeded" },
        completed_at: sec(NOW - 60_000),
      });
      expect(findCodexLimit(failed, NOW)).toMatchObject({ limited: true, billing: true });
    }
  });

  it("reads the reset from the message when there is no snapshot", () => {
    const at = new Date(NOW + 3 * 3_600_000);
    const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const failed = line({
      type: "task_complete",
      turn_id: "t1",
      error: {
        message: `You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${time}.`,
        codex_error_info: "usage_limit_exceeded",
      },
      completed_at: sec(NOW - 60_000),
    });
    const v = findCodexLimit(failed, NOW);
    expect(v.billing).toBeUndefined();
    expect(v.resetsAt).toBe(new Date(at).setSeconds(0, 0));
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

  it("says when the reset Codex recorded has already passed, and forgets an earlier turn's snapshot", () => {
    const snap = (resetsAt: number) =>
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: resetsAt } },
        },
      });
    const limited = JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", error: { codex_error_info: "usage_limit_exceeded" } },
    });
    const started = JSON.stringify({ type: "event_msg", payload: { type: "task_started" } });
    const now = 1_800_000_000_000;
    const past = now / 1000 - 60;
    expect(findCodexLimit([snap(past), limited].join("\n"), now)).toMatchObject({
      limited: true,
      resetPassed: true,
    });
    // The snapshot came before a new turn: it doesn't describe that turn's limit.
    expect(findCodexLimit([snap(now / 1000 + 3600), started, limited].join("\n"), now)).toEqual({
      limited: true,
      at: now,
    });
  });

  it("lists the person's messages in a session file", () => {
    const tail = [
      '{"type":"event_msg","payload":{"type":"user_message","message":"first"}}',
      '{"type":"event_msg","payload":{"type":"token_count"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"Continue."}}',
    ].join("\n");
    expect(userMessages(tail)).toEqual(["first", "Continue."]);
  });

  it("lists the person's messages as Codex 0.160.1 records them", () => {
    // Shapes from a real 0.160.1 session file: `codex exec`, then a queued message.
    const user = (text: string) =>
      `{"type":"event_msg","payload":{"type":"item_completed","thread_id":"t","turn_id":"u","item":{"type":"UserMessage","id":"i","content":[{"type":"text","text":${JSON.stringify(text)},"text_elements":[]}]}}}`;
    const tail = [
      user("say hi"),
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>"}]}}',
      user("Continue."),
      '{"type":"event_msg","payload":{"type":"item_completed","thread_id":"t","turn_id":"u","item":{"type":"AgentMessage","id":"m","content":[{"type":"Text","text":"done"}]}}}',
    ].join("\n");
    expect(userMessages(tail)).toEqual(["say hi", "Continue."]);
  });

  it("gets the thread id from the file name and recognises Codex's layout", () => {
    const p =
      "/h/.codex/sessions/2026/10/07/rollout-2026-10-07T11-58-00-0199a7f2-1b2c-7d3e-8f40-142dd9b73ad5.jsonl";
    expect(threadIdOf(p)).toBe("0199a7f2-1b2c-7d3e-8f40-142dd9b73ad5");
    // The other form Codex writes: a rollout id after the thread id.
    expect(threadIdOf(p.replace(".jsonl", "_0199a7f3-aaaa-7bbb-8ccc-0123456789ab.jsonl"))).toBe(
      "0199a7f2-1b2c-7d3e-8f40-142dd9b73ad5",
    );
    expect(isCodexRollout(p)).toBe(true);
    expect(isCodexRollout("C:\\u\\.codex\\sessions\\2026\\10\\07\\rollout-x.jsonl")).toBe(true);
    expect(isCodexRollout("/h/.claude/projects/p/abc.jsonl")).toBe(false);
    expect(isCodexRollout(undefined)).toBe(false);
  });
});

describe("blockingReset (Codex's usage check at fire time)", () => {
  const s = 1_791_300_000;
  it("takes the latest of the full windows", () => {
    expect(
      blockingReset([
        { usedPercent: 100, resetsAt: s + 3600 },
        { usedPercent: 100, resetsAt: s + 86_400 },
      ]),
    ).toBe((s + 86_400) * 1000);
  });
  it("with none full, takes the window closest to full, not the weekly one", () => {
    expect(
      blockingReset([
        { usedPercent: 98, resetsAt: s + 3600 },
        { usedPercent: 40, resetsAt: s + 5 * 86_400 },
      ]),
    ).toBe((s + 3600) * 1000);
  });
  it("gives nothing without a reset time", () => {
    expect(blockingReset([null, { usedPercent: 100 }])).toBeUndefined();
  });
});
