import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "../src/core/settings.js";
import * as port from "../src/core/usage-warn.js";

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

describe("usage warnings: the TypeScript port (Codex) matches the Claude Code plugin's rules", () => {
  type Reading = { p: number; min: number; reset?: string };
  const fixtures: Record<string, Reading[]> = {
    thresholds: [10, 79, 80, 81, 90, 95, 96, 99, 100].map((p, i) => ({ p, min: i * 5 })),
    jump: [
      { p: 50, min: 0 },
      { p: 97, min: 5 },
      { p: 98, min: 10 },
    ],
    pace: [30, 40, 50, 60, 61, 62].map((p, i) => ({ p, min: i * 10 })),
    flatThenIdle: [
      { p: 20, min: 0 },
      { p: 24, min: 10 },
      { p: 28, min: 20 },
      { p: 28, min: 170 },
    ],
    drop: [50, 60, 30, 31].map((p, i) => ({ p, min: i * 12 })),
    cap: Array.from({ length: 20 }, (_, i) => ({ p: 10 + i, min: i * 2 })),
    nextWindow: [
      { p: 85, min: 0 },
      { p: 86, min: 1 },
      { p: 85, min: 360, reset: "2026-10-06T20:00:00Z" },
    ],
    drift: [0, 1, 2, 3].map((i) => ({
      p: 85 + i,
      min: i,
      reset: new Date(Date.parse(RESET) + i * 15 * MIN).toISOString(),
    })),
    afterReset: [{ p: 90, min: 0, reset: "2026-10-06T09:00:00Z" }],
    nearReset: [30, 40, 50, 60].map((p, i) => ({ p, min: i * 10, reset: "2026-10-06T10:31:00Z" })),
  };

  for (const [name, readings] of Object.entries(fixtures)) {
    it(`gives the same steps: ${name}`, () => {
      let a: State | undefined;
      let b: State | undefined;
      for (const r of readings) {
        const now = NOW + r.min * MIN;
        const reset = r.reset ?? RESET;
        const x = logic.usageStep(a, five(r.p, reset), now);
        const y = port.usageStep(
          b,
          { kind: "five_hour", percentUsed: r.p, resetsAt: Date.parse(reset) },
          now,
        );
        expect(y).toEqual(x);
        a = x?.next ?? a;
        b = y?.next ?? b;
      }
    });
  }

  it("gives the same time to limit and pace range", () => {
    const samples = [
      { t: NOW, p: 10 },
      { t: NOW + 10 * MIN, p: 50 },
      { t: NOW + 110 * MIN, p: 57 },
      { t: NOW + 120 * MIN, p: 60 },
      { t: NOW + 125 * MIN, p: 62 },
    ];
    for (let k = 1; k <= samples.length; k++) {
      const part = samples.slice(0, k);
      const now = part.at(-1)?.t ?? NOW;
      expect(port.timeToLimit(part, now)).toEqual(logic.timeToLimit(part, now));
    }
    for (const ms of [0, 10 * MIN, 30 * MIN, 45 * MIN, 3 * 60 * MIN])
      expect(port.paceRange(ms)).toEqual(logic.paceRange(ms));
  });

  it("names the windows Codex reports", () => {
    expect(port.limitName("five_hour")).toBe("5-hour limit");
    expect(port.limitName("seven_day")).toBe("7-day limit");
    expect(port.limitName("24_hour")).toBe("24-hour limit");
  });

  it("words the warnings for Codex, and never claims to compact or type", () => {
    expect(port.levelText("five_hour", 80.6, "at 3:00 AM today")).toBe(
      "5-hour limit: 80% used, as of Codex's last reply. It resets at 3:00 AM today.",
    );
    const high = port.levelText("seven_day", 96, "on Friday at 9:00 AM");
    expect(high).toBe(
      "7-day limit: 96% used, as of Codex's last reply. It resets on Friday at 9:00 AM. A good moment to wrap up or save what you are doing.",
    );
    expect(high).not.toContain("compact");
    expect(port.paceText("five_hour", [20, 40], "at 3:00 AM today")).toBe(
      "At this pace you reach the 5-hour limit in about 20 to 40 minutes, before it resets at 3:00 AM today.",
    );
  });
});
