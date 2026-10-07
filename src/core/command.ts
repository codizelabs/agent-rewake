import { parseWhen } from "./time.js";

/**
 * `/rewake`: the one command a person types to Rewake inside a conversation, the same in every
 * place Rewake runs. This module holds its grammar and help text, independent of any agent; each
 * place describes itself with a RewakePlace (what it's called, how the command is typed there,
 * what it can do), carries out what it can, and says in one line what it can't. The Claude Code
 * mod (src/hosts/claude-code/mod/hooks/logic.js) runs without Rewake's code, so it keeps a copy
 * that test/command.test.ts compares with this one.
 *
 *   /rewake                       at a usage limit: continue after the reset; otherwise what is set
 *                                 here and how to use Rewake (a place may open its form instead)
 *   /rewake <when> <message>      send a message at that time
 *   /rewake <when>                continue after the usage limit at that time
 *   /rewake continue [<when>]     continue after the usage limit, at the reset or at <when>
 *   /rewake every … | cron …      repeat a message
 *   /rewake list                  what is scheduled here
 *   /rewake cancel                cancel the continue after the usage limit
 *   /rewake cancel N | all        delete scheduled message N, or all of them
 *   /rewake auto on|off           continue after usage limits without asking, or ask each time
 *   /rewake stop                  stop a scheduled reply that is running
 *   /rewake now|pause|resume N, move N <when>, edit N <text>, prompt <text>, page
 *   /rewake help
 *
 * Unlisted words kept from earlier names: `rm N` / `delete N` (cancel N), `clear` (cancel all),
 * `resume` without a number (continue), `ask` (auto off).
 */

export const COMMAND_NAME = "rewake";

export type RewakeCommand =
  | { kind: "home" }
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "continue"; when?: string }
  | { kind: "cancel"; which?: string }
  | { kind: "auto"; on?: boolean }
  | { kind: "stop" }
  | { kind: "item"; action: "now" | "pause" | "resume" | "move" | "edit"; n?: string; rest: string }
  | { kind: "prompt"; text: string }
  | { kind: "page" }
  | { kind: "repeat"; sub: "every" | "cron"; words: string[] }
  | { kind: "at"; args: string };

/** What a person typed after `/rewake` (or Codex's `rewake`), as one of the command's forms. */
export function parseRewake(args: string): RewakeCommand {
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
      return {
        kind: "item",
        action: "resume",
        n: words[0] ?? "",
        rest: words.slice(1).join(" "),
      };
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

/**
 * Split "<when> <message>" by trying the longest time phrase first. A leading "at" is allowed
 * ("at 6pm Run the tests"). The message may be empty: `/rewake 3:30pm` alone means "continue then".
 */
export function splitWhen(args: string, now: number): { at: number; text: string } {
  let words = args.split(/\s+/).filter(Boolean);
  if (words[0]?.toLowerCase() === "at" && words.length > 1) words = words.slice(1);
  if (words[0]?.toLowerCase() === "in") {
    let i = 1;
    while (i < words.length && /^\d+[dhm](\d+[dhm])*$/i.test(words[i] ?? "")) i++;
    const r = parseWhen(words.slice(0, i).join(" "), now);
    if (!r.ok) throw new Error(r.error);
    return { at: r.at, text: words.slice(i).join(" ") };
  }
  let lastError = `Start with a time, for example: /${COMMAND_NAME} in 1h Run the tests.`;
  for (const take of [2, 1]) {
    if (words.length < take) continue;
    const r = parseWhen(words.slice(0, take).join(" "), now);
    if (r.ok) return { at: r.at, text: words.slice(take).join(" ") };
    if (take === 1) lastError = r.error;
  }
  throw new Error(lastError);
}

/** Things a place can do with `/rewake`. Continuing after a usage limit works everywhere. */
export type RewakeFeature =
  | "messages" // schedule one-off messages
  | "repeat" // every … / cron …
  | "cancelOne" // cancel N, cancel all
  | "auto" // auto on|off
  | "stop" // stop a running scheduled reply
  | "items" // now / pause / resume / move / edit N
  | "prompt" // this thread's resume message
  | "page"; // the overview of all scheduled messages

export interface RewakePlace {
  /** "Zed", "Claude Code", "Gemini CLI", "Codex". */
  name: string;
  /** How the command is typed there: "/rewake", or "rewake" in Codex. */
  typed: string;
  features: ReadonlySet<RewakeFeature>;
}

/** The feature a command needs, if any beyond continuing after a limit and listing. */
export function featureOf(c: RewakeCommand): RewakeFeature | undefined {
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

const FEATURE_WORDS: Record<RewakeFeature, string> = {
  messages: "schedule messages",
  repeat: "repeat messages",
  cancelOne: "delete scheduled messages",
  auto: "turn automatic continue on or off",
  stop: "stop a scheduled reply",
  items: "change a scheduled message",
  prompt: "change the resume message",
  page: "open the overview page",
};

/** The one line a place answers with when it can't do something. */
export function notHere(place: RewakePlace, feature: RewakeFeature): string {
  return `Rewake can't ${FEATURE_WORDS[feature]} in ${place.name}. Type ${place.typed} help to see what it can do.`;
}

/** The help text: the same lines everywhere, only those the place can do. */
export function rewakeHelp(place: RewakePlace): string {
  const c = place.typed;
  const has = (f: RewakeFeature) => place.features.has(f);
  const rows: [string, string][] = [
    [c, "at a usage limit: continue after the reset"],
    [`${c} 3:30pm`, "continue after the usage limit at that time"],
    ...(has("messages")
      ? ([[`${c} in 1h Run the tests`, "send a message later (9pm, tomorrow 9:00, in 90m)"]] as [
          string,
          string,
        ][])
      : []),
    ...(has("repeat")
      ? ([
          [`${c} every weekday 9:00 <message>`, "repeat: every hour|day|weekday|week|monday…"],
          [`${c} cron "0 9 * * 1-5" <message>`, "repeat on a cron expression"],
        ] as [string, string][])
      : []),
    [`${c} list`, "what's scheduled here"],
    [`${c} cancel`, "cancel the continue after the usage limit"],
    ...(has("cancelOne")
      ? ([[`${c} cancel N | all`, "delete scheduled message N, or all of them"]] as [
          string,
          string,
        ][])
      : []),
    ...(has("auto")
      ? ([[`${c} auto on|off`, "continue after usage limits without asking, or ask each time"]] as [
          string,
          string,
        ][])
      : []),
    ...(has("items")
      ? ([
          [`${c} now|pause|resume N`, "send now, pause or resume message N"],
          [`${c} move N <when> · edit N <text>`, "change its time or text"],
        ] as [string, string][])
      : []),
    ...(has("prompt")
      ? ([[`${c} prompt <text>`, "change the resume message"]] as [string, string][])
      : []),
    ...(has("page")
      ? ([[`${c} page`, "an overview of every scheduled message"]] as [string, string][])
      : []),
    ...(has("stop")
      ? ([[`${c} stop`, "stop a scheduled reply that is running"]] as [string, string][])
      : []),
  ];
  const width = Math.max(...rows.map(([l]) => l.length));
  return [
    `Rewake in ${place.name}:`,
    "",
    ...rows.map(([l, r]) => `${l.padEnd(width)}   ${r}`),
    "",
    "Times: 9:00, 9pm, tomorrow 9:00, in 90m, in 3h, 2026-10-06 09:00 (your local time).",
  ].join("\n");
}

/** What a place that can only continue after a limit (Gemini CLI, Codex) does with `/rewake …`. */
export type ContinueOnly =
  | { kind: "continue"; at?: number }
  | { kind: "cancel" }
  | { kind: "list" }
  | { kind: "reply"; text: string };

/**
 * `/rewake …` in a place whose only feature is continuing after a usage limit: continue (at the
 * reset, or at a time), cancel, list, help, and one line for everything else.
 */
export function continueOnly(place: RewakePlace, args: string, now: number): ContinueOnly {
  const c = parseRewake(args);
  const tryTime = `Try ${place.typed} 3:30pm.`;
  const timed = (when: string): ContinueOnly => {
    let r: { at: number; text: string };
    try {
      r = splitWhen(when, now);
    } catch {
      return { kind: "reply", text: `Rewake: Didn't understand "${when}". ${tryTime}` };
    }
    if (r.text) return { kind: "reply", text: notHere(place, "messages") };
    return { kind: "continue", at: r.at };
  };
  switch (c.kind) {
    case "home":
      return { kind: "continue" };
    case "continue":
      return c.when ? timed(c.when) : { kind: "continue" };
    case "at":
      return timed(c.args);
    case "cancel":
      return c.which === undefined
        ? { kind: "cancel" }
        : { kind: "reply", text: notHere(place, "cancelOne") };
    case "list":
      return { kind: "list" };
    case "help":
      return { kind: "reply", text: rewakeHelp(place) };
    default: {
      const f = featureOf(c);
      return { kind: "reply", text: f ? notHere(place, f) : rewakeHelp(place) };
    }
  }
}
