import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import type { ClosedDeps } from "../src/hosts/closed.js";
import {
  billingReset,
  classifyGrokFailure,
  grokHooks,
  grokSessionOpen,
  isGrok,
  resultSession,
  resumeGrok,
} from "../src/hosts/grok/host.js";
import { grokHooksFile, grokHooksJson, runGrokInstall } from "../src/hosts/grok/install.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js";
import { SessionRecords } from "../src/hosts/sessions.js";

const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const SID = "01993c7e-5a4b-7c2d-9e8f-0a1b2c3d4e5f";
const END = new Date(2026, 9, 9, 9, 0).toISOString();
const FAKE_GROK = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));

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

  it("passes on the weekly reset when a resume run hits the limit again", async () => {
    const end = new Date(Date.now() + 2 * 24 * 3_600_000).toISOString();
    writeFileSync(
      join(grok, "logs", "unified.jsonl"),
      `${JSON.stringify({ ts: "x", msg: "billing: fetched credits config", ctx: { config: { creditUsagePercent: 100, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end } } } })}\n`,
    );
    const program = join(dir, "grok.mjs");
    writeFileSync(
      program,
      'process.stderr.write("You have reached your weekly limit.\\n");\nprocess.exit(1);\n',
    );
    const r = {
      schemaVersion: 1 as const,
      host: "grok",
      sessionId: SID,
      cwd: dir,
      open: false,
      program,
      updatedAt: NOW,
    };
    expect(await resumeGrok(r, "Continue.", { ...process.env, GROK_HOME: grok })).toEqual({
      ok: false,
      reason: "limited",
      resetsAt: Date.parse(end),
    });
  });

  it("gives the message in a 0600 file, never on the command line, and deletes it", async () => {
    const log = join(dir, "grok.log");
    const r = {
      schemaVersion: 1 as const,
      host: "grok",
      sessionId: SID,
      cwd: dir,
      open: false,
      program: FAKE_GROK,
      updatedAt: NOW,
    };
    const secret = "Continue: the passphrase is correct-horse-battery-staple.";
    expect(
      await resumeGrok(r, secret, { ...process.env, GROK_HOME: grok, FAKE_GROK_LOG: log }),
    ).toEqual({ ok: true });
    const call = JSON.parse(readFileSync(log, "utf8").trim()) as {
      args: string[];
      prompt: string;
      mode: number;
      file: string;
    };
    // Grok Build has no stdin prompt, so the message goes in a file only this user can read...
    expect(call.prompt).toBe(secret);
    if (process.platform !== "win32") expect(call.mode).toBe(0o600);
    // ...its path is in the argv, its contents never are...
    expect(call.args).not.toContain("-p");
    expect(call.args.join("\u0000")).not.toContain("correct-horse");
    // ...and nothing is left behind once the run is over.
    expect(existsSync(call.file)).toBe(false);
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
  it("counts the free usage limit as the StopFailure hook gives it, the API's own error", () => {
    // Grok 1.0.46's hook input: the API error with xAI's code, not the sentence Grok prints.
    const raw = "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: …";
    expect(
      classifyGrokFailure(
        { error: "rate_limit", errorDetails: raw, lastAssistantMessage: `Turn failed: ${raw}` },
        { full: false },
      ),
    ).toEqual({ kind: "other", billing: false });
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

  describe("/rewake typed into the session", () => {
    const type = async (h: ReturnType<typeof harness>, prompt: string) =>
      JSON.parse((await h.event("UserPromptSubmit", { prompt })) ?? "{}") as {
        decision?: string;
        reason?: string;
      };

    it("says there's nothing to continue before any limit", async () => {
      const h = harness();
      const r = await type(h, "/rewake");
      expect(r.decision).toBe("block");
      expect(r.reason).toBe(
        "Rewake: this session isn't at a usage limit, so there's nothing to continue.",
      );
    });

    it("says it doesn't know the reset time yet when the limit gave none", async () => {
      const h = harness();
      await h.event("StopFailure", {
        error: "rate_limit",
        lastAssistantMessage: "You’ve reached your free Grok Build usage limit.",
      });
      const r = await type(h, "/rewake");
      expect(r.reason).toBe("Rewake doesn't know when this resets yet. Try /rewake 3:30pm.");
    });

    it("arms a continue at the known reset, and the slash is optional", async () => {
      billing(100);
      const h = harness();
      await h.event("StopFailure", {
        error: "invalid_request",
        errorDetails: "402",
        lastAssistantMessage: "You hit your weekly limit.",
      });
      const r = await type(h, "rewake");
      expect(r.reason).toMatch(/^Rewake will continue this session .*, once it's closed\. /);
      expect(new ScheduleStore(state).list()[0]).toMatchObject({
        dueAt: Date.parse(END) + 60_000,
        status: "scheduled",
      });
    });

    it("arms a continue at a chosen time", async () => {
      const h = harness();
      await h.event("StopFailure", {
        error: "rate_limit",
        lastAssistantMessage: "You’ve reached your free Grok Build usage limit.",
      });
      const r = await type(h, "/rewake in 1h");
      expect(r.reason).toMatch(/^Rewake will continue this session /);
      expect(new ScheduleStore(state).list()[0]?.dueAt).toBe(NOW + 60 * 60_000);
    });

    it("refuses to continue a limit that waiting won't lift", async () => {
      const h = harness();
      await h.event("StopFailure", {
        error: "invalid_request",
        errorDetails: "402",
        lastAssistantMessage: "You've hit the credit limit for your plan.",
      });
      const r = await type(h, "/rewake");
      expect(r.reason).toBe(
        "Rewake can't continue after this limit: this limit is about credits or spending, which waiting doesn't fix.",
      );
    });

    it("lists what's planned, and says when nothing is", async () => {
      const h = harness();
      await h.event("StopFailure", {
        error: "rate_limit",
        lastAssistantMessage: "You’ve reached your free Grok Build usage limit.",
      });
      expect((await type(h, "/rewake list")).reason).toBe(
        "Rewake: Nothing is set to continue this session. At a usage limit, close it and type /rewake to continue after the reset.",
      );
      await type(h, "/rewake in 1h");
      const r = await type(h, "/rewake list");
      expect(r.reason).toMatch(/^Rewake will continue this session .* To cancel: \/rewake cancel$/);
    });

    it("cancels what's planned", async () => {
      const h = harness();
      await h.event("StopFailure", {
        error: "rate_limit",
        lastAssistantMessage: "You’ve reached your free Grok Build usage limit.",
      });
      await type(h, "/rewake in 1h");
      const cancelled = await type(h, "/rewake cancel");
      expect(cancelled.reason).toBe(
        "Rewake: Cancelled. This session won't be continued on its own.",
      );
      const again = await type(h, "/rewake cancel");
      expect(again.reason).toBe("Rewake: Nothing is set to continue this session.");
    });

    it("doesn't match ordinary text, so it falls through to the usual typed-in-session handling", async () => {
      const h = harness();
      const out = await h.event("UserPromptSubmit", { prompt: "please rewrite this function" });
      expect(out).toBeUndefined();
    });
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
