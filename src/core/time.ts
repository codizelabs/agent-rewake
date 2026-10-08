/**
 * Parse the "when" part of a scheduled message. Supported forms, all resolved to
 * a UTC epoch in milliseconds relative to `now` in the local time zone:
 *
 *   in 90m · in 3h · in 1h30m · in 2d     relative
 *   09:00 · 9:30pm · 9pm                   next occurrence of that local time (today or tomorrow)
 *   today 18:00 · tomorrow 09:00           explicit day
 *   2026-10-05T09:00 · 2026-10-05 09:00    local date and time (ISO; "Z" or an offset is honoured)
 *
 * Anything else is rejected rather than guessed.
 */
export type ParsedWhen = { ok: true; at: number } | { ok: false; error: string };

const MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000; // schedules are one-off and at most 30 days ahead

export function parseWhen(input: string, now: number): ParsedWhen {
  const text = input.trim().toLowerCase();
  if (text === "") return fail("Give a time, for example 09:00, tomorrow 09:00 or in 3h.");

  const result =
    parseRelative(text, now) ??
    parseDayTime(text, now) ??
    parseClock(text, now) ??
    parseIso(input.trim());
  if (result === undefined) {
    return fail(
      `"${input.trim()}" isn't a time Rewake understands. Try 09:00, tomorrow 09:00 or in 3h.`,
    );
  }
  if (Number.isNaN(result)) return fail(`"${input.trim()}" isn't a valid date or time.`);
  if (result <= now) return fail("That time has already passed.");
  if (result - now > MAX_AHEAD_MS) return fail("Schedules can be at most 30 days ahead.");
  return { ok: true, at: result };
}

function fail(error: string): ParsedWhen {
  return { ok: false, error };
}

function parseRelative(text: string, now: number): number | undefined {
  const m = /^in\s+((?:\d+\s*[dhm]\s*)+)$/.exec(text);
  if (!m?.[1]) return undefined;
  let ms = 0;
  for (const part of m[1].matchAll(/(\d+)\s*([dhm])/g)) {
    const n = Number(part[1]);
    const unit = part[2];
    ms += n * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
  }
  return ms > 0 ? now + ms : Number.NaN;
}

/** Hours and minutes from "09:00", "9:30pm", "9pm", "21:05". */
function clock(text: string): { h: number; m: number } | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const suffix = m[3];
  if (m[2] === undefined && suffix === undefined) return undefined; // a bare number is ambiguous
  if (min > 59) return undefined;
  if (suffix) {
    if (h < 1 || h > 12) return undefined;
    if (suffix === "am" && h === 12) h = 0;
    if (suffix === "pm" && h !== 12) h += 12;
  } else if (h > 23) {
    return undefined;
  }
  return { h, m: min };
}

function atLocal(now: number, dayOffset: number, h: number, m: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function parseClock(text: string, now: number): number | undefined {
  const c = clock(text);
  if (!c) return undefined;
  const today = atLocal(now, 0, c.h, c.m);
  return today > now ? today : atLocal(now, 1, c.h, c.m);
}

function parseDayTime(text: string, now: number): number | undefined {
  const m = /^(today|tomorrow)\s+(.+)$/.exec(text);
  if (!m?.[2]) return undefined;
  const c = clock(m[2]);
  if (!c) return Number.NaN;
  return atLocal(now, m[1] === "tomorrow" ? 1 : 0, c.h, c.m);
}

function parseIso(text: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}/i.test(text)) return undefined;
  // Date-time strings without an offset are interpreted as local time by the Date constructor.
  return new Date(text.replace(" ", "T")).getTime();
}

/**
 * Rewake's text is English, so dates are written in English too, whatever the system language
 * (on Windows the system language would otherwise give "tomorrow, Montag").
 */
export const TEXT_LOCALE = "en-US";

/** "09:00 today", "09:00 tomorrow, Monday", "on Thursday at 09:00": absolute local time first. */
/** How times are shown: 12-hour "3:19 PM" by default, or 24-hour "15:19". */
export type Clock = "12h" | "24h";
let clockSetting: Clock = "12h";

export function setClock(value: Clock): void {
  clockSetting = value;
}

export function getClock(): Clock {
  return clockSetting;
}

/** An hour and minute in the chosen clock: "3:19 PM" or "15:19". */
export function clockTime(hour: number, minute: number, which: Clock = clockSetting): string {
  const mm = String(minute).padStart(2, "0");
  if (which === "24h") return `${String(hour).padStart(2, "0")}:${mm}`;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${mm} ${hour < 12 ? "AM" : "PM"}`;
}

/** The local time of `at` in the chosen clock. */
export function formatClock(at: number): string {
  const d = new Date(at);
  return clockTime(d.getHours(), d.getMinutes());
}

export function formatWhen(at: number, now: number, locale?: string): string {
  const time = formatClock(at);
  const dayDiff = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  const weekday = new Intl.DateTimeFormat(locale ?? TEXT_LOCALE, { weekday: "long" }).format(at);
  if (dayDiff === 0) return `${time} today`;
  if (dayDiff === 1) return `${time} tomorrow, ${weekday}`;
  if (dayDiff > 1 && dayDiff < 7) return `${weekday} at ${time}`;
  const date = new Intl.DateTimeFormat(locale ?? TEXT_LOCALE, {
    day: "numeric",
    month: "long",
  }).format(at);
  return `${weekday} ${date} at ${time}`;
}

/** `formatWhen` with its preposition: "at 3:00 PM today", "on Saturday at 3:00 PM". */
export function formatAt(at: number, now: number, locale?: string): string {
  const s = formatWhen(at, now, locale);
  return /^\d/.test(s) ? `at ${s}` : `on ${s}`;
}

/**
 * An unambiguous time for the agent's tool replies: "Mon 5 Oct 2026, 13:00 (Asia/Karachi, GMT+5)".
 * Relative words like "tomorrow" depend on when they're read; this doesn't.
 */
export function formatExact(at: number, locale?: string, timeZone?: string): string {
  const zone = timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Intl.DateTimeFormat(locale ?? TEXT_LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: zone,
  }).format(at);
  const time = new Intl.DateTimeFormat(locale ?? TEXT_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
  }).format(at);
  const offset =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${date}, ${time} (${zone}${offset ? `, ${offset}` : ""})`;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The wall-clock fields of `at` in `timeZone`. */
function zoneParts(at: number, timeZone: string): { y: number; m: number; d: number; ms: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  const wall = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour, p.minute, p.second);
  return {
    y: p.year ?? 0,
    m: p.month ?? 1,
    d: p.day ?? 1,
    ms: wall - Math.floor(at / 1000) * 1000,
  };
}

/**
 * The next midnight in `timeZone` after `now` (Gemini API quotas reset "at midnight Pacific
 * time"). Correct across daylight-saving changes: the offset is taken at the midnight itself.
 */
export function nextMidnight(timeZone: string, now: number): number {
  const today = zoneParts(now, timeZone);
  const wallMidnight = Date.UTC(today.y, today.m - 1, today.d + 1);
  let at = wallMidnight - today.ms;
  for (let i = 0; i < 2; i++) at = wallMidnight - zoneParts(at, timeZone).ms;
  return at;
}
