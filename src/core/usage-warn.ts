/**
 * Warnings before a usage limit, from an agent's own usage figures: a warning at 80% and at 95% of
 * a limit window, once per window, and when the pace would reach the limit within 45 minutes.
 *
 * The Claude Code plugin runs the same rules as plain JavaScript (src/hosts/claude-code/mod/hooks/
 * logic.js: usageStep, timeToLimit, paceRange). The plugin is copied out and can't import this
 * file, so test/usage-warnings.test.ts feeds both the same readings and fails if they differ.
 */

const MINUTE = 60_000;
/** Percent used at which a window is warned about, lowest first. */
const WARN_AT = [80, 95];
/** Samples kept per window, and the least time they must span before a pace is trusted. */
const SAMPLE_CAP = 12;
const MIN_SPAN_MS = 10 * MINUTE;
/** Only readings this recent give the pace. */
const RECENT_MS = 60 * MINUTE;
/** A pace warning comes when the projected limit is this near. */
const PACE_HORIZON_MS = 45 * MINUTE;
/** Two reset times closer than this are the same window (the figures can differ by a moment). */
const SAME_WINDOW_MS = 30 * MINUTE;

export interface UsageSample {
  /** When the figure was read (ms). */
  t: number;
  /** Percent used. */
  p: number;
}

/** What is kept for one window between readings. */
export interface UsageState {
  /** The latest reset time seen (ms), so a slowly drifting time can't make the window look new. */
  resetsAt: number;
  samples: UsageSample[];
  /** The highest threshold already shown for this window. */
  high: number;
  /** The pace was already shown for this window. */
  pace: boolean;
}

export interface UsageWindow {
  /** "five_hour", "seven_day", or "<N>_hour". */
  kind: string;
  percentUsed: number;
  /** ms */
  resetsAt?: number;
}

export interface UsageStep {
  next: UsageState;
  /** The threshold newly crossed (only the highest if it jumped past both). */
  level?: number;
  /** The pace as a range of minutes. */
  pace?: [number, number];
}

/**
 * Milliseconds until the window reaches 100, or undefined when the pace is unknown: the figure has
 * not moved since the newest sample (so idle time never counts as a pace), fewer than two samples
 * from the last hour, those less than 10 minutes apart, or no rise.
 */
export function timeToLimit(samples: UsageSample[], now: number): number | undefined {
  const recent = samples.filter((s) => s.t >= now - RECENT_MS);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || last.t !== now || last.t - first.t < MIN_SPAN_MS) return undefined;
  const rate = (last.p - first.p) / (last.t - first.t);
  return rate > 0 ? (100 - last.p) / rate : undefined;
}

/** The estimate as a range of whole minutes in fives, about 0.7x to 1.4x: [20, 40]. */
export function paceRange(ms: number): [number, number] {
  const five = (x: number) => Math.max(5, Math.round(x / (5 * MINUTE)) * 5);
  const lo = five(ms * 0.7);
  return [lo, Math.max(lo + 5, five(ms * 1.4))];
}

/**
 * One window's reading, given what was kept for it. Undefined when there is nothing to track (no
 * reset ahead, a full window: the limit flow takes over). A threshold is warned once per window,
 * the pace once per window and never together with a threshold (it waits for the next reading).
 */
export function usageStep(
  prev: UsageState | undefined,
  w: UsageWindow,
  now: number,
): UsageStep | undefined {
  const reset = w.resetsAt;
  const p = w.percentUsed;
  if (reset === undefined || !Number.isFinite(reset) || reset <= now) return undefined;
  if (!(p >= 0 && p < 100)) return undefined;
  const base: UsageState =
    prev && Math.abs(prev.resetsAt - reset) < SAME_WINDOW_MS
      ? prev
      : { resetsAt: reset, samples: [], high: 0, pace: false };
  const last = base.samples.at(-1);
  const samples =
    last?.p === p ? base.samples : [...(last && p < last.p ? [] : base.samples), { t: now, p }];
  const kept = samples.slice(-SAMPLE_CAP);
  const level = WARN_AT.filter((l) => p >= l && l > base.high).pop();
  const ms = level === undefined && !base.pace ? timeToLimit(kept, now) : undefined;
  const pace =
    ms !== undefined && ms <= PACE_HORIZON_MS && now + ms < reset ? paceRange(ms) : undefined;
  return {
    next: {
      resetsAt: reset,
      samples: kept,
      high: level ?? base.high,
      pace: base.pace || pace !== undefined,
    },
    ...(level !== undefined && { level }),
    ...(pace && { pace }),
  };
}

/** "5-hour limit", "7-day limit", "24-hour limit". */
export function limitName(kind: string): string {
  const hours = /^(\d+)_hour$/.exec(kind)?.[1];
  const name =
    kind === "five_hour"
      ? "5-hour"
      : kind === "seven_day"
        ? "7-day"
        : hours
          ? `${hours}-hour`
          : kind.replace(/_/g, " ");
  return `${name} limit`;
}

/** `reset` is the reset time as words: "at 3:00 AM today", "on Friday at 9:00 AM". */
export function levelText(kind: string, percent: number, reset: string): string {
  const head = `${limitName(kind)}: ${Math.floor(percent)}% used, as of Codex's last reply. It resets ${reset}.`;
  // No compacting hint: Codex's /compact could not be verified, and it is a model call too.
  return percent >= 95 ? `${head} A good moment to wrap up or save what you are doing.` : head;
}

export function paceText(kind: string, [lo, hi]: [number, number], reset: string): string {
  return `At this pace you reach the ${limitName(kind)} in about ${lo} to ${hi} minutes, before it resets ${reset}.`;
}
