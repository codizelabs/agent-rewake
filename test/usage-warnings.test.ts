import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "../src/core/settings.js";

type Sample = { t: number; p: number };
interface State {
  resetsAt: number;
  samples: Sample[];
  high: number;
  pace: boolean;
}
interface Step {
  next: State;
  level?: number;
  pace?: [number, number];
}
interface Logic {
  timeToLimit: (samples: Sample[], now: number) => number | undefined;
  paceRange: (ms: number) => [number, number];
  usageStep: (
    prev: State | undefined,
    w: { kind: string; percentUsed: number; resetsAt?: string },
    now: number,
  ) => Step | undefined;
  limitName: (kind: string) => string;
  levelText: (kind: string, percent: number, reset: string) => string;
  paceText: (kind: string, range: [number, number], reset: string) => string;
}

/** The Claude Code mod's warning rules: plain JavaScript, imported as the mod's own tests do. */
const path = "../src/hosts/claude-code/mod/hooks/logic.js";
const logic = (await import(path)) as Logic;

const MIN = 60_000;
const NOW = Date.parse("2026-10-06T10:00:00Z");
const RESET = "2026-10-06T15:00:00Z";
const five = (percentUsed: number, resetsAt = RESET) => ({
  kind: "five_hour",
  percentUsed,
  resetsAt,
});

/** Feed readings one after another, 5 minutes apart unless told, keeping the state as the mod does. */
function run(readings: number[], step = 5 * MIN, resetsAt = RESET) {
  let state: State | undefined;
  const out: Step[] = [];
  readings.forEach((p, i) => {
    const r = logic.usageStep(state, five(p, resetsAt), NOW + i * step);
    if (r) {
      state = r.next;
      out.push(r);
    }
  });
  return out;
}

describe("usage warnings: thresholds", () => {
  it("warns once at 80 and once at 95", () => {
    const levels = run([10, 79, 80, 81, 90, 95, 96, 99]).map((s) => s.level);
    expect(levels.filter((l) => l !== undefined)).toEqual([80, 95]);
  });

  it("shows only the higher when a reading jumps past both", () => {
    expect(run([50, 97]).map((s) => s.level)).toEqual([undefined, 95]);
    expect(run([97, 98]).map((s) => s.level)).toEqual([95, undefined]);
  });

  it("never warns at or above 100: the limit flow takes over", () => {
    expect(logic.usageStep(undefined, five(100), NOW)).toBeUndefined();
    expect(logic.usageStep(undefined, five(120), NOW)).toBeUndefined();
  });

  it("warns again in the next window, not twice in this one", () => {
    const first = run([85]);
    const again = logic.usageStep(first[0]?.next, five(86), NOW + MIN);
    expect(again?.level).toBeUndefined();
    // The next window resets 5 hours later.
    const next = logic.usageStep(
      first[0]?.next,
      five(85, "2026-10-06T20:00:00Z"),
      NOW + 6 * 60 * MIN,
    );
    expect(next?.level).toBe(80);
    expect(next?.next.samples).toHaveLength(1);
  });

  it("treats a reset time a moment off as the same window", () => {
    const first = run([85]);
    const off = logic.usageStep(first[0]?.next, five(86, "2026-10-06T15:00:01Z"), NOW + MIN);
    expect(off?.level).toBeUndefined();
  });

  it("keeps the latest reset time, so a slow drift of 3 x 15 minutes is still one window", () => {
    let state = run([85])[0]?.next;
    for (let i = 1; i <= 3; i++) {
      const drifted = new Date(Date.parse(RESET) + i * 15 * MIN).toISOString();
      const r = logic.usageStep(state, five(86, drifted), NOW + i * MIN);
      expect(r?.level).toBeUndefined();
      expect(r?.next.resetsAt).toBe(Date.parse(drifted));
      state = r?.next;
    }
    expect(state?.high).toBe(80);
    expect(state?.samples.length).toBeGreaterThan(1);
  });

  it("skips spending caps, windows already reset and windows without a reset time", () => {
    const cap = { kind: "spend_limit", percentUsed: 90, resetsAt: RESET };
    expect(logic.usageStep(undefined, cap, NOW)).toBeUndefined();
    expect(logic.usageStep(undefined, five(90, "2026-10-06T09:00:00Z"), NOW)).toBeUndefined();
    expect(logic.usageStep(undefined, { kind: "five_hour", percentUsed: 90 }, NOW)).toBeUndefined();
  });
});

describe("usage warnings: time to limit", () => {
  const at = (...ps: [number, number][]): Sample[] => ps.map(([m, p]) => ({ t: NOW + m * MIN, p }));

  it("needs two samples at least 10 minutes apart", () => {
    expect(logic.timeToLimit(at([0, 10]), NOW)).toBeUndefined();
    expect(logic.timeToLimit(at([0, 10], [9, 20]), NOW + 9 * MIN)).toBeUndefined();
    expect(logic.timeToLimit(at([0, 10], [10, 20]), NOW + 10 * MIN)).toBe(80 * MIN);
  });

  it("is unknown when the figure doesn't rise", () => {
    expect(logic.timeToLimit(at([0, 20], [30, 20]), NOW + 30 * MIN)).toBeUndefined();
    expect(logic.timeToLimit(at([0, 30], [30, 20]), NOW + 30 * MIN)).toBeUndefined();
  });

  it("is unknown when the figure hasn't moved since the newest sample: idle time is no pace", () => {
    expect(logic.timeToLimit(at([0, 50], [20, 60]), NOW + 30 * MIN)).toBeUndefined();
    // 20, 24, 28 ten minutes apart, 150 minutes idle, then 28 again: no pace.
    const idle = run([20, 24, 28], 10 * MIN).at(-1)?.next;
    const again = logic.usageStep(idle, five(28), NOW + 20 * MIN + 150 * MIN);
    expect(again?.pace).toBeUndefined();
    expect(again?.next.pace).toBe(false);
  });

  it("uses only samples from the last hour, and needs 10 minutes between those", () => {
    // A fast rise two hours ago does not count; the newest two are 5 minutes apart.
    expect(logic.timeToLimit(at([0, 10], [10, 50], [120, 60], [125, 62]), NOW + 125 * MIN)).toBe(
      undefined,
    );
    // With one from 15 minutes before them: 5 points in 15 minutes, 38 points left.
    expect(
      logic.timeToLimit(at([0, 10], [10, 50], [110, 57], [120, 60], [125, 62]), NOW + 125 * MIN),
    ).toBeCloseTo(114 * MIN);
  });

  it("gives a range in fives, about 0.7x to 1.4x", () => {
    expect(logic.paceRange(30 * MIN)).toEqual([20, 40]);
    expect(logic.paceRange(10 * MIN)).toEqual([5, 15]);
    expect(logic.paceRange(0)).toEqual([5, 10]);
    expect(logic.paceRange(45 * MIN)).toEqual([30, 65]);
  });

  it("warns once per window when the limit is near and before the reset", () => {
    // 1 point a minute: from 50 at minute 20, the limit is 50 minutes away; at 60, 40 minutes.
    const outs = run([30, 40, 50, 60, 61, 62], 10 * MIN);
    const paces = outs.map((s) => s.pace);
    expect(paces.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(paces[3]).toEqual([30, 55]);
    expect(paces.slice(4)).toEqual([undefined, undefined]);
  });

  it("stays quiet when the limit would come after the reset", () => {
    const outs = run([30, 40, 50, 60], 10 * MIN, "2026-10-06T10:31:00Z");
    expect(outs.every((s) => s.pace === undefined)).toBe(true);
  });

  it("stays quiet when it is far, when it is slow, or when the figure is flat", () => {
    expect(run([10, 11, 12, 13], 10 * MIN).every((s) => s.pace === undefined)).toBe(true);
    expect(run([40, 40, 40, 40], 10 * MIN).every((s) => s.pace === undefined)).toBe(true);
  });

  it("keeps at most 12 samples, and starts over if the figure drops", () => {
    const many = run(
      Array.from({ length: 20 }, (_, i) => 10 + i),
      2 * MIN,
    );
    expect(many.at(-1)?.next.samples).toHaveLength(12);
    const dropped = run([50, 60, 30]);
    expect(dropped.at(-1)?.next.samples).toHaveLength(1);
  });

  it("does not add a sample when the figure hasn't moved", () => {
    expect(run([40, 40, 40]).at(-1)?.next.samples).toHaveLength(1);
  });

  it("waits for the next reading when a threshold was just shown", () => {
    const outs = run([10, 11, 85, 86], 10 * MIN);
    expect(outs[2]?.level).toBe(80);
    expect(outs[2]?.pace).toBeUndefined();
    expect(outs[2]?.next.pace).toBe(false);
    expect(outs[3]?.pace).toBeDefined();
  });
});

describe("usage warnings: wording", () => {
  it("names the windows", () => {
    expect(logic.limitName("five_hour")).toBe("5-hour limit");
    expect(logic.limitName("seven_day")).toBe("7-day limit");
    expect(logic.limitName("seven_day_opus")).toBe("7-day opus limit");
    expect(logic.limitName("monthly_cap")).toBe("monthly cap limit");
  });

  it("at 80% hints at /compact and says it uses some quota too", () => {
    const text = logic.levelText("five_hour", 80.6, "at 3:00 AM today");
    expect(text).toBe(
      "5-hour limit: 80% used, as of Claude Code's last reply. It resets at 3:00 AM today. If you are in the middle of a task, /compact now can make the rest last longer (compacting also uses some).",
    );
  });

  it("at 95% does not suggest compacting: that is a model call too", () => {
    const text = logic.levelText("seven_day", 96, "on Friday at 9:00 AM");
    expect(text).toBe(
      "7-day limit: 96% used, as of Claude Code's last reply. It resets on Friday at 9:00 AM. A good moment to wrap up or save what you are doing.",
    );
    expect(text).not.toContain("compact");
  });

  it("gives the pace as a range, never as one minute", () => {
    expect(logic.paceText("five_hour", [20, 40], "at 3:00 AM today")).toBe(
      "At this pace you reach the 5-hour limit in about 20 to 40 minutes, before it resets at 3:00 AM today.",
    );
  });

  it("never claims Rewake compacts or types anything", () => {
    const all = [
      logic.levelText("seven_day", 95, "on Friday at 9:00 AM"),
      logic.paceText("seven_day", [5, 15], "on Friday at 9:00 AM"),
    ].join(" ");
    expect(all).not.toMatch(/Rewake/);
  });
});

describe("usage-warnings setting", () => {
  it("is on by default, and off only when saved as off", () => {
    const dir = mkdtempSync(join(tmpdir(), "rewake-uw-"));
    try {
      expect(loadSettings(dir).usageWarnings).toBe("on");
      saveSettings(dir, { ...loadSettings(dir), usageWarnings: "off" });
      expect(loadSettings(dir).usageWarnings).toBe("off");
      saveSettings(dir, { ...loadSettings(dir), usageWarnings: "on" });
      expect(loadSettings(dir).usageWarnings).toBe("on");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
