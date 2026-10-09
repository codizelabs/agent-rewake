import { parseResetText, zonedToEpoch } from "./claude/limits.js";

/**
 * Reset times in any agent's words. Agents and providers word them differently:
 *
 *  - Claude:      "resets 4:50pm (Europe/Samara)", "resets Jan 2, 2027, 3pm", older banner "Your limit will reset at 3pm (UTC)"
 *  - Codex:       "try again at 6:34 PM.", "Try again at Sep 15th, 2026 9:25 AM.", "Oct 20, 2026, 7:38 AM"
 *  - Copilot:     "reset in 1 hour 30 minutes", "reset on October 7, 2026 at 3:47 PM" (UTC, unlabelled),
 *                 "wait 1 hours 48 minutes for your limit to reset", "in under a minute"
 *  - Antigravity: "reset in 4 days, 23 hours", "reset on Oct 7, 2026 14:05 UTC"
 *  - Gemini:      "reset after 2h3m4s", "Please retry in 44.09s", "Suggested retry after 3600s"
 *  - Droid:       "resets in 5 days", "resets in 1h 0min"; OpenCode "Resets in 4hr 10min"
 *  - Z.AI:        "Your limit will reset at 2026-09-23 18:45:35" (no zone; the vendor's is UTC+8)
 *  - Qwen:        "reset at 07-27 09:25:00 UTC" (no year)
 *  - Anthropic:   "regain access on 2026-10-01 at 00:00 UTC"
 *  - Amp:         "wait until the next hour starts"
 *  - fast-agent:  "'resets_at': 1791290000" (epoch seconds)
 *
 * Absolute times are only read after a reset or retry phrase, so a date elsewhere in the text is never
 * taken for the reset.
 */
export interface ResetOptions {
  /** The zone for a time the text gives without one, when the vendor's zone is known. */
  zone?: string;
}

const MAX_SCAN = 16_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const CUE = "(?:reset|resets|retry|try again|available again|regain access|limited until)";

export function parseResetHint(
  input: string,
  now: number,
  options: ResetOptions = {},
): number | undefined {
  // Reset phrases are short and near the start; never scan a dump.
  const text = input.slice(0, MAX_SCAN);
  return (
    epochHint(text) ??
    isoHint(text, now, options) ??
    monthNameHint(text, now, options) ??
    claudeHint(text, now) ??
    clockHint(text, now) ??
    relativeHint(text, now) ??
    nextHourHint(text, now) ??
    cycleEndHint(text, now)
  );
}

/** A duration in any of the forms agents print: "2h3m4s", "4hr 10min", "4 days, 23 hours", "202ms". */
export function parseDuration(text: string): number | undefined {
  const unit =
    /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|d|days?|h|hrs?|hours?|m(?!s)|mins?|minutes?|s|secs?|seconds?|w|weeks?)(?![a-z])/gi;
  // A duration is a few words long: "4 days, 23 hours", "1 hours 48 minutes".
  const rest = text.trim().slice(0, 80);
  let total = 0;
  let consumed = 0;
  for (const m of rest.matchAll(unit)) {
    // Only a run of units from the start, separated by spaces, commas or "and".
    const gap = rest.slice(consumed, m.index).trim().toLowerCase();
    if (gap !== "" && gap !== "," && gap !== "and" && gap !== ", and") break;
    total += Number(m[1]) * unitMs(String(m[2]));
    consumed = (m.index ?? 0) + m[0].length;
  }
  return consumed > 0 && total > 0 ? Math.round(total) : undefined;
}

function unitMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u === "ms" || u.startsWith("milli")) return 1;
  if (u === "d" || u.startsWith("day")) return 86_400_000;
  if (u === "w" || u.startsWith("week")) return 7 * 86_400_000;
  if (u === "h" || u.startsWith("hr") || u.startsWith("hour")) return 3_600_000;
  if (u === "m" || u.startsWith("min")) return 60_000;
  return 1000;
}

/** "'resets_at': 1791290000", `"resetsAt":1791290000000`. */
function epochHint(text: string): number | undefined {
  const m = /resets?_?at['"]?\s*[:=]\s*['"]?(\d{10}|\d{13})\b/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[1]?.length === 10 ? n * 1000 : n;
}

/** "2026-09-23 18:45:35", "2026-10-07T00:00:00Z", "07-27 09:25:00 UTC", "2026-10-01 at 00:00 UTC". */
function isoHint(text: string, now: number, options: ResetOptions): number | undefined {
  const full = new RegExp(
    `${CUE}[^\\n]{0,40}?\\b(\\d{4})-(\\d{2})-(\\d{2})(?:[ T]|\\s+at\\s+)(\\d{2}):(\\d{2})(?::(\\d{2}))?(?:\\.\\d+)?\\s*(Z|UTC|GMT|[+-]\\d{2}:?\\d{2})?`,
    "i",
  ).exec(text);
  if (full) {
    const [, y, mo, d, h, mi, s, zone] = full;
    const t = atZone(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s ?? 0),
      zone,
      options,
    );
    // A time already past is a timestamp, not the reset.
    return t !== undefined && t > now - 60_000 ? t : undefined;
  }
  // Month and day without a year: the next time it comes round.
  const short = new RegExp(
    `${CUE}[^\\n]{0,40}?\\b(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2})(?::(\\d{2}))?\\s*(Z|UTC|GMT)?`,
    "i",
  ).exec(text);
  if (!short) return undefined;
  const [, mo, d, h, mi, s, zone] = short;
  const year = new Date(now).getUTCFullYear();
  for (const y of [year, year + 1]) {
    const t = atZone(
      y,
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s ?? 0),
      zone,
      options,
    );
    if (t !== undefined && t > now - 60_000) return t;
  }
  return undefined;
}

/**
 * "Sep 15th, 2026 9:25 AM", "Oct 20, 2026, 7:38 AM", "October 7, 2026 at 3:47 PM",
 * "Oct 7, 2026 14:05 UTC", and day first: "20 Oct 2026, 16:29".
 */
function monthNameHint(text: string, now: number, options: ResetOptions): number | undefined {
  const monthFirst = new RegExp(
    `${CUE}[^\\n]{0,20}?\\b(?:on|at)\\s+${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4}),?\\s+(?:at\\s+)?(\\d{1,2}):(\\d{2})\\s*([ap]\\.?m\\.?)?\\s*(UTC|GMT|Z)?`,
    "i",
  ).exec(text);
  const dayFirst = monthFirst
    ? undefined
    : new RegExp(
        `${CUE}[^\\n]{0,20}?\\b(?:on|at)\\s+(\\d{1,2})\\s+${MONTH}\\s+(\\d{4}),?\\s+(?:at\\s+)?(\\d{1,2}):(\\d{2})\\s*([ap]\\.?m\\.?)?\\s*(UTC|GMT|Z)?`,
        "i",
      ).exec(text);
  let month: string | undefined;
  let day: string | undefined;
  let rest: (string | undefined)[];
  if (monthFirst) [, month, day, ...rest] = monthFirst;
  else if (dayFirst) [, day, month, ...rest] = dayFirst;
  else return undefined;
  const [year, hour, minute, ampm, zone] = rest;
  const m = MONTHS.indexOf(String(month).slice(0, 3).toLowerCase());
  const h = to24(Number(hour), ampm);
  if (m < 0 || h === undefined || Number(minute) > 59) return undefined;
  const t = atZone(Number(year), m, Number(day), h, Number(minute), 0, zone, options);
  return t !== undefined && t > now - 60_000 ? t : undefined;
}

/**
 * Claude's own wording, "resets 4:50pm (Europe/Samara)" and its date forms, and the older banner's
 * "Your limit will reset at 3pm (UTC)" (an am/pm time, so Z.AI's "reset at 2026-09-23 …" and Qwen's
 * "reset at 07-27 …" stay with their own readers).
 */
function claudeHint(text: string, now: number): number | undefined {
  const direct = parseResetText(text, now)?.resetAt;
  if (direct !== undefined) return direct;
  const older =
    /\blimit will reset at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)\b(?:\s*\([^)]+\)|\s+(?:UTC|GMT)\b)?)/i.exec(
      text,
    );
  return older ? parseResetText(`resets ${older[1]}`, now)?.resetAt : undefined;
}

/**
 * "try again at 6:34 PM", "try again at 18:34": a time of day with a colon or am/pm, never a bare
 * number ("try again after 1 seconds" is a duration).
 */
function clockHint(text: string, now: number): number | undefined {
  const m =
    /try again (?:at|after)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?!\s*(?:\d|sec|min|hour|ms|s\b|m\b|h\b))/i.exec(
      text,
    );
  if (!m || (m[2] === undefined && m[3] === undefined)) return undefined;
  const hour = to24(Number(m[1]), m[3]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour === undefined || minute > 59) return undefined;
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now - 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** "try again in 2 hours", "Resets in 4hr 10min", "retry after 3600s", "wait 1 hours 48 minutes". */
function relativeHint(text: string, now: number): number | undefined {
  if (/\bin under a minute\b/i.test(text)) return now + 60_000;
  const cue =
    /(?:try again|retry|reset[s]?|available again|wait(?:ing)?|limit will reset)\s+(?:(?:in|after)\s+(?:about\s+|approximately\s+|~)?)?(?=\d)/gi;
  for (const m of text.matchAll(cue)) {
    const ms = parseDuration(text.slice((m.index ?? 0) + m[0].length));
    if (ms !== undefined) return now + ms;
  }
  return undefined;
}

/** Cursor: "Your usage limits will reset when your monthly cycle ends on 8/10/2025" (US order). */
function cycleEndHint(text: string, now: number): number | undefined {
  const m = /\bcycle ends on (\d{1,2})\/(\d{1,2})\/(\d{4})\b/i.exec(text);
  if (!m) return undefined;
  const t = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime();
  return t > now ? t : undefined;
}

/** Amp's free usage: "wait until the next hour starts". */
function nextHourHint(text: string, now: number): number | undefined {
  if (!/\bnext hour starts\b/i.test(text)) return undefined;
  const d = new Date(now);
  d.setMinutes(60, 0, 0);
  return d.getTime();
}

function to24(hour: number, ampm: string | undefined): number | undefined {
  const p = ampm?.toLowerCase().replace(/\./g, "");
  if (p && (hour < 1 || hour > 12)) return undefined;
  if (p === "pm" && hour !== 12) return hour + 12;
  if (p === "am" && hour === 12) return 0;
  return hour <= 23 ? hour : undefined;
}

function atZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string | undefined,
  options: ResetOptions,
): number | undefined {
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const z = zone?.toUpperCase();
  if (z === "Z" || z === "UTC" || z === "GMT")
    return Date.UTC(year, month, day, hour, minute, second);
  if (z && /^[+-]\d{2}:?\d{2}$/.test(z)) {
    const sign = z.startsWith("-") ? -1 : 1;
    const digits = z.replace(/[^\d]/g, "");
    const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
    return Date.UTC(year, month, day, hour, minute, second) - offset * 60_000;
  }
  if (options.zone)
    return zonedToEpoch(year, month, day, hour, minute, options.zone) + second * 1000;
  return new Date(year, month, day, hour, minute, second).getTime();
}
