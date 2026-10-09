import {
  CLOCKS,
  DEFAULT_SETTINGS,
  KEEP_AWAKE_SAVED,
  KEEP_AWAKE_VALUES,
  loadSettings,
  MAX_RESUME_PROMPT,
  NEW_THREADS_VALUES,
  type Settings,
  saveSettings,
  validResumePrompt,
} from "./core/settings.js";
import { DEFAULT_RESUME_PROMPT } from "./core/threads.js";
import { clockTime } from "./core/time.js";
import { oneLine } from "./ui/overview.js";
import { rewake } from "./util/command.js";
import { printable } from "./util/printable.js";

/**
 * `agent-rewake settings`: Rewake's shared settings outside Zed. The same file, values and rules
 * as Zed's Rewake → Settings… form (src/core/settings.ts). `settings` shows them and stops;
 * `settings change` picks one by number in a terminal; `settings <name> <value>` changes one.
 */

/** The settings by the names people type: the settings file's own keys, kebab-cased. */
export const SETTING_NAMES = [
  "new-threads",
  "auto-when-prompts-skipped",
  "clock",
  "keep-awake",
  "resume-prompt",
] as const;
export type SettingName = (typeof SETTING_NAMES)[number];

export interface SettingsOptions {
  stateDir: string;
  /** The words after "settings". */
  args: string[];
  /** A terminal on both stdin and stdout: `settings change` can ask. */
  interactive: boolean;
  /** Rewake can keep this computer awake: keep-awake is offered only then. */
  wakeSupported: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Ask a question; resolves with the typed answer. */
  ask: (question: string) => Promise<string>;
}

interface Setting {
  name: SettingName;
  /** Its name for people, first on every line. */
  title: string;
  /** What it does, in one short line. */
  short: string;
  /** More, for the one setting's view and the picker. */
  more?: string;
  /** The values it takes, with what each means; none for the resume message (free text). */
  choices?: () => [string, string][];
  get(s: Settings): string;
  /** The settings with this one set (the value is valid). */
  set(s: Settings, value: string): Settings;
  /** What changed, said after "Saved.". */
  saved(value: string): string;
}

const SETTINGS: Setting[] = [
  {
    name: "new-threads",
    title: "Automatic resume",
    short: "Whether Rewake continues an agent by itself when its usage limit resets.",
    more: "It applies in new Zed threads and in the agents outside Zed that Rewake is set up in.",
    choices: () => [
      ["ask", "Ask first: in Zed when a new thread opens, outside Zed with a notification"],
      ["on", "Continue by itself, without asking, when the limit resets within a day"],
      ["off", "Never by itself, and don't ask about it"],
    ],
    get: (s) => s.newThreads,
    set: (s, v) => ({ ...s, newThreads: NEW_THREADS_VALUES.find((x) => x === v) ?? "ask" }),
    saved: (v) =>
      v === "on"
        ? "Automatic resume is on: Rewake continues agents by itself when a usage limit resets within a day."
        : v === "off"
          ? "Automatic resume is off, and Rewake won't ask about it."
          : "Rewake asks before continuing after a usage limit.",
  },
  {
    name: "auto-when-prompts-skipped",
    title: "Threads that skip permission prompts",
    short: "Whether automatic resume also covers Zed threads that skip permission prompts.",
    more: "Such as Claude's bypass permissions or Codex's full access. Outside Zed, Rewake runs agents with their usual approvals.",
    choices: () => [
      ["on", "Include them"],
      ["off", "Leave them out: at a limit, Rewake asks you instead"],
    ],
    get: (s) => (s.autoWhenPromptsSkipped ? "on" : "off"),
    set: (s, v) => ({ ...s, autoWhenPromptsSkipped: v === "on" }),
    saved: (v) =>
      `Automatic resume ${v === "on" ? "also covers" : "leaves out"} Zed threads that skip permission prompts.`,
  },
  {
    name: "clock",
    title: "Time format",
    short: "How Rewake shows times.",
    choices: () =>
      CLOCKS.map((c) => [
        c,
        `${c === "12h" ? "12-hour" : "24-hour"}, like ${clockTime(15, 19, c)}`,
      ]),
    get: (s) => s.clock,
    set: (s, v) => ({ ...s, clock: CLOCKS.find((x) => x === v) ?? s.clock }),
    saved: (v) => `Times now show like ${clockTime(15, 19, v === "24h" ? "24h" : "12h")}.`,
  },
  {
    name: "keep-awake",
    title: "Keep this computer awake",
    short: "Keeps this computer from sleeping while a resume or scheduled message is due.",
    more: "Closing the lid still puts it to sleep.",
    choices: () => [
      ["plugged-in", "While it's plugged in"],
      ["always", "Always, also on battery"],
      ["never", "Never"],
    ],
    get: (s) => s.keepAwake,
    set: (s, v) => ({ ...s, keepAwake: KEEP_AWAKE_VALUES.find((x) => x === v) ?? s.keepAwake }),
    saved: (v) => KEEP_AWAKE_SAVED[KEEP_AWAKE_VALUES.find((x) => x === v) ?? "plugged-in"],
  },
  {
    name: "resume-prompt",
    title: "Resume message",
    short: "What Rewake sends when it continues after a usage limit.",
    more: "To a closed agent session or a Codex thread, and in new Zed threads that automatic resume turns on.",
    get: (s) => s.resumePrompt ?? "",
    set: (s, v) => {
      const { resumePrompt: _old, ...rest } = s;
      return v && v !== DEFAULT_RESUME_PROMPT ? { ...rest, resumePrompt: v } : rest;
    },
    saved: (v) =>
      v && v !== DEFAULT_RESUME_PROMPT
        ? "Resumes send your message from now on."
        : "Resumes send Rewake's own message again.",
  },
];

/** "12h or 24h", "ask, on or off". */
const orList = (v: string[]) =>
  v.length < 2 ? (v[0] ?? "") : `${v.slice(0, -1).join(", ")} or ${v.at(-1)}`;

/** The value as people read it: the resume message's first words. */
function shown(setting: Setting, s: Settings): string {
  if (setting.name !== "resume-prompt") return setting.get(s);
  const text = setting.get(s);
  return text ? `"${oneLine(text, 50)}"` : `Rewake's own ("${oneLine(DEFAULT_RESUME_PROMPT, 40)}")`;
}

/** "Time format: 12h  (clock)". */
const line = (x: Setting, s: Settings) => `${x.title}: ${shown(x, s)}  (${x.name})`;

/** A value with what it means, and whether it's the default or the current one. */
function choiceText(x: Setting, [value, text]: [string, string], s: Settings): string {
  const tags = [
    ...(value === x.get(DEFAULT_SETTINGS) ? ["default"] : []),
    ...(value === x.get(s) ? ["current"] : []),
  ];
  return `${value}: ${text}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`;
}

/** Change one setting and say what changed. */
function change(o: SettingsOptions, x: Setting, value: string): number {
  const current = loadSettings(o.stateDir);
  const next = x.set(current, value);
  if (x.get(next) === x.get(current)) {
    o.out(`No change: ${x.name} is already ${x.name === "resume-prompt" ? "that" : value}.\n`);
    return 0;
  }
  saveSettings(o.stateDir, next);
  o.out(`Saved. ${x.saved(value)}\n`);
  return 0;
}

/** Why a value isn't taken, or undefined when it is. */
function problem(x: Setting, words: string[]): string | undefined {
  if (x.name === "resume-prompt") {
    const text = words.join(" ");
    if (text.length > MAX_RESUME_PROMPT)
      return `that message is too long: keep it under ${MAX_RESUME_PROMPT.toLocaleString("en-US")} characters.`;
    return validResumePrompt(text)
      ? undefined
      : `resume-prompt needs some text. To go back to Rewake's own message: ${rewake("settings --reset resume-prompt")}`;
  }
  const values = (x.choices?.() ?? []).map(([v]) => v);
  if (words.length > 1) return `${x.name} takes one value: ${orList(values)}.`;
  if (!values.includes(words[0] ?? ""))
    return `${x.name} takes ${orList(values)}, not "${printable(words[0] ?? "")}".`;
  return undefined;
}

export async function runSettings(o: SettingsOptions): Promise<number> {
  const offered = SETTINGS.filter((x) => x.name !== "keep-awake" || o.wakeSupported);
  const fail = (text: string, code = 2) => {
    o.err(`agent-rewake: ${text}\n`);
    return code;
  };
  const [first, ...rest] = o.args;
  const current = loadSettings(o.stateDir);
  // Don't offer what can't work here (keep-awake where Rewake can't keep the computer awake).
  const find = (name: string) => {
    if (name === "keep-awake" && !o.wakeSupported)
      return fail(
        "Not saved. Rewake can't keep this computer awake, so keep-awake does nothing here: its own power settings decide when it sleeps.",
        1,
      );
    return (
      SETTINGS.find((x) => x.name === name) ??
      fail(`no setting named "${printable(name)}". The settings: ${SETTING_NAMES.join(", ")}.`)
    );
  };

  if (first === undefined) {
    // A view: the settings, and how to change one. Nothing is asked.
    o.out(
      `${[
        "Agent Rewake settings, for Zed and every agent Rewake is set up in:",
        "",
        ...offered.flatMap((x) => [line(x, current), `  ${x.short}`]),
        "",
        `To change one: ${rewake("settings change")}, or ${rewake("settings <name> <value>")} (${rewake("settings <name>")} lists its values).`,
      ].join("\n")}\n`,
    );
    return 0;
  }
  if (first === "--reset") {
    if (rest.length !== 1)
      return fail(
        `usage: agent-rewake settings --reset <name>, with one of: ${SETTING_NAMES.join(", ")}.`,
      );
    const x = find(rest[0] ?? "");
    return typeof x === "number" ? x : change(o, x, x.get(DEFAULT_SETTINGS));
  }
  if (first === "change") return pickAndChange(o, offered, current, fail, rest.length > 0);
  if (first.startsWith("-"))
    return fail(
      `unknown option for settings: ${printable(first)}. Run ${rewake("settings --help")} for the options.`,
    );
  const x = find(first);
  if (typeof x === "number") return x;
  if (rest.length === 0) {
    // One setting: what it does, and every value it takes.
    o.out(
      `${[
        line(x, current),
        `  ${x.short}${x.more ? ` ${x.more}` : ""}`,
        ...(x.choices?.().map((c) => `    ${choiceText(x, c, current)}`) ?? [
          "    Your own message, or Rewake's own (default)",
        ]),
      ].join("\n")}\n`,
    );
    return 0;
  }
  const why = problem(x, rest);
  if (why) return fail(why);
  return change(o, x, x.name === "resume-prompt" ? rest.join(" ") : (rest[0] ?? ""));
}

/** `settings change`: pick a setting by number, then its value. Enter leaves it as it is. */
async function pickAndChange(
  o: SettingsOptions,
  offered: Setting[],
  current: Settings,
  fail: (text: string) => number,
  extra: boolean,
): Promise<number> {
  if (extra) return fail("usage: agent-rewake settings change");
  if (!o.interactive)
    return fail(
      `settings change needs a terminal. To change one: ${rewake("settings <name> <value>")}`,
    );
  /** The item whose number was typed; undefined for Enter or anything else. */
  const pick = async <T>(list: T[], question: string) =>
    list[Number((await o.ask(question)).trim()) - 1];
  o.out(`${offered.map((x, i) => `  ${i + 1}. ${line(x, current)}`).join("\n")}\n`);
  const x = await pick(offered, `Change which one? (1-${offered.length}, or Enter to leave) `);
  // Enter here leaves without a word: nothing was picked.
  if (!x) return 0;
  const leave = () => {
    o.out("Nothing was changed.\n");
    return 0;
  };
  o.out(`${x.title} (${x.name}): ${x.short}${x.more ? ` ${x.more}` : ""}\n`);
  if (x.name === "resume-prompt") {
    o.out(`Now ${shown(x, current)}.\n  1. Rewake's own message\n  2. Type your own…\n`);
    const how = (await o.ask("Choose 1-2 (Enter to keep it): ")).trim();
    if (how === "1") return change(o, x, "");
    if (how !== "2") return leave();
    const text = await o.ask("Your message (Enter to keep the current one): ");
    if (!text.trim()) return leave();
    const why = problem(x, [text]);
    if (why) {
      o.out(`Not saved: ${why}\n`);
      return 1;
    }
    return change(o, x, text);
  }
  const choices = x.choices?.() ?? [];
  o.out(`${choices.map((c, i) => `  ${i + 1}. ${choiceText(x, c, current)}`).join("\n")}\n`);
  const choice = await pick(
    choices,
    `Choose 1-${choices.length} (Enter to keep ${x.get(current)}): `,
  );
  return choice ? change(o, x, choice[0]) : leave();
}
