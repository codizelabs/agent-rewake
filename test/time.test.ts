import { describe, expect, it } from "vitest";
import { formatAt, formatWhen, parseWhen } from "../src/core/time.js";

// Local-time fixtures: built with the Date constructor so tests run in any time zone.
const local = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const NOW = local(2026, 10, 4, 14, 5); // Sunday 4 Oct 2026, 14:05 local

const at = (input: string) => {
  const r = parseWhen(input, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.at;
};

describe("parseWhen", () => {
  it("parses relative times", () => {
    expect(at("in 90m")).toBe(NOW + 90 * 60_000);
    expect(at("in 3h")).toBe(NOW + 3 * 3_600_000);
    expect(at("in 1h30m")).toBe(NOW + 90 * 60_000);
    expect(at("in 2d")).toBe(NOW + 2 * 86_400_000);
  });

  it("parses a clock time as its next occurrence", () => {
    expect(at("18:00")).toBe(local(2026, 10, 4, 18, 0));
    expect(at("09:00")).toBe(local(2026, 10, 5, 9, 0)); // already passed today
    expect(at("9pm")).toBe(local(2026, 10, 4, 21, 0));
    expect(at("12am")).toBe(local(2026, 10, 5, 0, 0));
    expect(at("12:30pm")).toBe(local(2026, 10, 5, 12, 30));
  });

  it("parses today and tomorrow", () => {
    expect(at("tomorrow 09:00")).toBe(local(2026, 10, 5, 9, 0));
    expect(at("today 18:30")).toBe(local(2026, 10, 4, 18, 30));
  });

  it("parses ISO local date-times", () => {
    expect(at("2026-10-06T09:15")).toBe(local(2026, 10, 6, 9, 15));
    expect(at("2026-10-06 09:15")).toBe(local(2026, 10, 6, 9, 15));
  });

  it("rejects past, ambiguous, malformed and far-future times", () => {
    for (const bad of [
      "",
      "today 09:00",
      "9",
      "25:00",
      "13pm",
      "soon",
      "in 0m",
      "in 31d",
      "2026-13-40T99:99",
    ]) {
      expect(parseWhen(bad, NOW).ok, bad).toBe(false);
    }
  });
});

describe("formatWhen", () => {
  it("uses an absolute time with a day word", () => {
    expect(formatWhen(local(2026, 10, 4, 18, 0), NOW, "en-GB")).toBe("18:00 today");
    expect(formatWhen(local(2026, 10, 5, 9, 0), NOW, "en-GB")).toBe("09:00 tomorrow, Monday");
    expect(formatWhen(local(2026, 10, 8, 9, 0), NOW, "en-GB")).toBe("Thursday at 09:00");
    expect(formatWhen(local(2026, 10, 20, 9, 0), NOW, "en-GB")).toBe("Tuesday 20 October at 09:00");
  });
});

describe("formatAt", () => {
  it("adds the right preposition to formatWhen", () => {
    const now = new Date(2026, 9, 7, 12, 0).getTime();
    expect(formatAt(new Date(2026, 9, 7, 15, 0).getTime(), now)).toMatch(
      /^at (3:00 PM|15:00) today$/,
    );
    expect(formatAt(new Date(2026, 9, 10, 15, 0).getTime(), now)).toMatch(
      /^on Saturday at (3:00 PM|15:00)$/,
    );
  });
});
