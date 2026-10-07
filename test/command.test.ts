import { describe, expect, it } from "vitest";
import { ACP_PLACE } from "../src/addon.js";
import {
  continueOnly,
  featureOf,
  notHere,
  parseRewake,
  type RewakeFeature,
  rewakeHelp,
  splitWhen,
} from "../src/core/command.js";
import { parseWhen } from "../src/core/time.js";
import { CLAUDE_CODE_PLACE } from "../src/hosts/claude-code/install.js";
import { CODEX_PLACE } from "../src/hosts/codex/hooks.js";
import { GEMINI_PLACE } from "../src/hosts/gemini/host.js";

/**
 * `/rewake`, Rewake's one command in every place it runs: its grammar, its help text, and the
 * Claude Code mod's copy of both (the mod runs without Rewake's code).
 */
interface Logic {
  parseCommand: (args: string) => unknown;
  parseWhen: (input: string, now: number) => unknown;
  splitWhen: (args: string, now: number) => unknown;
  helpText: () => string;
  notHere: (feature: string) => string;
  featureOf: (c: unknown) => string | undefined;
  FEATURES: Set<string>;
}
const path = "../src/hosts/claude-code/mod/hooks/logic.js";
const logic = (await import(path)) as Logic;

const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;

const TYPED = [
  "",
  "help",
  "list",
  "continue",
  "continue 3:30pm",
  "resume",
  "resume 2",
  "cancel",
  "cancel 2",
  "cancel all",
  "rm 3",
  "delete 1",
  "clear",
  "auto",
  "auto on",
  "auto OFF",
  "ask",
  "stop",
  "now 1",
  "pause 2",
  "move 1 tomorrow 9:00",
  "edit 1 New text",
  "prompt Continue the refactor",
  "page",
  "every weekday 9:00 Check the build",
  'cron "0 9 * * 1-5" Check the build',
  "in 1h Run the tests",
  "at 6pm Run the tests",
  "3:30pm",
  "tomorrow 9:00 Summarise the commits",
  "whenever",
];

describe("/rewake: the grammar every place shares", () => {
  it("reads each form", () => {
    expect(parseRewake("")).toEqual({ kind: "home" });
    expect(parseRewake("  list ")).toEqual({ kind: "list" });
    expect(parseRewake("continue")).toEqual({ kind: "continue" });
    expect(parseRewake("resume")).toEqual({ kind: "continue" });
    expect(parseRewake("continue 3pm")).toEqual({ kind: "continue", when: "3pm" });
    expect(parseRewake("cancel")).toEqual({ kind: "cancel" });
    expect(parseRewake("cancel 2")).toEqual({ kind: "cancel", which: "2" });
    expect(parseRewake("rm 2")).toEqual({ kind: "cancel", which: "2" });
    expect(parseRewake("clear")).toEqual({ kind: "cancel", which: "all" });
    expect(parseRewake("auto on")).toEqual({ kind: "auto", on: true });
    expect(parseRewake("ask")).toEqual({ kind: "auto", on: false });
    expect(parseRewake("resume 2")).toEqual({ kind: "item", action: "resume", n: "2", rest: "" });
    expect(parseRewake("move 1 9pm")).toEqual({
      kind: "item",
      action: "move",
      n: "1",
      rest: "9pm",
    });
    expect(parseRewake("every day 9:00 Hi")).toEqual({
      kind: "repeat",
      sub: "every",
      words: ["day", "9:00", "Hi"],
    });
    expect(parseRewake("in 1h Run the tests")).toEqual({ kind: "at", args: "in 1h Run the tests" });
  });

  it("splits a time from the message, with or without 'at', and allows a time alone", () => {
    expect(splitWhen("in 1h30m Run the tests", NOW)).toEqual({
      at: NOW + 1.5 * H,
      text: "Run the tests",
    });
    expect(splitWhen("at 6pm Stretch", NOW).text).toBe("Stretch");
    expect(new Date(splitWhen("at 6pm Stretch", NOW).at).getHours()).toBe(18);
    expect(splitWhen("tomorrow 9:00 Go", NOW).text).toBe("Go");
    expect(splitWhen("3:30pm", NOW).text).toBe("");
    expect(() => splitWhen("whenever", NOW)).toThrow(/isn't a time Rewake understands/);
  });

  it("says in one line what a place can't do, and lists only what it can", () => {
    expect(notHere(GEMINI_PLACE, "messages")).toBe(
      "Rewake can't schedule messages in Gemini CLI. Type /rewake help to see what it can do.",
    );
    expect(rewakeHelp(ACP_PLACE)).toContain("/rewake every weekday 9:00 <message>");
    expect(rewakeHelp(ACP_PLACE)).toContain("/rewake stop");
    expect(rewakeHelp(CLAUDE_CODE_PLACE)).toContain("/rewake auto on|off");
    expect(rewakeHelp(CLAUDE_CODE_PLACE)).not.toContain("every weekday");
    expect(rewakeHelp(CODEX_PLACE)).toMatch(/^Rewake in Codex:\n\nrewake {2,}/);
    expect(rewakeHelp(CODEX_PLACE)).not.toContain("/rewake");
    // Every place continues after a limit, cancels it and lists it.
    for (const place of [ACP_PLACE, CLAUDE_CODE_PLACE, GEMINI_PLACE, CODEX_PLACE]) {
      const help = rewakeHelp(place);
      for (const line of ["3:30pm", " list ", " cancel "]) expect(help).toContain(line);
    }
  });

  it("answers a place that only continues: continue, a time, cancel, list, and one line for the rest", () => {
    expect(continueOnly(GEMINI_PLACE, "", NOW)).toEqual({ kind: "continue" });
    expect(continueOnly(GEMINI_PLACE, "continue", NOW)).toEqual({ kind: "continue" });
    expect(continueOnly(GEMINI_PLACE, "in 2h", NOW)).toEqual({ kind: "continue", at: NOW + 2 * H });
    expect(continueOnly(GEMINI_PLACE, "continue in 2h", NOW)).toEqual({
      kind: "continue",
      at: NOW + 2 * H,
    });
    expect(continueOnly(CODEX_PLACE, "cancel", NOW)).toEqual({ kind: "cancel" });
    expect(continueOnly(CODEX_PLACE, "list", NOW)).toEqual({ kind: "list" });
    expect(continueOnly(CODEX_PLACE, "in 1h Run the tests", NOW)).toEqual({
      kind: "reply",
      text: "Rewake can't schedule messages in Codex. Type rewake help to see what it can do.",
    });
    expect(continueOnly(CODEX_PLACE, "stop", NOW)).toEqual({
      kind: "reply",
      text: notHere(CODEX_PLACE, "stop"),
    });
    expect(continueOnly(GEMINI_PLACE, "soon", NOW)).toEqual({
      kind: "reply",
      text: 'Rewake: Didn\'t understand "soon". Try /rewake 3:30pm.',
    });
  });
});

describe("/rewake: the Claude Code mod's copy matches", () => {
  it("parses every form the same way", () => {
    for (const typed of TYPED) expect(logic.parseCommand(typed), typed).toEqual(parseRewake(typed));
  });

  it("reads times the same way", () => {
    for (const when of [
      "in 90m",
      "in 1h30m",
      "in 2d",
      "in 0m",
      "9pm",
      "9:30pm",
      "21:05",
      "11:00",
      "13pm",
      "9",
      "tomorrow 9:00",
      "today 18:00",
      "tomorrow lunch",
      "2026-10-08 09:00",
      "2026-12-30 09:00",
      "2025-01-01 09:00",
      "soon",
      "",
    ])
      expect(logic.parseWhen(when, NOW), when).toEqual(parseWhen(when, NOW));
    for (const args of ["in 1h Run", "at 6pm Stretch", "3:30pm", "tomorrow 9:00 Go", "soon x"]) {
      const core = (() => {
        try {
          return { ok: true, ...splitWhen(args, NOW) };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      })();
      expect(logic.splitWhen(args, NOW), args).toEqual(core);
    }
  });

  it("has the same features, help text and one-line answers", () => {
    expect([...logic.FEATURES].sort()).toEqual([...CLAUDE_CODE_PLACE.features].sort());
    expect(logic.helpText()).toBe(rewakeHelp(CLAUDE_CODE_PLACE));
    const all: RewakeFeature[] = [
      "messages",
      "repeat",
      "cancelOne",
      "auto",
      "stop",
      "items",
      "prompt",
      "page",
    ];
    for (const f of all) expect(logic.notHere(f)).toBe(notHere(CLAUDE_CODE_PLACE, f));
    for (const typed of TYPED)
      expect(logic.featureOf(logic.parseCommand(typed)), typed).toBe(featureOf(parseRewake(typed)));
  });
});
