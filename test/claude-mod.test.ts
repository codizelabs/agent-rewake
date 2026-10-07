import { describe, expect, it } from "vitest";
import { FAR_RESET_MS, LATE_MS, MAX_REARMS, RESET_MARGIN_MS } from "../src/core/resume.js";
import { formatWhen, setClock } from "../src/core/time.js";

/**
 * The Claude Code mod (src/hosts/claude-code/mod) is plain JavaScript that runs inside Claude Code
 * without Node or Rewake's code, so it carries its own copy of a few rules. These tests fail if the
 * copy drifts from Rewake's core. (The mod's behaviour is tested by `claude plugin test`.)
 */
interface Logic {
  AFTER_RESET_MS: number;
  STALE_MS: number;
  FAR_RESET_MS: number;
  MAX_REARMS: number;
  blockedUntil: (
    w: { kind: string; percentUsed: number; resetsAt?: string }[],
    now: number,
  ) => number | undefined;
  mustAsk: (o: { autoContinue?: string; fireAt: number; now: number }) => boolean;
  when: (ms: number, now: number, clock?: string) => string;
}

const path = "../src/hosts/claude-code/mod/hooks/logic.js";
const logic = (await import(path)) as Logic;
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;

describe("Claude Code mod: rules shared with Rewake's core", () => {
  it("uses the same margins and limits", () => {
    expect(logic.AFTER_RESET_MS).toBe(RESET_MARGIN_MS);
    expect(logic.STALE_MS).toBe(LATE_MS);
    expect(logic.FAR_RESET_MS).toBe(FAR_RESET_MS);
    expect(logic.MAX_REARMS).toBe(MAX_REARMS);
  });

  it("formats times the way every other Rewake surface does, in both clocks", () => {
    for (const at of [NOW + 3 * H, NOW + 20 * H, NOW + 3 * 24 * H, NOW + 10 * 24 * H]) {
      for (const clock of ["12h", "24h"] as const) {
        setClock(clock);
        expect(logic.when(at, NOW, clock)).toBe(formatWhen(at, NOW));
      }
    }
    setClock("12h");
  });

  it("never waits for a monthly spending cap, and ignores resets already past", () => {
    const at = (ms: number) => new Date(ms).toISOString();
    expect(
      logic.blockedUntil(
        [{ kind: "spend_limit", percentUsed: 100, resetsAt: at(NOW + 20 * 24 * H) }],
        NOW,
      ),
    ).toBeUndefined();
    expect(logic.blockedUntil([{ kind: "spend_limit", percentUsed: 100 }], NOW)).toBeUndefined();
    // A gateway's daily cap comes back on its own within a day: wait for it.
    expect(
      logic.blockedUntil([{ kind: "spend_limit", percentUsed: 100, resetsAt: at(NOW + H) }], NOW),
    ).toBe(new Date(at(NOW + H)).getTime());
    // A spending cap plus a plan window that resets: the plan's reset.
    expect(
      logic.blockedUntil(
        [
          { kind: "spend_limit", percentUsed: 100, resetsAt: at(NOW + 20 * 24 * H) },
          { kind: "five_hour", percentUsed: 100, resetsAt: at(NOW + 2 * H) },
        ],
        NOW,
      ),
    ).toBe(new Date(at(NOW + 2 * H)).getTime());
    expect(
      logic.blockedUntil([{ kind: "five_hour", percentUsed: 100, resetsAt: at(NOW - H) }], NOW),
    ).toBeUndefined();
    expect(
      logic.blockedUntil(
        [
          { kind: "five_hour", percentUsed: 100, resetsAt: at(NOW + H) },
          { kind: "seven_day", percentUsed: 100, resetsAt: at(NOW + 30 * H) },
        ],
        NOW,
      ),
    ).toBe(new Date(at(NOW + 30 * H)).getTime());
  });

  it("asks about a reset more than a day away, even with always", () => {
    expect(logic.mustAsk({ autoContinue: "always", fireAt: NOW + H, now: NOW })).toBe(false);
    expect(logic.mustAsk({ autoContinue: "always", fireAt: NOW + 25 * H, now: NOW })).toBe(true);
    expect(logic.mustAsk({ fireAt: NOW + H, now: NOW })).toBe(true);
  });
});
