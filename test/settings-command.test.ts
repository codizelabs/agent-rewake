import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import {
  CLOCKS,
  DEFAULT_SETTINGS,
  KEEP_AWAKE_VALUES,
  loadSettings,
  MAX_RESUME_PROMPT,
  NEW_THREADS_VALUES,
  type Settings,
  saveSettings,
  validResumePrompt,
} from "../src/core/settings.js";
import { runSettings, SETTING_NAMES } from "../src/settings-command.js";

let dir: string;
let state: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-settings-"));
  state = join(dir, "state");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => join(state, "settings.json");
const raw = () => JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
const text = () => readFileSync(file(), "utf8");

/** Run `settings <args>` with captured output and scripted answers. */
async function settings(
  args: string[],
  o: { interactive?: boolean; wakeSupported?: boolean; answers?: string[] } = {},
) {
  let out = "";
  let err = "";
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  const code = await runSettings({
    stateDir: state,
    args,
    interactive: o.interactive ?? false,
    wakeSupported: o.wakeSupported ?? true,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
  });
  return { code, out, err, asked };
}

const seed = (s: Partial<Settings> = {}) => {
  const value: Settings = { ...DEFAULT_SETTINGS, ...s };
  saveSettings(state, value);
  return value;
};

const lines = (t: string) => t.split("\n").filter((l) => l.trim() !== "");

describe("setting values", () => {
  it("names the allowed values and checks a resume prompt", () => {
    expect([...CLOCKS]).toEqual(["12h", "24h"]);
    expect([...NEW_THREADS_VALUES]).toEqual(["ask", "on", "off"]);
    expect([...KEEP_AWAKE_VALUES]).toEqual(["plugged-in", "always", "never"]);
    expect(MAX_RESUME_PROMPT).toBe(16384);
    expect(validResumePrompt("Check the build")).toBe(true);
    expect(validResumePrompt("   ")).toBe(false);
    expect(validResumePrompt("")).toBe(false);
    expect(validResumePrompt("x".repeat(16384))).toBe(true);
    expect(validResumePrompt("x".repeat(16385))).toBe(false);
  });
});

describe("settings: listing", () => {
  it("lists every setting with its value and choices, asks nothing and writes nothing", async () => {
    const r = await settings([]);
    expect(r.code).toBe(0);
    expect([...SETTING_NAMES]).toEqual([
      "new-threads",
      "auto-when-prompts-skipped",
      "clock",
      "keep-awake",
      "resume-prompt",
    ]);
    // Each line leads with the setting's title and value, its name second.
    const all = lines(r.out);
    const lineOf = (name: string) => all.find((l) => l.endsWith(`(${name})`));
    expect(lineOf("new-threads")).toBe("Automatic resume: ask  (new-threads)");
    expect(lineOf("auto-when-prompts-skipped")).toContain(": on  (auto-when-prompts-skipped)");
    expect(lineOf("clock")).toBe(`Time format: ${DEFAULT_SETTINGS.clock}  (clock)`);
    expect(lineOf("keep-awake")).toContain(": plugged-in  (keep-awake)");
    expect(lineOf("resume-prompt")).toContain(`Resume message: Rewake's own ("Resume the work`);
    const last = all.at(-1) ?? "";
    expect(last).toContain("settings change");
    expect(last).toContain("settings <name> <value>");
    expect(r.asked).toEqual([]);
    expect(existsSync(file())).toBe(false);
  });

  it("only shows, even in a terminal: nothing is asked (V1)", async () => {
    const r = await settings([], { interactive: true, answers: ["3", "2"] });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
    expect(existsSync(file())).toBe(false);
  });

  it("shows the saved values, and the resume message's first words", async () => {
    seed({
      newThreads: "off",
      autoWhenPromptsSkipped: false,
      keepAwake: "never",
      resumePrompt: "Check the build",
    });
    const r = await settings([]);
    expect(r.out).toContain(": off  (new-threads)");
    expect(r.out).toContain(": off  (auto-when-prompts-skipped)");
    expect(r.out).toContain(": never  (keep-awake)");
    expect(r.out).toContain(`: "Check the build"  (resume-prompt)`);
  });

  it("leaves out keep-awake where Rewake can't keep the computer awake", async () => {
    const r = await settings([], { wakeSupported: false });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("keep-awake");
    expect(r.out).toContain("(clock)");
  });

  it("shows one setting, with every value and which is the default and current", async () => {
    seed({ newThreads: "on" });
    const r = await settings(["new-threads"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Automatic resume: on  (new-threads)");
    for (const v of NEW_THREADS_VALUES) expect(r.out).toContain(`${v}: `);
    expect(r.out).toMatch(/ask: .*\(default\)/);
    expect(r.out).toMatch(/on: .*\(current\)/);
    expect(r.out).not.toContain("(clock)");
    expect(r.out).not.toContain("(keep-awake)");
    expect(r.out).not.toContain("(auto-when-prompts-skipped)");
    const clock = await settings(["clock"]);
    for (const v of CLOCKS) expect(clock.out).toContain(`${v}: `);
    const awake = await settings(["keep-awake"]);
    for (const v of KEEP_AWAKE_VALUES) expect(awake.out).toContain(`${v}: `);
  });
});

describe("settings <name> <value>", () => {
  const SEEDED = {
    clock: "12h",
    newThreads: "on",
    autoWhenPromptsSkipped: true,
    keepAwake: "never",
    resumePrompt: "Go on",
    errorReports: "off",
  } as const;

  it.each([
    [["clock", "24h"], { clock: "24h" }],
    [["new-threads", "off"], { newThreads: "off" }],
    [["auto-when-prompts-skipped", "off"], { autoWhenPromptsSkipped: false }],
    [["keep-awake", "always"], { keepAwake: "always" }],
    [["resume-prompt", "Check", "the", "build"], { resumePrompt: "Check the build" }],
  ])("%j saves only that setting", async (args, change) => {
    seed(SEEDED);
    const r = await settings(args);
    expect(r.code).toBe(0);
    expect(r.out.startsWith("Saved.")).toBe(true);
    expect(raw()).toEqual({ ...SEEDED, ...change });
  });

  it("says when the value is already set", async () => {
    seed(SEEDED);
    const before = text();
    const r = await settings(["keep-awake", "never"]);
    expect(r.code).toBe(0);
    expect(r.out.startsWith("No change:")).toBe(true);
    expect(loadSettings(state)).toEqual(SEEDED);
    expect(JSON.parse(text())).toEqual(JSON.parse(before));
  });

  it.each([
    [["clock", "25h"], CLOCKS],
    [["new-threads", "maybe"], NEW_THREADS_VALUES],
    [
      ["auto-when-prompts-skipped", "yes"],
      ["on", "off"],
    ],
    [["keep-awake", "sometimes"], KEEP_AWAKE_VALUES],
  ])("%j is refused with the allowed values", async (args, allowed) => {
    seed(SEEDED);
    const before = text();
    const r = await settings(args);
    expect(r.code).toBe(2);
    expect(r.err.startsWith("agent-rewake: ")).toBe(true);
    for (const v of allowed) expect(r.err).toContain(v);
    expect(text()).toBe(before);
  });

  it("refuses an unknown setting and names the real ones", async () => {
    const r = await settings(["colour", "red"]);
    expect(r.code).toBe(2);
    expect(r.err.startsWith("agent-rewake: ")).toBe(true);
    for (const n of SETTING_NAMES) expect(r.err).toContain(n);
    expect(existsSync(file())).toBe(false);
  });

  it("refuses two words for a choice", async () => {
    seed(SEEDED);
    const before = text();
    const r = await settings(["clock", "24h", "extra"]);
    expect(r.code).toBe(2);
    expect(text()).toBe(before);
  });

  it("refuses an empty or too long resume prompt", async () => {
    seed(SEEDED);
    const before = text();
    expect((await settings(["resume-prompt", "   "])).code).toBe(2);
    expect(text()).toBe(before);
    expect((await settings(["resume-prompt", "x".repeat(16385)])).code).toBe(2);
    expect(text()).toBe(before);
    const fits = await settings(["resume-prompt", "x".repeat(16384)]);
    expect(fits.code).toBe(0);
    expect(loadSettings(state).resumePrompt).toHaveLength(16384);
  });

  it("can't keep a computer awake that Rewake can't keep awake", async () => {
    seed(SEEDED);
    const before = text();
    const r = await settings(["keep-awake", "always"], { wakeSupported: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("keep-awake");
    expect(r.err).toMatch(/^agent-rewake: Not saved\./);
    expect(text()).toBe(before);
  });
});

describe("settings --reset <name>", () => {
  it("puts a setting back to its default and keeps the others", async () => {
    const other = DEFAULT_SETTINGS.clock === "24h" ? "12h" : "24h";
    seed({ clock: other, newThreads: "off" });
    const r = await settings(["--reset", "clock"]);
    expect(r.code).toBe(0);
    expect(loadSettings(state).clock).toBe(DEFAULT_SETTINGS.clock);
    expect(loadSettings(state).newThreads).toBe("off");
  });

  it("removes a custom resume prompt", async () => {
    seed({ resumePrompt: "Go on" });
    const r = await settings(["--reset", "resume-prompt"]);
    expect(r.code).toBe(0);
    expect(raw()).not.toHaveProperty("resumePrompt");
  });

  it("needs a known setting's name", async () => {
    seed({ newThreads: "off" });
    const before = text();
    expect((await settings(["--reset"])).code).toBe(2);
    expect((await settings(["--reset", "nope"])).code).toBe(2);
    expect(text()).toBe(before);
  });
});

describe("settings change, in a terminal", () => {
  /** The numbered list's setting names, in order. */
  const numbered = (out: string) =>
    lines(out)
      .map((l) => l.trim().match(/^(\d+)\.\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [Number(m[1]), m[2] ?? ""] as const);

  it("numbers the settings, then their values, and saves the choice", async () => {
    seed({ clock: "12h" });
    const r = await settings(["change"], { interactive: true, answers: ["3", "2"] });
    expect(r.code).toBe(0);
    const list = numbered(r.out);
    SETTING_NAMES.forEach((name, i) => {
      const item = list.find(([n, rest]) => n === i + 1 && rest.endsWith(`(${name})`));
      expect(item, name).toBeDefined();
    });
    expect(r.out).toContain("1. 12h: 12-hour, like 3:19 PM (current)");
    expect(r.out).toContain("2. 24h: 24-hour, like 15:19 (default)");
    expect(r.asked).toHaveLength(2);
    expect(loadSettings(state).clock).toBe("24h");
    expect(lines(r.out).some((l) => l.trim().startsWith("Saved."))).toBe(true);
  });

  it("Enter before picking leaves without a word", async () => {
    seed({ clock: "12h" });
    const before = text();
    const r = await settings(["change"], { interactive: true, answers: [""] });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Nothing was changed.");
    expect(r.asked).toHaveLength(1);
    expect(text()).toBe(before);
  });

  it("backing out after picking a setting says nothing was changed", async () => {
    seed({ clock: "12h" });
    const before = text();
    const r = await settings(["change"], { interactive: true, answers: ["3", ""] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing was changed.");
    expect(text()).toBe(before);
  });

  it("changes nothing for a number that isn't in the list", async () => {
    seed({ clock: "12h" });
    const before = text();
    const r = await settings(["change"], { interactive: true, answers: ["9", "1", "1"] });
    expect(text()).toBe(before);
    expect(r.out).not.toMatch(/^Saved\./m);
  });

  it("needs a terminal", async () => {
    const r = await settings(["change"], { interactive: false });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^agent-rewake: /);
    expect(r.asked).toEqual([]);
  });

  it("takes a typed resume prompt, or goes back to Rewake's own", async () => {
    seed();
    const typed = await settings(["change"], {
      interactive: true,
      answers: ["5", "2", "Check the build"],
    });
    expect(typed.code).toBe(0);
    expect(typed.asked).toHaveLength(3);
    expect(loadSettings(state).resumePrompt).toBe("Check the build");
    const own = await settings(["change"], { interactive: true, answers: ["5", "1"] });
    expect(own.code).toBe(0);
    expect(raw()).not.toHaveProperty("resumePrompt");
  });

  it("leaves keep-awake out of the numbers where it isn't supported", async () => {
    seed();
    const r = await settings(["change"], {
      interactive: true,
      wakeSupported: false,
      answers: ["4", "2", "Keep going"],
    });
    expect(r.out).not.toContain("keep-awake");
    expect(numbered(r.out).find(([n]) => n === 4)?.[1]).toContain("resume-prompt");
    expect(loadSettings(state).resumePrompt).toBe("Keep going");
  });
});

describe("agent-rewake settings", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    mkdirSync(join(dir, "zed"));
    env = {
      AGENT_REWAKE_ZED_CONFIG_DIR: join(dir, "zed"),
      AGENT_REWAKE_ZED_DATA_DIR: join(dir, "data"),
      AGENT_REWAKE_STATE_DIR: state,
      HOME: dir,
      USERPROFILE: dir,
      PATH: process.env.PATH ?? "",
    };
    // Nothing here may touch the real home folder.
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    const code = await main(argv, env);
    vi.restoreAllMocks();
    return { code, out: out.join(""), err: err.join("") };
  }

  it("lists the settings", async () => {
    const r = await run(["settings"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(clock)");
  });

  it("saves a setting in the state folder", async () => {
    const r = await run(["settings", "clock", "12h"]);
    expect(r.code).toBe(0);
    expect(raw().clock).toBe("12h");
  });

  it("answers --help with its usage", async () => {
    const r = await run(["settings", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out.startsWith("Usage: agent-rewake settings")).toBe(true);
  });
});
