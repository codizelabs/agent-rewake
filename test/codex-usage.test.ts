import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "../src/core/settings.js";
import { formatAt } from "../src/core/time.js";
import { codexHooks } from "../src/hosts/codex/hooks.js";
import { lastWindows } from "../src/hosts/codex/rollout.js";
import { runHook } from "../src/hosts/hook.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const THREAD = "0199a7f2-1b2c-7d3e-8f40-142dd9b73ad5";
const MIN = 60_000;
const resetText = () => formatAt(NOW + 120 * MIN, NOW);
const sec = (ms: number) => Math.floor(ms / 1000);
const ev = (payload: Record<string, unknown>) => JSON.stringify({ type: "event_msg", payload });
const snapshot = (used: number, extra: Record<string, unknown> = {}) =>
  ev({
    type: "token_count",
    rate_limits: {
      primary: { used_percent: used, window_minutes: 300, resets_at: sec(NOW + 2 * 60 * MIN) },
      secondary: {
        used_percent: 10,
        window_minutes: 10080,
        resets_at: sec(NOW + 3 * 24 * 60 * MIN),
      },
      ...extra,
    },
  });

let dir: string;
let state: string;
let rollout: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-codex-usage-"));
  state = join(dir, "state");
  rollout = join(
    dir,
    ".codex",
    "sessions",
    "2026",
    "10",
    "07",
    `rollout-2026-10-07T11-58-00-${THREAD}.jsonl`,
  );
  mkdirSync(join(rollout, ".."), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const setRollout = (...lines: string[]) => writeFileSync(rollout, `${lines.join("\n")}\n`);
const handler = () =>
  codexHooks({ arm: () => true, disarm: () => {}, notify: () => {}, codexPath: () => undefined });
const prompt = (text: string, at = NOW) =>
  runHook(
    handler(),
    "UserPromptSubmit",
    JSON.stringify({
      session_id: THREAD,
      transcript_path: rollout,
      cwd: "/work/shop",
      hook_event_name: "UserPromptSubmit",
      prompt: text,
    }),
    {},
    state,
    at,
  );
const message = (reply: string | undefined) =>
  (JSON.parse(reply ?? "{}") as { systemMessage?: string }).systemMessage;

describe("Codex: warnings before a usage limit", () => {
  it("warns at 80% with a single JSON line that has only a systemMessage", async () => {
    setRollout(snapshot(82));
    const reply = await prompt("next task");
    expect(reply).toBeDefined();
    expect(reply).not.toContain("\n");
    const parsed = JSON.parse(reply ?? "");
    expect(Object.keys(parsed)).toEqual(["systemMessage"]);
    expect(parsed.systemMessage).toBe(
      `Rewake: 5-hour limit: 82% used, as of Codex's last reply. It resets ${resetText()}.`,
    );
  });

  it("writes the reset time in the person's clock, 24-hour or 12-hour", async () => {
    setRollout(snapshot(82));
    saveSettings(state, { ...loadSettings(state), clock: "24h" });
    expect(message(await prompt("a"))).toMatch(/It resets at \d\d:\d\d today\.$/);
    rmSync(join(state, "codex-usage.json"));
    saveSettings(state, { ...loadSettings(state), clock: "12h" });
    expect(message(await prompt("b"))).toMatch(/It resets at \d{1,2}:\d\d [AP]M today\.$/);
  });

  it("says it once, then again at 95%", async () => {
    setRollout(snapshot(82));
    expect(message(await prompt("a"))).toContain("82% used");
    expect(await prompt("b", NOW + MIN)).toBeUndefined();
    appendFileSync(rollout, `${snapshot(96)}\n`);
    expect(message(await prompt("c", NOW + 2 * MIN))).toContain("96% used");
    expect(await prompt("d", NOW + 3 * MIN)).toBeUndefined();
  });

  it("says nothing below 80%", async () => {
    setRollout(snapshot(79));
    expect(await prompt("a")).toBeUndefined();
  });

  it("says nothing when the setting is off", async () => {
    saveSettings(state, { ...loadSettings(state), usageWarnings: "off" });
    setRollout(snapshot(90));
    expect(await prompt("a")).toBeUndefined();
    expect(existsSync(join(state, "codex-usage.json"))).toBe(false);
  });

  it("says nothing for Rewake's own prompt", async () => {
    setRollout(snapshot(90));
    const reply = await prompt("rewake help");
    expect(message(reply)).toBeUndefined();
    expect(JSON.parse(reply ?? "{}").decision).toBe("block");
    expect(existsSync(join(state, "codex-usage.json"))).toBe(false);
  });

  it("warns about the weekly window too, and joins two warnings in one line", async () => {
    setRollout(
      ev({
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 85, window_minutes: 300, resets_at: sec(NOW + 60 * MIN) },
          secondary: { used_percent: 96, window_minutes: 10080, resets_at: sec(NOW + 86_400_000) },
        },
      }),
    );
    const text = message(await prompt("a")) ?? "";
    expect(text).toContain("5-hour limit: 85% used");
    expect(text).toContain("7-day limit: 96% used");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("warns about the pace from the figures of earlier prompts", async () => {
    // 1 point a minute: 10 minutes apart, from 50 to 60, the limit is 40 minutes away.
    const at = (m: number) => NOW + m * MIN;
    setRollout(snapshot(50));
    expect(await prompt("a", at(0))).toBeUndefined();
    appendFileSync(rollout, `${snapshot(60)}\n`);
    expect(message(await prompt("b", at(10)))).toBe(
      `Rewake: At this pace you reach the 5-hour limit in about 30 to 55 minutes, before it resets ${resetText()}.`,
    );
    appendFileSync(rollout, `${snapshot(61)}\n`);
    expect(await prompt("c", at(11))).toBeUndefined();
  });

  it("keeps its state private, per Codex home, and shared by every thread of the account", async () => {
    setRollout(snapshot(82));
    await prompt("a");
    const file = join(state, "codex-usage.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(stored)).toEqual([join(dir, ".codex")]);
    // Another thread of the same account: already said.
    const other = join(
      rollout,
      "..",
      `rollout-2026-10-07T11-59-00-${THREAD.replace("0199", "0188")}.jsonl`,
    );
    writeFileSync(other, `${snapshot(83)}\n`);
    const reply = await runHook(
      handler(),
      "UserPromptSubmit",
      JSON.stringify({ transcript_path: other, prompt: "x" }),
      {},
      state,
      NOW + MIN,
    );
    expect(reply).toBeUndefined();
  });

  it("ignores a rollout without rate limits, and a corrupt one", async () => {
    setRollout(ev({ type: "task_started", turn_id: "t1" }), ev({ type: "token_count", info: {} }));
    expect(await prompt("a")).toBeUndefined();
    setRollout(
      "{not json",
      '{"type":"event_msg","payload":{"type":"token_count","rate_limits":',
      "garbage",
    );
    expect(await prompt("b")).toBeUndefined();
    writeFileSync(rollout, Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
    expect(await prompt("c")).toBeUndefined();
  });

  it("survives a damaged state file and a state folder it can't write", async () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "codex-usage.json"), "{oops");
    setRollout(snapshot(90));
    expect(message(await prompt("a"))).toContain("90% used");
    rmSync(state, { recursive: true, force: true });
    writeFileSync(state, "a file where the folder should be");
    expect(await prompt("b")).toBeUndefined();
  });

  it("resets a state file that parses but has the wrong shape, instead of staying silent for ever", async () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "codex-usage.json"),
      JSON.stringify({ x: { five_hour: { samples: 1 } }, y: [1, 2], z: { five_hour: null } }),
    );
    setRollout(snapshot(90));
    expect(message(await prompt("a"))).toContain("90% used");
  });

  it("skips windows that already reset, and a full one: the limit flow takes over", async () => {
    setRollout(
      ev({
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 100, window_minutes: 300, resets_at: sec(NOW + 60 * MIN) },
          secondary: { used_percent: 90, window_minutes: 10080, resets_at: sec(NOW - 60 * MIN) },
        },
      }),
    );
    expect(await prompt("a")).toBeUndefined();
  });
});

describe("Codex: reading the windows from a rollout", () => {
  it("names the windows by length and takes Codex's own bucket", () => {
    const tail = [
      snapshot(40),
      ev({
        type: "token_count",
        rate_limits: {
          limit_id: "other",
          primary: { used_percent: 99, window_minutes: 300, resets_at: 1 },
        },
      }),
      ev({
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 41, window_minutes: 1440, resets_at: sec(NOW) },
          secondary: { used_percent: 5 },
        },
      }),
      ev({ type: "token_count", rate_limits: { limit_id: "codex", primary: null } }),
    ].join("\n");
    expect(lastWindows(tail)).toEqual([{ kind: "24_hour", percentUsed: 41, resetsAt: NOW }]);
    expect(lastWindows(snapshot(40)).map((w) => w.kind)).toEqual(["five_hour", "seven_day"]);
    expect(lastWindows("")).toEqual([]);
  });
});
