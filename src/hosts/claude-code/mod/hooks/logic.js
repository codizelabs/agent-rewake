// Pure helpers for Agent Rewake's Claude Code mod: no mods API calls, so the mod's tests and
// Rewake's own tests can import them. Kept in step with Rewake's core rules (src/core/resume.ts,
// src/core/time.ts); a test in Rewake's repository fails if they drift apart.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** Wait this long past the reset, so the first request isn't refused at the boundary. */
export const AFTER_RESET_MS = 60_000;
/** Past this, the machine probably slept through the reset: offer the message, don't send it. */
export const STALE_MS = 30 * MINUTE;
/** How far ahead a continue keeps the Mac awake: covers a 5-hour limit (Rewake's WAKE_HORIZON_MS). */
export const WAKE_HORIZON_MS = 6 * HOUR;
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
/**
 * Sent as the person's message, so it says who sent it (Rewake's AUTO_LABEL, src/addon.ts):
 * automation never speaks as the person (zed-launch A-5).
 */
export const CONTINUE_TEXT =
  "[Sent automatically by Agent Rewake after the usage limit reset] Continue from where you left off.";

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
 * Claude Code's own panels, by `CLAUDE_CODE_ENTRYPOINT`: the VS Code extension (also in Cursor and
 * other VS Code builds) and the desktop app. They run Claude Code through the Agent SDK, so the
 * session isn't "interactive" and has no surface, but a person is at the prompt.
 */
const PANELS = { "claude-vscode": "vscode", "claude-desktop": "desktop" };

/** Whether a person is at this session's prompt: the terminal, or one of Claude Code's panels. */
export function personAtPrompt({ isInteractive, entrypoint }) {
  return (
    isInteractive === true || (typeof entrypoint === "string" && Object.hasOwn(PANELS, entrypoint))
  );
}

/** The session's surface, or the panel's when the Agent SDK reports none. */
export function surfaceOf({ surface, entrypoint }) {
  return (
    surface ??
    (typeof entrypoint === "string" && Object.hasOwn(PANELS, entrypoint)
      ? PANELS[entrypoint]
      : null)
  );
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

/**
 * Whether to ask before arming: always, unless the person chose "always" and it's within a day.
 * The Desktop app always asks: its own "Auto-continue when limits reset" checkbox can't be read,
 * and both continuing would send twice.
 */
export function mustAsk({ autoContinue, fireAt, now, surface }) {
  return autoContinue !== "always" || fireAt - now > FAR_RESET_MS || surface === "desktop";
}

/**
 * Whether a limit record has outlived its use and should be forgotten, so it no longer holds up
 * scheduled messages or later limits: a limit that never got a reset time, Claude Code's own wait
 * whose time is long past, or an offer left unanswered for a day after its reset.
 */
export function expired(ep, now) {
  if (!ep) return false;
  if (ep.state === "waiting") return now - ep.createdAt > WAITING_EXPIRES_MS;
  if (ep.state === "native") return ep.fireAt === undefined || now - ep.fireAt > STALE_MS;
  if (ep.state === "offered") return ep.fireAt === undefined || now - ep.fireAt > FAR_RESET_MS;
  return false;
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
 * "3:05 PM today", "9:00 AM tomorrow, Thursday", "Friday at 9:00 AM", "Monday 12 October at
 * 9:00 AM": Rewake's own wording for times (src/core/time.ts formatWhen), in the host's time zone.
 */
export function when(ms, now, clock = "12h") {
  const time = clockTime(new Date(ms), clock);
  const dayDiff = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(ms);
  if (dayDiff === 0) return `${time} today`;
  if (dayDiff === 1) return `${time} tomorrow, ${weekday}`;
  if (dayDiff > 1 && dayDiff < 7) return `${weekday} at ${time}`;
  const date = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long" }).format(ms);
  return `${weekday} ${date} at ${time}`;
}

/** Session ids become file names in Rewake's state folder: accept only the shapes Claude Code uses. */
export function safeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

// ---- `/rewake`: Rewake's one command, the same everywhere (src/core/command.ts and time.ts).
// A copy, because this mod runs without Rewake's code; test/command.test.ts compares the two.

/** Schedules are one-off and at most 30 days ahead (src/core/time.ts). */
const MAX_AHEAD_MS = 30 * 24 * HOUR;

/** Hours and minutes from "09:00", "9:30pm", "9pm", "21:05". */
function clockOf(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const suffix = m[3];
  if (m[2] === undefined && suffix === undefined) return undefined;
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

function atLocal(now, dayOffset, h, m) {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * "in 90m", "in 1h30m", "in 2d", "9pm", "21:05", "tomorrow 9:00", "2026-10-06 09:00": the same
 * times as Rewake's parseWhen, with the same answers. Returns { ok, at } or { ok: false, error }.
 */
export function parseWhen(input, now) {
  const text = input.trim().toLowerCase();
  const fail = (error) => ({ ok: false, error });
  if (text === "") return fail("Give a time, for example 09:00, tomorrow 09:00 or in 3h.");
  let result;
  const rel = /^in\s+((?:\d+\s*[dhm]\s*)+)$/.exec(text);
  if (rel?.[1]) {
    let ms = 0;
    for (const part of rel[1].matchAll(/(\d+)\s*([dhm])/g)) {
      const unit = part[2];
      ms += Number(part[1]) * (unit === "d" ? 86_400_000 : unit === "h" ? HOUR : MINUTE);
    }
    result = ms > 0 ? now + ms : Number.NaN;
  }
  if (result === undefined) {
    const day = /^(today|tomorrow)\s+(.+)$/.exec(text);
    if (day?.[2]) {
      const c = clockOf(day[2]);
      result = c ? atLocal(now, day[1] === "tomorrow" ? 1 : 0, c.h, c.m) : Number.NaN;
    }
  }
  if (result === undefined) {
    const c = clockOf(text);
    if (c) {
      const today = atLocal(now, 0, c.h, c.m);
      result = today > now ? today : atLocal(now, 1, c.h, c.m);
    }
  }
  if (result === undefined && /^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}/i.test(input.trim()))
    result = new Date(input.trim().replace(" ", "T")).getTime();
  if (result === undefined)
    return fail(
      `"${input.trim()}" isn't a time Rewake understands. Try 09:00, tomorrow 09:00 or in 3h.`,
    );
  if (Number.isNaN(result)) return fail(`"${input.trim()}" isn't a valid date or time.`);
  if (result <= now) return fail("That time has already passed.");
  if (result - now > MAX_AHEAD_MS) return fail("Schedules can be at most 30 days ahead.");
  return { ok: true, at: result };
}

/**
 * "<when> <message>", trying the longest time phrase first; a leading "at" is allowed. Returns
 * { ok, at, text } (text may be empty: a time alone) or { ok: false, error }.
 */
export function splitWhen(args, now) {
  let words = args.split(/\s+/).filter(Boolean);
  if (words[0]?.toLowerCase() === "at" && words.length > 1) words = words.slice(1);
  if (words[0]?.toLowerCase() === "in") {
    let i = 1;
    while (i < words.length && /^\d+[dhm](\d+[dhm])*$/i.test(words[i] ?? "")) i++;
    const r = parseWhen(words.slice(0, i).join(" "), now);
    return r.ok ? { ok: true, at: r.at, text: words.slice(i).join(" ") } : r;
  }
  let error = "Start with a time, for example: /rewake in 1h Run the tests.";
  for (const take of [2, 1]) {
    if (words.length < take) continue;
    const r = parseWhen(words.slice(0, take).join(" "), now);
    if (r.ok) return { ok: true, at: r.at, text: words.slice(take).join(" ") };
    if (take === 1) error = r.error;
  }
  return { ok: false, error };
}

/** `/rewake <args>` as one of the command's forms (src/core/command.ts parseRewake). */
export function parseCommand(args) {
  const s = (args ?? "").trim();
  if (s === "") return { kind: "home" };
  const [first = "", ...words] = s.split(/\s+/);
  const sub = first.toLowerCase();
  const rest = words.join(" ");
  switch (sub) {
    case "help":
    case "?":
      return { kind: "help" };
    case "list":
      return { kind: "list" };
    case "continue":
      return rest ? { kind: "continue", when: rest } : { kind: "continue" };
    case "cancel":
    case "rm":
    case "delete": {
      const which = words[0]?.toLowerCase();
      return which ? { kind: "cancel", which } : { kind: "cancel" };
    }
    case "clear":
      return { kind: "cancel", which: "all" };
    case "auto": {
      const w = words[0]?.toLowerCase();
      return w === "on"
        ? { kind: "auto", on: true }
        : w === "off"
          ? { kind: "auto", on: false }
          : { kind: "auto" };
    }
    case "ask":
      return { kind: "auto", on: false };
    case "stop":
      return { kind: "stop" };
    case "resume":
      if (words.length === 0) return { kind: "continue" };
      return { kind: "item", action: "resume", n: words[0] ?? "", rest: words.slice(1).join(" ") };
    case "now":
    case "pause":
    case "move":
    case "edit": {
      const [n, ...more] = words;
      return { kind: "item", action: sub, ...(n !== undefined && { n }), rest: more.join(" ") };
    }
    case "prompt":
      return { kind: "prompt", text: rest };
    case "page":
      return { kind: "page" };
    case "every":
    case "cron":
      return { kind: "repeat", sub, words };
    default:
      return { kind: "at", args: s };
  }
}

/** What `/rewake` can do in Claude Code (src/core/command.ts CLAUDE_CODE_PLACE). */
export const FEATURES = new Set(["messages", "cancelOne", "auto"]);

/** The feature a command needs beyond continuing and listing (src/core/command.ts featureOf). */
export function featureOf(c) {
  switch (c.kind) {
    case "repeat":
      return "repeat";
    case "cancel":
      return c.which === undefined ? undefined : "cancelOne";
    case "auto":
      return "auto";
    case "stop":
      return "stop";
    case "item":
      return "items";
    case "prompt":
      return "prompt";
    case "page":
      return "page";
    default:
      return undefined;
  }
}

const FEATURE_WORDS = {
  messages: "schedule messages",
  repeat: "repeat messages",
  cancelOne: "delete scheduled messages",
  auto: "turn automatic continue on or off",
  stop: "stop a scheduled reply",
  items: "change a scheduled message",
  prompt: "change the resume message",
  page: "open the overview page",
};

/** The one line for something Claude Code can't do. */
export function notHere(feature) {
  return `Rewake can't ${FEATURE_WORDS[feature]} in Claude Code. Type /rewake help to see what it can do.`;
}

/** The help text (src/core/command.ts rewakeHelp(CLAUDE_CODE_PLACE)). */
export function helpText() {
  const rows = [
    ["/rewake", "at a usage limit: continue after the reset"],
    ["/rewake 3:30pm", "continue after the usage limit at that time"],
    ["/rewake in 1h Run the tests", "send a message later (9pm, tomorrow 9:00, in 90m)"],
    ["/rewake list", "what's scheduled here"],
    ["/rewake cancel", "cancel the continue after the usage limit"],
    ["/rewake cancel N | all", "delete scheduled message N, or all of them"],
    ["/rewake auto on|off", "continue after usage limits without asking, or ask each time"],
  ];
  const width = Math.max(...rows.map(([l]) => l.length));
  return [
    "Rewake in Claude Code:",
    "",
    ...rows.map(([l, r]) => `${l.padEnd(width)}   ${r}`),
    "",
    "Times: 9:00, 9pm, tomorrow 9:00, in 90m, in 3h, 2026-10-06 09:00 (your local time).",
  ].join("\n");
}
