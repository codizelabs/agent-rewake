import { describe, expect, it } from "vitest";
import { describeCron, nextRun, nextRuns, parseCron, presetCron } from "../src/core/cron.js";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();
const T0 = at(2026, 10, 4, 14, 0); // Sunday 4 October 2026, 14:00 local

function cron(expr: string) {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(r.error);
  return r.cron;
}

describe("cron", () => {
  it("reads every field form and finds the next run", () => {
    expect(nextRun(cron("0 9 * * *"), T0)).toBe(at(2026, 10, 5, 9));
    expect(nextRun(cron("*/15 * * * *"), T0)).toBe(at(2026, 10, 4, 14, 15));
    expect(nextRun(cron("30 8-10 * * MON-FRI"), T0)).toBe(at(2026, 10, 5, 8, 30));
    expect(nextRun(cron("0 0 1 JAN *"), T0)).toBe(at(2027, 1, 1));
    expect(nextRun(cron("@weekly"), T0)).toBe(at(2026, 10, 11));
    expect(nextRun(cron("0 12 * * 7"), T0)).toBe(at(2026, 10, 11, 12)); // 7 is Sunday
    // Both day fields restricted: either matches (the 13th, or any Friday).
    expect(nextRuns(cron("0 0 13 * 5"), T0, 2)).toEqual([at(2026, 10, 9), at(2026, 10, 13)]);
    expect(nextRun(cron("0 0 30 2 *"), T0)).toBeUndefined(); // 30 February never comes
  });

  it("explains mistakes in plain words", () => {
    expect(parseCron("0 9 * *")).toMatchObject({
      ok: false,
      error: expect.stringContaining("has 5 parts"),
    });
    expect(parseCron("61 * * * *")).toMatchObject({
      ok: false,
      error: expect.stringContaining("outside the minute range"),
    });
    expect(parseCron("0 9 * * FUN")).toMatchObject({
      ok: false,
      error: expect.stringContaining("isn't a valid day of the week"),
    });
    expect(parseCron("*/0 * * * *")).toMatchObject({
      ok: false,
      error: expect.stringContaining("step"),
    });
  });

  it("translates expressions into plain English", () => {
    expect(describeCron(cron("0 9 * * *"))).toBe("Every day at 09:00");
    expect(describeCron(cron("0 9 * * 1-5"))).toBe("Every weekday (Monday to Friday) at 09:00");
    expect(describeCron(cron("30 18 * * 5"))).toBe("Every Friday at 18:30");
    expect(describeCron(cron("0 * * * *"))).toBe("Every hour, on the hour");
    expect(describeCron(cron("*/15 * * * *"))).toBe("Every 15 minutes");
    expect(describeCron(cron("30 * * * *"))).toBe("Every hour at 30 minutes past");
    expect(describeCron(cron("0 */2 * * *"))).toBe("Every 2 hours, on the hour");
    expect(describeCron(cron("0 9,17 * * *"))).toBe("Every day at 09:00, 17:00");
    expect(describeCron(cron("0 8 1 * *"))).toBe("On day 1 of the month at 08:00");
    expect(describeCron(cron("0 8 * 1,7 MON"))).toBe("Every Monday at 08:00, in January and July");
  });

  it("builds presets from the first run's time", () => {
    const first = at(2026, 10, 5, 9, 30); // a Monday
    expect(presetCron("hourly", first)).toBe("30 * * * *");
    expect(presetCron("daily", first)).toBe("30 9 * * *");
    expect(presetCron("weekdays", first)).toBe("30 9 * * 1-5");
    expect(presetCron("weekly", first)).toBe("30 9 * * 1");
  });
});
