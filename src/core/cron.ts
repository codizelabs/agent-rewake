import { clockTime } from "./time.js";

/**
 * Repeating schedules: standard 5-field cron in the local time zone, plus the
 * presets the forms offer. No dependencies.
 *
 *   ┌ minute (0–59)  ┌ hour (0–23)  ┌ day of month (1–31)  ┌ month (1–12 or JAN–DEC)
 *   │                │              │                      │       ┌ day of week (0–7 or SUN–SAT; 0 and 7 are Sunday)
 *   *                *              *                      *       *
 *
 * Each field takes `*`, numbers, ranges `a-b`, steps `*\/n` and `a-b/n`, and lists `a,b,c`.
 * `@hourly`, `@daily` (`@midnight`), `@weekly`, `@monthly`, `@yearly` (`@annually`) are accepted.
 * When both day fields are restricted, a day matches if *either* matches (Vixie cron behaviour).
 */

export interface Cron {
  /** The expression as the user wrote it (trimmed). */
  source: string;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Whether the day-of-month and day-of-week fields were `*`. */
  anyDay: boolean;
  anyWeekday: boolean;
}

export type ParsedCron = { ok: true; cron: Cron } | { ok: false; error: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset added to a name's index (months are 1-based). */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day of the week", min: 0, max: 7, names: DAYS, nameBase: 0 },
];

export function parseCron(input: string): ParsedCron {
  const source = input.trim().replace(/\s+/g, " ");
  const expanded = MACROS[source.toLowerCase()] ?? source;
  const parts = expanded.split(" ");
  if (parts.length !== 5)
    return {
      ok: false,
      error: `A cron expression has 5 parts (minute hour day month weekday), for example "0 9 * * 1-5". "${source}" has ${parts.length}.`,
    };
  const sets: Set<number>[] = [];
  for (const [i, spec] of FIELDS.entries()) {
    const r = parseField(parts[i] as string, spec);
    if (typeof r === "string") return { ok: false, error: r };
    sets.push(r);
  }
  const weekdays = sets[4] as Set<number>;
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    ok: true,
    cron: {
      source,
      minutes: sets[0] as Set<number>,
      hours: sets[1] as Set<number>,
      days: sets[2] as Set<number>,
      months: sets[3] as Set<number>,
      weekdays,
      anyDay: parts[2] === "*",
      anyWeekday: parts[4] === "*",
    },
  };
}

function parseField(text: string, spec: FieldSpec): Set<number> | string {
  const out = new Set<number>();
  const value = (v: string): number | undefined => {
    const lower = v.toLowerCase();
    if (spec.names) {
      const i = spec.names.indexOf(lower);
      if (i !== -1) return i + (spec.nameBase ?? 0);
    }
    return /^\d+$/.test(v) ? Number(v) : undefined;
  };
  for (const item of text.split(",")) {
    const [range = "", stepText] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1)
      return `"${item}" in the ${spec.name} has a step Rewake doesn't understand.`;
    let lo: number | undefined;
    let hi: number | undefined;
    if (range === "*") {
      lo = spec.min;
      hi = spec.name === "day of the week" ? 6 : spec.max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      lo = value(a);
      hi = value(b);
    } else {
      lo = value(range);
      hi = stepText === undefined ? lo : spec.max;
    }
    if (lo === undefined || hi === undefined)
      return `"${item}" isn't a valid ${spec.name}. Use numbers${spec.names ? ` or names like ${spec.names.slice(0, 3).join(", ").toUpperCase()}` : ""}.`;
    if (lo < spec.min || hi > spec.max || lo > hi)
      return `"${item}" is outside the ${spec.name} range (${spec.min}–${spec.max}).`;
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

/** The first run strictly after `after` (local time), or undefined if none within 5 years. */
export function nextRun(cron: Cron, after: number): number | undefined {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!cron.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return undefined;
}

/** The next `count` runs after `after`. */
export function nextRuns(cron: Cron, after: number, count: number): number[] {
  const out: number[] = [];
  let t = after;
  for (let i = 0; i < count; i++) {
    const n = nextRun(cron, t);
    if (n === undefined) break;
    out.push(n);
    t = n;
  }
  return out;
}

function dayMatches(cron: Cron, d: Date): boolean {
  const dom = cron.days.has(d.getDate());
  const dow = cron.weekdays.has(d.getDay());
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return dow;
  if (cron.anyWeekday) return dom;
  return dom || dow;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Plain-English reading of the expression, e.g. "Every weekday (Monday to Friday) at 09:00". */
export function describeCron(cron: Cron): string {
  const minutes = [...cron.minutes].sort((a, b) => a - b);
  const hours = [...cron.hours].sort((a, b) => a - b);
  const pad = (n: number) => String(n).padStart(2, "0");
  const at = (h: number, m: number) => clockTime(h, m);

  let time: string;
  if (cron.minutes.size === 60 && cron.hours.size === 24) time = "every minute";
  else if (cron.hours.size === 24 && cron.minutes.size === 1)
    time = `every hour, ${pastHour(minutes[0] as number)}`;
  else if (cron.hours.size === 24 && isEvery(minutes, 60))
    time = `every ${(minutes[1] as number) - (minutes[0] as number)} minutes`;
  else if (cron.hours.size === 24) time = `every hour at minutes ${minutes.map(pad).join(", ")}`;
  else if (cron.minutes.size === 1 && hours.length <= 6)
    time = `at ${hours.map((h) => at(h, minutes[0] as number)).join(", ")}`;
  else if (cron.minutes.size === 1 && isEvery(hours, 24))
    time = `every ${(hours[1] as number) - (hours[0] as number)} hours, ${pastHour(minutes[0] as number)}`;
  else time = `at minute ${listOf(minutes.map(String))} of hour ${listOf(hours.map(String))}`;

  const weekdays = [...cron.weekdays].sort((a, b) => a - b);
  const days = [...cron.days].sort((a, b) => a - b);
  let day = "";
  const weekdayText = (): string => {
    if (weekdays.join() === "1,2,3,4,5") return "every weekday (Monday to Friday)";
    if (weekdays.join() === "0,6") return "every weekend day";
    return `every ${listOf(weekdays.map((w) => DAY_NAMES[w] as string))}`;
  };
  const dayText = () => `on day ${listOf(days.map(String))} of the month`;
  if (cron.anyDay && cron.anyWeekday) day = time.startsWith("every") ? "" : "every day";
  else if (cron.anyDay) day = weekdayText();
  else if (cron.anyWeekday) day = dayText();
  else day = `${dayText()} and ${weekdayText()}`;

  const months = [...cron.months].sort((a, b) => a - b);
  const month =
    cron.months.size === 12 ? "" : `in ${listOf(months.map((m) => MONTH_NAMES[m - 1] as string))}`;

  const text = [day, time, month]
    .filter(Boolean)
    .join(", ")
    .replace(/^every day, at/, "Every day at");
  return capitalize(text.replace(/, at /, " at "));
}

/** About how many runs a day, for a warning on very frequent schedules. */
export function runsPerDay(cron: Cron): number {
  return cron.minutes.size * cron.hours.size;
}

function isEvery(values: number[], cycle: number): boolean {
  if (values.length < 2) return false;
  const step = (values[1] as number) - (values[0] as number);
  return (
    values.every((v, i) => i === 0 || v - (values[i - 1] as number) === step) &&
    (values.at(-1) as number) + step >= cycle &&
    (values[0] as number) < step
  );
}

function pastHour(minute: number): string {
  return minute === 0 ? "on the hour" : `at ${minute} minutes past`;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type RepeatPreset = "hourly" | "daily" | "weekdays" | "weekly";

/** A cron expression for a preset, anchored on the first run's local time. */
export function presetCron(preset: RepeatPreset, first: number): string {
  const d = new Date(first);
  const m = d.getMinutes();
  const h = d.getHours();
  switch (preset) {
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${d.getDay()}`;
  }
}
