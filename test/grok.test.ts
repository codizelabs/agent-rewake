import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import type { ClosedDeps } from "../src/hosts/closed.js";
import {
  billingReset,
  classifyGrokFailure,
  grokHooks,
  grokSessionOpen,
  isGrok,
  resultSession,
} from "../src/hosts/grok/host.js";
import { grokHooksFile, grokHooksJson, runGrokInstall } from "../src/hosts/grok/install.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js";
import { SessionRecords } from "../src/hosts/sessions.js";

const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const SID = "01993c7e-5a4b-7c2d-9e8f-0a1b2c3d4e5f";
const END = new Date(2026, 9, 9, 9, 0).toISOString();

let dir: string;
let state: string;
let grok: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-grok-")));
  state = join(dir, "state");
  grok = join(dir, ".grok");
  mkdirSync(join(grok, "logs"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Grok's billing log line (research note §3.2.3), as `grok` writes it on every prompt. */
const billing = (percent: number, type = "USAGE_PERIOD_TYPE_WEEKLY") =>
  writeFileSync(
    join(grok, "logs", "unified.jsonl"),
    `${JSON.stringify({ ts: "x", lvl: "info", msg: "billing: fetched credits config", ctx: { config: { creditUsagePercent: percent, currentPeriod: { type, end: END } } } })}\n`,
  );

describe("Grok's limits", () => {
  it("reads the weekly reset from Grok's billing log line", () => {
    billing(100);
    expect(billingReset(grok, NOW)).toEqual({ seen: true, full: true, resetsAt: Date.parse(END) });
  });

  it("uses only a recent billing line, preferring this session's", () => {
    const line = (ts: unknown, sid: string, percent: number) =>
      JSON.stringify({
        ts,
        sid,
        msg: "billing: fetched credits config",
        ctx: {
          config: {
            creditUsagePercent: percent,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END },
          },
        },
      });
    const log = join(grok, "logs", "unified.jsonl");
    // Hours old: says nothing about the limit just hit.
    writeFileSync(log, `${line(new Date(NOW - 3 * 3_600_000).toISOString(), "s1", 100)}\n`);
    expect(billingReset(grok, NOW, "s1")).toEqual({ full: false });
    // Another session's newer line is a fallback only.
    writeFileSync(
      log,
      `${line(new Date(NOW - 60_000).toISOString(), "s1", 100)}\n${line(new Date(NOW - 1000).toISOString(), "s2", 40)}\n`,
    );
    expect(billingReset(grok, NOW, "s1")).toMatchObject({ full: true });
    expect(billingReset(grok, NOW, "s3")).toMatchObject({ full: false, seen: true });
  });

  it("reads the session a resume ran in from Grok's JSON result", () => {
    expect(resultSession('progress\n{"type":"result","sessionId":"abc"}\n')).toBe("abc");
    expect(resultSession("not json")).toBeUndefined();
  });

  it("counts a 402 as the weekly limit only when the text says so and the period is used up", () => {
    const weekly = {
      error: "invalid_request",
      errorDetails: "402 Payment Required",
      lastAssistantMessage: "You hit your weekly limit.",
    };
    expect(classifyGrokFailure(weekly, { full: true, resetsAt: 1 })).toEqual({
      kind: "weekly",
      billing: false,
      resetsAt: 1,
    });
    // A spending cap is billing: never resumed.
    expect(
      classifyGrokFailure(
        { ...weekly, lastAssistantMessage: "You've hit your spending cap." },
        { full: false },
      ),
    ).toEqual({ kind: "billing", billing: true });
    expect(classifyGrokFailure(weekly, { full: false, seen: true })).toEqual({
      kind: "billing",
      billing: true,
    });
    // No recent billing line to go on: a weekly limit with no known reset (the person picks a
    // time), not billing that's dropped without a word.
    expect(classifyGrokFailure(weekly, { full: false })).toEqual({
      kind: "weekly",
      billing: false,
    });
    // A rate limit with nothing else to go on is short-term (HTTP 429, 503, 529): Grok retries.
    expect(classifyGrokFailure({ error: "rate_limit" }, { full: false })).toBeUndefined();
    expect(classifyGrokFailure({ error: "server_error" }, { full: false })).toBeUndefined();
    expect(
      classifyGrokFailure(
        { error: "invalid_request", errorDetails: "bad tool call" },
        { full: false },
      ),
    ).toBeUndefined();
  });

  it("knows Grok's hook calls apart from other agents'", () => {
    expect(isGrok({ hookEventName: "stop_failure" }, {})).toBe(true);
    expect(isGrok({}, { GROK_HOOK_EVENT: "StopFailure" })).toBe(true);
    expect(isGrok({ session_id: "x", transcript_path: "/t" }, {})).toBe(false);
  });

  it("sees a session open in a Grok window by its live process", () => {
    writeFileSync(
      join(grok, "active_sessions.json"),
      JSON.stringify([{ session_id: SID, pid: process.pid }]),
    );
    expect(grokSessionOpen(grok, SID)).toBe(true);
    writeFileSync(
      join(grok, "active_sessions.json"),
      JSON.stringify([{ session_id: SID, pid: 999_999_999 }]),
    );
    expect(grokSessionOpen(grok, SID)).toBe(false);
  });
});

describe("Grok's own wording", () => {
  const rate = (lastAssistantMessage: string) => ({ error: "rate_limit", lastAssistantMessage });
  it("leaves its short-term limits and overloads to Grok", () => {
    for (const text of [
      "You’ve hit your team’s API rate limit. Ask a team admin to purchase more credits for higher limits, or try again later.",
      "You’ve hit the rate limit for your plan. Please wait and try again.",
      "Grok is temporarily overloaded (HTTP 529). Please try again.",
    ])
      expect(classifyGrokFailure(rate(text), { full: true, resetsAt: 9 })).toBeUndefined();
  });
  it("counts the free usage limit, with the weekly reset only when the pool is full", () => {
    const free = rate("You’ve reached your free Grok Build usage limit.");
    expect(classifyGrokFailure(free, { full: false, resetsAt: 9 })).toEqual({
      kind: "other",
      billing: false,
    });
    expect(classifyGrokFailure(free, { full: true, resetsAt: 9 })).toEqual({
      kind: "other",
      billing: false,
      resetsAt: 9,
    });
  });
  it("counts a 402 with a full weekly pool as the weekly limit, unless it names a cap", () => {
    const paid = { error: "invalid_request", errorDetails: "402 Payment Required" };
    expect(classifyGrokFailure(paid, { full: true, resetsAt: 9 })).toEqual({
      kind: "weekly",
      billing: false,
      resetsAt: 9,
    });
    expect(
      classifyGrokFailure(
        { ...paid, lastAssistantMessage: "You've hit the credit limit for your plan." },
        { full: true, resetsAt: 9 },
      ),
    ).toEqual({ kind: "billing", billing: true });
  });
});

describe("Grok's hooks", () => {
  function harness() {
    saveSettings(state, DEFAULT_SETTINGS);
    const notes: string[] = [];
    const deps = (env: NodeJS.ProcessEnv, now: number): ClosedDeps => ({
      stateDir: state,
      now,
      env,
      arm: () => {},
      disarm: () => {},
      notify: (_t, b) => notes.push(b),
    });
    const handler = grokHooks({
      closed: (ctx) => deps(ctx.env, ctx.now),
      program: () => "/bin/grok",
    });
    const env = { GROK_HOME: grok, GROK_HOOK_EVENT: "x" };
    const event = (name: string, input: Record<string, unknown>) =>
      runHook(
        handler,
        name,
        JSON.stringify({ hookEventName: name, sessionId: SID, cwd: join(dir, "api"), ...input }),
        env,
        state,
        NOW,
      );
    return { notes, event };
  }

  it("records a weekly limit with its reset and says how to continue when the session ends", async () => {
    billing(100);
    const h = harness();
    await h.event("SessionStart", { source: "startup" });
    await h.event("StopFailure", {
      error: "invalid_request",
      errorDetails: "402",
      lastAssistantMessage: "You hit your weekly limit.",
    });
    await h.event("SessionEnd", { reason: "other" });
    expect(new SessionRecords(state, "grok").get(SID)).toMatchObject({
      open: false,
      program: "/bin/grok",
      limit: { kind: "weekly", resetsAt: Date.parse(END) },
    });
    expect(h.notes).toEqual([
      expect.stringMatching(
        /^Grok Build in the "api" folder hit its usage limit\. Run "agent-rewake continue" to continue it on Friday at /,
      ),
    ]);
  });

  it("ignores a sub-agent's failures", async () => {
    const h = harness();
    await h.event("StopFailure", { error: "rate_limit", subagentType: "explore" });
    expect(new SessionRecords(state, "grok").get(SID)).toBeUndefined();
  });
});

describe("install --only grok", () => {
  it("writes one quoted hook per event, with the limit matcher on StopFailure", () => {
    const json = JSON.parse(grokHooksJson("/opt/my node/node", "/s/bin/agent-rewake.mjs"));
    expect(Object.keys(json.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "StopFailure",
      "SessionEnd",
    ]);
    expect(json.hooks.StopFailure[0].matcher).toBe("rate_limit|invalid_request");
    expect(json.hooks.StopFailure[0].hooks[0].command).toBe(
      '"/opt/my node/node" "/s/bin/agent-rewake.mjs" hook grok StopFailure',
    );
  });

  it("adds and removes its file", async () => {
    const env = { HOME: dir };
    const run = (uninstall: boolean) =>
      runGrokInstall({
        uninstall,
        yes: true,
        dryRun: false,
        env,
        stateDir: state,
        node: "/n",
        bundle: join(dir, "x.js"),
        interactive: false,
        out: () => {},
        ask: async () => true,
        programs: [{ path: "/g", surface: "terminal", version: "1.0.49" }],
      });
    expect(await run(false)).toBe(0);
    expect(existsSync(grokHooksFile(env, dir))).toBe(true);
    expect(await run(true)).toBe(0);
    expect(existsSync(grokHooksFile(env, dir))).toBe(false);
  });
});
