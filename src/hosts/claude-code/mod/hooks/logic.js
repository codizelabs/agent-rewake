// Pure helpers for Agent Rewake's Claude Code mod: no mods API calls, so the mod's tests and
// Rewake's own tests can import them. Kept in step with Rewake's core rules (src/core/resume.ts,
// src/core/time.ts); a test in Rewake's repository fails if they drift apart.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** Wait this long past the reset, so the first request isn't refused at the boundary. */
export const AFTER_RESET_MS = 60_000;
/** Past this, the machine probably slept through the reset: offer the message, don't send it. */
export const STALE_MS = 30 * MINUTE;
/** Claude Code's own wait gives up on resets further away than this. */
export const NATIVE_HORIZON_MS = 24 * HOUR;
/** A reset further away than this is always asked about, even with "always" (rule 2). */
export const FAR_RESET_MS = 24 * HOUR;
/** A limit with no reset time after this long is not a usage limit Rewake can wait out. */
export const WAITING_EXPIRES_MS = 10 * MINUTE;
/** Times Rewake waits for a later window that is still used up, before it stops. */
export const MAX_REARMS = 4;
/** The limit came back this soon after a continue: count it as a re-hit. */
export const REHIT_WINDOW_MS = 15 * MINUTE;
/** Re-hits in a row before Rewake stops continuing this session (Claude Code's own cap is 2). */
export const MAX_REHITS = 2;
export const CONTINUE_TEXT = "Your usage limit has reset. Continue from where you left off.";

/**
 * Spending caps are billing, never waited for, except a cap that resets within a day: a gateway's
 * daily cap ("spend limit reached (daily; resets 00:00 UTC)") comes back on its own.
 */
const BILLING_KINDS = new Set(["spend_limit"]);
const isBilling = (w, now) => {
  if (!BILLING_KINDS.has(w.kind)) return false;
  const t = typeof w.resetsAt === "string" ? Date.parse(w.resetsAt) : Number.NaN;
  return !(Number.isFinite(t) && t > now && t - now <= FAR_RESET_MS);
};

/**
 * When the used-up windows reset, in ms since the epoch, or undefined when none is used up now.
 * `rateLimits` is `$.session.usage().rateLimits` or `session.measure`'s `e.rateLimits`:
 * `{ kind, percentUsed, resetsAt? }[]`, `resetsAt` an ISO 8601 string. The figures are those of
 * the last API response, so a window whose reset has passed is ignored even if it still reads 100.
 * A spending cap (`spend_limit`) is billing and never counts, unless it resets within a day.
 */
export function blockedUntil(rateLimits, now) {
  let latest;
  for (const w of rateLimits ?? []) {
    if (isBilling(w, now)) continue;
    if (!(w.percentUsed >= 100) || typeof w.resetsAt !== "string") continue;
    const t = Date.parse(w.resetsAt);
    if (!Number.isFinite(t) || t <= now) continue;
    if (latest === undefined || t > latest) latest = t;
  }
  return latest;
}

/** The kind of the window that resets last among the used-up ones ("five_hour", "seven_day"). */
export function blockingKind(rateLimits, now) {
  const until = blockedUntil(rateLimits, now);
  return (rateLimits ?? []).find(
    (w) => !isBilling(w, now) && w.resetsAt !== undefined && Date.parse(w.resetsAt) === until,
  )?.kind;
}

/**
 * Whether Claude Code's own "Continue automatically at usage limit" will most likely continue
 * this limit by itself: an interactive terminal session, the setting not turned off (absent means
 * on), and a reset within 24 hours. The Desktop app's own checkbox can't be read, so Desktop
 * never counts as native here: Rewake asks there.
 */
export function nativeLikely({ isInteractive, surface, setting, resetAt, now }) {
  return (
    isInteractive === true &&
    surface === "terminal" &&
    setting !== false &&
    resetAt !== undefined &&
    resetAt - now <= NATIVE_HORIZON_MS
  );
}

/** Whether to ask before arming: always, unless the person chose "always" and it's within a day. */
export function mustAsk({ autoContinue, fireAt, now }) {
  return autoContinue !== "always" || fireAt - now > FAR_RESET_MS;
}

/** "3:05 PM" or "15:05", in the person's clock ("12h" by default, as in Rewake's settings). */
function clockTime(d, clock) {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  if (clock === "24h") return `${String(h).padStart(2, "0")}:${m}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * "3:05 PM today", "9:00 AM tomorrow (Thursday)", "Friday at 9:00 AM", "Monday 12 October at
 * 9:00 AM": Rewake's own wording for times (src/core/time.ts formatWhen), in the host's time zone.
 */
export function when(ms, now, clock = "12h") {
  const time = clockTime(new Date(ms), clock);
  const dayDiff = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(ms);
  if (dayDiff === 0) return `${time} today`;
  if (dayDiff === 1) return `${time} tomorrow (${weekday})`;
  if (dayDiff > 1 && dayDiff < 7) return `${weekday} at ${time}`;
  const date = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long" }).format(ms);
  return `${weekday} ${date} at ${time}`;
}

/** Session ids become file names in Rewake's state folder: accept only the shapes Claude Code uses. */
export function safeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** An example time for help texts, in the person's clock. */
export function exampleTime(clock = "12h") {
  return clock === "24h" ? "18:00" : "6pm";
}

/**
 * Parses `/rewake` arguments:
 *   ""                → { kind: 'list' }
 *   "list"            → { kind: 'list' }
 *   "cancel"          → { kind: 'cancel' }    (the pending continue only)
 *   "continue"        → { kind: 'continue' }  (continue at the reset after all)
 *   "clear"           → { kind: 'clear' }     (delete every scheduled message, after asking)
 *   "ask"             → { kind: 'ask' }       (turn "always" off: ask again at each limit)
 *   "in 90m text"     → { kind: 'add', at, text }   (m or h)
 *   "at 6pm text"     → { kind: 'add', at, text }   (6pm, 6:30pm, 18:00: the next one, local time)
 * Anything else → { kind: 'help', reason }.
 */
export function parseArgs(args, now, clock = "12h") {
  const s = (args ?? "").trim();
  if (s === "" || s === "list") return { kind: "list" };
  if (s === "cancel") return { kind: "cancel" };
  if (s === "continue") return { kind: "continue" };
  if (s === "clear") return { kind: "clear" };
  if (s === "ask") return { kind: "ask" };
  const tryThis = `Try "/rewake in 30m <message>" or "/rewake at ${exampleTime(clock)} <message>".`;
  let at;
  let text;
  const rel = /^in\s+(\d+)\s*(m|min|h|hr)\s+([\s\S]+)$/i.exec(s);
  const abs = rel ? null : /^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+([\s\S]+)$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    at = now + n * (rel[2].toLowerCase().startsWith("h") ? HOUR : MINUTE);
    text = rel[3];
  } else if (abs) {
    let h = Number(abs[1]);
    const min = Number(abs[2] ?? 0);
    const half = abs[3]?.toLowerCase();
    if ((half && (h < 1 || h > 12)) || h > 23 || min > 59)
      return { kind: "help", reason: `Rewake couldn't read that time. ${tryThis}` };
    if (half === "pm" && h < 12) h += 12;
    if (half === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    at = d.getTime();
    text = abs[4];
  } else {
    return { kind: "help", reason: tryThis };
  }
  text = text.trim();
  // $.prompt.submit refuses text that starts with "/" (it would run a command).
  if (text.startsWith("/"))
    return { kind: "help", reason: 'A scheduled message cannot start with "/".' };
  return { kind: "add", at, text };
}
