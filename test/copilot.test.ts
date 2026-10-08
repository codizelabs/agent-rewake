import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContinue, waiting } from "../src/continue.js";
import { copilotCode } from "../src/core/limits/agents.js";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import { DEFAULT_RESUME_PROMPT } from "../src/core/threads.js";
import {
  autoFor,
  type ClosedDeps,
  closedAdapter,
  FIRE_ENV,
  pendingFor,
  reapClosed,
  stillOpen,
} from "../src/hosts/closed.js";
import { copilotHooks, copilotHost, resumeCopilot } from "../src/hosts/copilot/host.js";
import {
  copilotHooksJson,
  hooksFile,
  MIN_COPILOT,
  runCopilotInstall,
} from "../src/hosts/copilot/install.js";
import { classifyCopilotError } from "../src/hosts/copilot/recognise.js";
import { runHook } from "../src/hosts/hook.js";
import type { SleepSettings } from "../src/util/sleep-settings.js";
import "../src/hosts/index.js"; // registers the hosts
import { SessionRecords } from "../src/hosts/sessions.js";
import { fire } from "../src/timers/fire.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-copilot.mjs", import.meta.url));
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const SID = "8a3c1f2e-0b5d-4c7a-9e21-3f6b8d0c4a17";
const WEEKLY =
  "You've reached your weekly rate limit. Please wait for your limit to reset on October 8, 2026 at 3:00 PM or switch to auto model to continue.";
/** Resets at 15:00 today in any time zone, for the hook tests. */
const WEEKLY_IN =
  "You've reached your weekly rate limit. Please wait for your limit to reset in 3 hours or switch to auto model to continue.";

let dir: string;
let state: string;
let work: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-copilot-")));
  state = join(dir, "state");
  work = join(dir, "shop");
  mkdirSync(work);
  chmodSync(FAKE, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Copilot's limit texts", () => {
  it("reads the reset from the text, and knows billing when it sees it", () => {
    // Copilot prints a reset date in UTC without saying so.
    expect(classifyCopilotError(WEEKLY, NOW)).toEqual({
      kind: "weekly",
      billing: false,
      resetsAt: Date.UTC(2026, 9, 8, 15, 0),
    });
    expect(
      classifyCopilotError("You've hit your session rate limit. Please try again in 2 hours.", NOW),
    ).toEqual({
      kind: "session",
      billing: false,
      resetsAt: NOW + 2 * H,
    });
    expect(classifyCopilotError("You've run out of your AI credits for the month.", NOW)).toEqual({
      kind: "billing",
      billing: true,
    });
    expect(classifyCopilotError("Connection reset by peer", NOW)).toBeUndefined();
    expect(
      classifyCopilotError(
        "You've reached your weekly rate limit. Please wait for your limit to reset on Smarch 1, 2026 at 1:00 AM.",
        NOW,
      ),
    ).toEqual({ kind: "weekly", billing: false });
  });

  it("reads Copilot 1.0.92's wording and leaves short-term limits to Copilot", () => {
    expect(
      classifyCopilotError(
        "You've hit your session rate limit. Please wait for your limit to reset in 2 hours. (Request ID: 1A2B:3C4D)",
        NOW,
      ),
    ).toEqual({ kind: "session", billing: false, resetsAt: NOW + 2 * H });
    expect(
      classifyCopilotError(
        "You've hit the rate limit for this model. Please wait for your limit to reset in under a minute.",
        NOW,
      ),
    ).toBeUndefined();
    expect(classifyCopilotError("You've hit your rate limit.", NOW)).toBeUndefined();
  });

  it("counts the monthly premium-request allowance as a usage limit", () => {
    expect(classifyCopilotError("402 Payment Required", NOW)).toEqual({
      kind: "other",
      billing: false,
    });
  });

  it("ignores an error Copilot recovered from", () => {
    expect(classifyCopilotError(WEEKLY, NOW, true)).toBeUndefined();
  });
});

function harness(
  settings = DEFAULT_SETTINGS,
  agent?: { pid: number; name: string },
  alive: () => boolean = () => true,
) {
  saveSettings(state, settings);
  const armed: [string, number][] = [];
  const disarmed: string[] = [];
  const notes: string[] = [];
  const deps = (env: NodeJS.ProcessEnv = {}, now = NOW): ClosedDeps => ({
    stateDir: state,
    now,
    env,
    arm: (id, at) => armed.push([id, at]),
    disarm: (id) => disarmed.push(id),
    notify: (_t, b) => notes.push(b),
    agent: () => agent,
    running: () => alive(),
  });
  const handler = copilotHooks({ closed: (ctx) => deps(ctx.env, ctx.now), program: () => FAKE });
  const event = (
    name: string,
    input: Record<string, unknown>,
    env: NodeJS.ProcessEnv = {},
    now = NOW,
  ) =>
    runHook(
      handler,
      name,
      JSON.stringify({ sessionId: SID, timestamp: now, cwd: work, ...input }),
      env,
      state,
      now,
    );
  return { armed, disarmed, notes, deps, event };
}

describe("Copilot's hooks", () => {
  it("records the session and its limit, and at the end says how to continue (the default)", async () => {
    const h = harness();
    await h.event("sessionStart", { source: "startup" });
    await h.event("userPromptSubmitted", { prompt: "fix the build" });
    await h.event("errorOccurred", {
      error: { message: WEEKLY_IN, name: "Error" },
      errorContext: "model_call",
      recoverable: false,
    });
    await h.event("sessionEnd", { reason: "error" });
    const r = new SessionRecords(state, "copilot-cli").get(SID);
    expect(r).toMatchObject({
      open: false,
      program: FAKE,
      cwd: work,
      limit: { kind: "weekly", billing: false },
    });
    expect(JSON.stringify(r)).not.toContain("fix the build");
    expect(h.notes).toEqual([
      expect.stringMatching(
        /^GitHub Copilot CLI in the "shop" folder hit its usage limit\. Run "agent-rewake continue" to continue it at (3:01 PM|15:01) today, after the limit resets\.$/,
      ),
    ]);
    expect(h.armed).toEqual([]);
  });

  it("arms at the end when automatic resume is on and the reset is within a day", async () => {
    const h = harness({ ...DEFAULT_SETTINGS, newThreads: "on" });
    await h.event("errorOccurred", { error: { message: WEEKLY_IN } });
    await h.event("sessionEnd", { reason: "error" });
    expect(h.armed.map(([, at]) => at)).toEqual([new Date(2026, 9, 7, 15, 1).getTime()]);
    expect(h.notes).toEqual([
      expect.stringMatching(
        /^Rewake will continue GitHub Copilot CLI in the "shop" folder at (3:01 PM|15:01) today\. Keep this computer on and awake until then\./,
      ),
    ]);
  });

  it("cancels an armed resume when the person types in the session again", async () => {
    const h = harness({ ...DEFAULT_SETTINGS, newThreads: "on" });
    await h.event("errorOccurred", { error: { message: WEEKLY_IN } });
    await h.event("sessionEnd", { reason: "error" });
    const [id] = h.armed[0] ?? [];
    expect(new ScheduleStore(state).get(id ?? "")?.status).toBe("scheduled");
    await h.event("sessionStart", { source: "resume" }, {}, NOW + 1000);
    await h.event("userPromptSubmitted", { prompt: "go on" }, {}, NOW + 2000);
    expect(new ScheduleStore(state).get(id ?? "")?.status).toBe("cancelled");
    expect(h.disarmed).toEqual([id]);
  });

  it("never offers a billing limit, or one the person answered by typing", async () => {
    const h = harness();
    await h.event("errorOccurred", { error: { message: "You've run out of your AI credits" } });
    await h.event("sessionEnd", { reason: "error" });
    await h.event("errorOccurred", { error: { message: WEEKLY_IN } }, {}, NOW + 1000);
    await h.event("userPromptSubmitted", { prompt: "go on" }, {}, NOW + 2000);
    await h.event("sessionEnd", { reason: "complete" }, {}, NOW + 3000);
    expect(h.notes).toEqual([]);
  });

  it("stands down for Zed's sessions and for other agents' events", async () => {
    const h = harness();
    await h.event(
      "errorOccurred",
      { error: { message: WEEKLY_IN } },
      { AGENT_REWAKE_OWNER: "acp" },
    );
    await h.event("errorOccurred", { error: { message: WEEKLY_IN }, hookEventName: "StopFailure" });
    await h.event(
      "errorOccurred",
      { error: { message: WEEKLY_IN } },
      { GROK_HOOK_EVENT: "StopFailure" },
    );
    expect(new SessionRecords(state, "copilot-cli").get(SID)).toBeUndefined();
  });

  it("doesn't take Rewake's own resume run for the person typing", async () => {
    const h = harness();
    await h.event("userPromptSubmitted", { prompt: "continue" }, { [FIRE_ENV]: "x" });
    expect(new SessionRecords(state, "copilot-cli").get(SID)?.lastPromptAt).toBeUndefined();
  });
});

describe("automatic resume outside Zed", () => {
  it("follows the new-threads setting; Zed's bypass exception doesn't apply", () => {
    expect(autoFor({ ...DEFAULT_SETTINGS, newThreads: "on", autoWhenPromptsSkipped: false })).toBe(
      "always",
    );
    expect(autoFor({ ...DEFAULT_SETTINGS, newThreads: "ask" })).toBe("ask");
    expect(autoFor({ ...DEFAULT_SETTINGS, newThreads: "off" })).toBe("never");
  });
});

describe("a session that ended without its session-end hook", () => {
  it("is open while its agent runs, and handled as closed once the agent is gone", async () => {
    let alive = true;
    const h = harness(DEFAULT_SETTINGS, { pid: 4242, name: "copilot" }, () => alive);
    await h.event("sessionStart", { source: "startup" });
    await h.event("errorOccurred", { error: { message: WEEKLY_IN } });
    const records = new SessionRecords(state, "copilot-cli");
    const r = records.get(SID);
    expect(r).toMatchObject({ open: true, agents: [{ pid: 4242, name: "copilot" }] });
    expect(stillOpen(r as NonNullable<typeof r>, () => alive)).toBe(true);
    expect(reapClosed([copilotHost], h.deps())).toBe(0);
    // The terminal was killed: no sessionEnd ran.
    alive = false;
    expect(reapClosed([copilotHost], h.deps())).toBe(1);
    expect(records.get(SID)?.open).toBe(false);
    expect(h.notes.at(-1)).toContain('Run "agent-rewake continue"');
    expect(waiting({ hosts: [copilotHost], deps: h.deps() })).toHaveLength(1);
  });

  it("doesn't take a session with no agent process recorded for closed", () => {
    const r = {
      schemaVersion: 1 as const,
      host: "copilot-cli",
      sessionId: SID,
      cwd: work,
      open: true,
      updatedAt: NOW,
    };
    expect(stillOpen(r, () => false)).toBe(true);
    // A record from an earlier version names one agent process.
    expect(stillOpen({ ...r, agentPid: 4242, agentName: "copilot" }, () => false)).toBe(false);
  });

  it("stays open while the same session runs in another terminal", async () => {
    const a = harness(DEFAULT_SETTINGS, { pid: 1001, name: "copilot" });
    const b = harness(DEFAULT_SETTINGS, { pid: 1002, name: "copilot" });
    await a.event("sessionStart", { source: "startup" });
    await b.event("sessionStart", { source: "resume" });
    await a.event("errorOccurred", { error: { message: WEEKLY_IN } });
    await b.event("sessionEnd", { reason: "user_exit" });
    const records = new SessionRecords(state, "copilot-cli");
    const r = records.get(SID);
    expect(r).toMatchObject({ open: true, agents: [{ pid: 1001, name: "copilot" }] });
    expect(stillOpen(r as NonNullable<typeof r>, () => true)).toBe(true);
    expect(b.notes).toEqual([]);
    // The last terminal closes: now the limit is offered.
    await a.event("sessionEnd", { reason: "user_exit" });
    expect(records.get(SID)?.open).toBe(false);
    expect(a.notes.at(-1)).toContain('Run "agent-rewake continue"');
  });

  it("lets a new limit through after a missed or needs-attention resume", async () => {
    const h = harness();
    const store = new ScheduleStore(state);
    for (const status of ["missed", "needs_attention", "scheduled"] as const) {
      const s = store.create({
        sessionId: SID,
        cwd: work,
        text: "Continue.",
        dueAt: NOW,
        kind: "limit_resume",
        createdBy: "auto",
        now: NOW,
      });
      store.put({ ...s, host: "copilot-cli", status });
    }
    expect(pendingFor(state, "copilot-cli", SID).map((s) => s.status)).toEqual(["scheduled"]);
    void h;
  });
});

describe("agent-rewake continue", () => {
  async function limited(h: ReturnType<typeof harness>) {
    await h.event("sessionStart", { source: "startup" });
    await h.event("errorOccurred", { error: { message: WEEKLY_IN } });
    await h.event("sessionEnd", { reason: "error" });
  }
  const run = async (
    h: ReturnType<typeof harness>,
    answers: string[],
    interactive = true,
    sleep?: SleepSettings,
  ) => {
    let output = "";
    const code = await runContinue({
      ...(sleep && { sleepSettings: () => sleep }),
      hosts: [copilotHost],
      deps: h.deps(),
      interactive,
      out: (t) => {
        output += t;
      },
      ask: async () => answers.shift() ?? "",
    });
    return { code, output };
  };

  it("says when this computer's own settings would let it sleep before the resume", async () => {
    const h = harness();
    await limited(h);
    const r = await run(h, [], true, { os: "windows", pluggedInSleepMin: 15 });
    expect(r.output).toContain(
      "This computer may sleep before then: it's set to sleep after 15 minutes when plugged in. To keep it awake: https://rewake.js.org/docs/#keep-your-computer-awake",
    );
    const fine = harness();
    await limited(fine);
    expect(
      (await run(fine, [], true, { os: "windows", pluggedInSleepMin: 0 })).output,
    ).not.toContain("may sleep");
  });

  it("names the one session waiting and arms it on yes", async () => {
    const h = harness();
    await limited(h);
    const r = await run(h, []);
    expect(r.code).toBe(0);
    expect(r.output).toContain("agent-rewake continue --always");
    expect(r.output).toMatch(
      /^Rewake will continue GitHub Copilot CLI in the "shop" folder at (3:01 PM|15:01) today\. Keep this computer on and awake until then\./,
    );
    expect(h.armed).toHaveLength(1);
    expect(new ScheduleStore(state).list()[0]).toMatchObject({
      host: "copilot-cli",
      sessionId: SID,
    });
    expect(waiting({ hosts: [copilotHost], deps: h.deps() })).toEqual([]);
  });

  it("doesn't list a session once its resume was sent; a failed one, or a later limit, comes back", async () => {
    const h = harness();
    await limited(h);
    await run(h, []);
    const store = new ScheduleStore(state);
    const id = store.list()[0]?.scheduleId as string;
    const listed = () => waiting({ hosts: [copilotHost], deps: h.deps(undefined, NOW + H) });
    store.update(id, (x) => ({ ...x, status: "sent" }), NOW + H / 12);
    expect(listed()).toEqual([]);
    store.update(
      id,
      (x) => ({ ...x, status: "failed", failureMessage: "No session matched." }),
      NOW + H / 12,
    );
    expect(listed()).toHaveLength(1);
    expect((await run(h, [], false)).output).toContain(
      `and GitHub Copilot CLI ended with: "No session matched."`,
    );
    store.update(id, (x) => ({ ...x, status: "sent" }), NOW + H / 12);
    // A new limit after the resume is a new one to continue.
    await h.event("sessionStart", { source: "resume" }, {}, NOW + H / 6);
    await h.event("errorOccurred", { error: { message: WEEKLY_IN } }, {}, NOW + H / 6);
    await h.event("sessionEnd", { reason: "error" }, {}, NOW + H / 6);
    expect(listed()).toHaveLength(1);
  });

  it("says when there's nothing to continue, and --cancel cancels a pending resume", async () => {
    const h = harness();
    expect((await run(h, [])).output).toBe(
      "Nothing to continue: no closed session is stopped at a usage limit.\n",
    );
    await limited(h);
    await run(h, []);
    let output = "";
    await runContinue({
      mode: "cancel",
      hosts: [copilotHost],
      deps: h.deps(),
      interactive: true,
      out: (t) => {
        output += t;
      },
      ask: async () => "",
    });
    expect(output).toMatch(/^Cancelled: GitHub Copilot CLI in the "shop" folder at /);
    expect(new ScheduleStore(state).list()[0]?.status).toBe("cancelled");
  });

  it("--cancel leaves a continue that is already being sent, and says so", async () => {
    const h = harness();
    await limited(h);
    await run(h, []);
    const store = new ScheduleStore(state);
    const id = store.list()[0]?.scheduleId ?? "";
    store.update(id, (x) => ({ ...x, status: "sending" }), NOW);
    let output = "";
    await runContinue({
      mode: "cancel",
      hosts: [copilotHost],
      deps: h.deps(),
      interactive: true,
      out: (t) => {
        output += t;
      },
      ask: async () => "",
    });
    expect(output).toBe(
      'Not cancelled: Rewake is already continuing GitHub Copilot CLI in the "shop" folder. It finishes on its own; resume the session with "copilot --resume" afterwards to see what it did.\n',
    );
    expect(store.get(id)?.status).toBe("sending");
  });

  it("--always turns automatic resume on, and --ask turns it off", async () => {
    const h = harness();
    const mode = async (m: "always" | "ask") => {
      let output = "";
      await runContinue({
        mode: m,
        hosts: [copilotHost],
        deps: h.deps(),
        interactive: true,
        out: (t) => {
          output += t;
        },
        ask: async () => "",
      });
      return output;
    };
    expect(await mode("always")).toMatch(
      /^From now on, when a session stops at a usage limit that resets within a day/,
    );
    await h.event("errorOccurred", { error: { message: WEEKLY_IN } });
    await h.event("sessionEnd", { reason: "error" });
    expect(h.armed).toHaveLength(1);
    expect(await mode("ask")).toMatch(/^Rewake will ask again/);
  });

  it("offers preset times when the limit didn't say", async () => {
    const h = harness();
    await h.event("errorOccurred", {
      error: { message: "You've reached your weekly rate limit." },
    });
    await h.event("sessionEnd", { reason: "error" });
    const r = await run(h, ["2"]);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/1\. In 1 hour \(.+\)\n {2}2\. In 3 hours/);
    expect(h.armed.map(([, at]) => at)).toEqual([NOW + 3 * H]);
  });

  it("takes another time, and asks again when it can't read one", async () => {
    const h = harness();
    await h.event("errorOccurred", {
      error: { message: "You've reached your weekly rate limit." },
    });
    await h.event("sessionEnd", { reason: "error" });
    const r = await run(h, ["4", "tomorow", "4pm"]);
    expect(r.code).toBe(0);
    expect(h.armed.map(([, at]) => at)).toEqual([new Date(2026, 9, 7, 16, 0).getTime()]);
  });
});

describe("Copilot at fire time", () => {
  async function armed() {
    const h = harness();
    await h.event("sessionStart", { source: "startup" });
    await h.event("errorOccurred", { error: { message: WEEKLY_IN } });
    await h.event("sessionEnd", { reason: "error" });
    await runContinue({
      hosts: [copilotHost],
      deps: h.deps(),
      interactive: true,
      out: () => {},
      ask: async () => "",
    });
    return new ScheduleStore(state).list()[0]?.scheduleId ?? "";
  }
  const log = () => join(dir, "copilot.log");
  const deps = (env: NodeJS.ProcessEnv, now = new Date(2026, 9, 7, 15, 2).getTime()) => ({
    stateDir: state,
    now: () => now,
    hosts: new Map([
      [
        "copilot-cli",
        closedAdapter(copilotHost, state, { ...process.env, FAKE_COPILOT_LOG: log(), ...env }),
      ],
    ]),
    notify: () => true,
  });
  const calls = () =>
    existsSync(log())
      ? readFileSync(log(), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { args: string[]; cwd: string; stdin: string; fire: string })
      : [];

  it("resumes the same closed session headless, in its folder, with no permission flags", async () => {
    const id = await armed();
    expect(await fire(id, deps({}))).toBe("sent");
    expect(calls()).toEqual([
      {
        args: [`--resume=${SID}`, "--no-ask-user", "--output-format", "json", "--no-auto-update"],
        cwd: work,
        stdin: expect.any(String),
        fire: id,
      },
    ]);
    expect(calls()[0]?.args.join(" ")).not.toMatch(/--allow|--yolo/);
  });

  it("gives the message on stdin, never on the command line", async () => {
    const id = await armed();
    expect(await fire(id, deps({}))).toBe("sent");
    const call = calls()[0];
    // What was scheduled reached Copilot...
    expect(call?.stdin).toBe(DEFAULT_RESUME_PROMPT);
    // ...and no part of it is in the argv any other process can read from `ps`.
    expect(call?.args).not.toContain("-p");
    expect(call?.args.join("\u0000")).not.toContain(DEFAULT_RESUME_PROMPT.slice(0, 40));
    for (const arg of call?.args ?? []) expect(DEFAULT_RESUME_PROMPT).not.toContain(arg);
  });

  it("waits and tries later when the run hits the limit again", async () => {
    const id = await armed();
    expect(await fire(id, deps({ FAKE_COPILOT: "limited" }))).toBe("waiting");
    expect(new ScheduleStore(state).get(id)?.status).toBe("scheduled");
  });

  it("passes on the reset a limited run's message gives", async () => {
    const r = new SessionRecords(state, "copilot-cli").update(SID, work, NOW, (x) => ({
      ...x,
      program: FAKE,
    }));
    if (!r) throw new Error("no session record");
    const before = Date.now();
    const result = await resumeCopilot(r, "Continue.", {
      ...process.env,
      FAKE_COPILOT: "limited",
      FAKE_COPILOT_ERROR: WEEKLY_IN,
    });
    expect(result).toMatchObject({ ok: false, reason: "limited" });
    const at = (result as { resetsAt?: number }).resetsAt ?? 0;
    expect(at).toBeGreaterThanOrEqual(before + 3 * H);
    expect(at).toBeLessThanOrEqual(Date.now() + 3 * H);
  });

  it("reports a session Copilot no longer has as deleted, not a failure", async () => {
    const r = new SessionRecords(state, "copilot-cli").update(SID, work, NOW, (x) => ({
      ...x,
      program: FAKE,
    }));
    if (!r) throw new Error("no session record");
    expect(await resumeCopilot(r, "Continue.", { ...process.env, FAKE_COPILOT: "gone" })).toEqual({
      ok: false,
      reason: "closed",
      detail: "deleted",
    });
  });

  it("only notifies when the session is open again: never a second writer", async () => {
    const id = await armed();
    new SessionRecords(state, "copilot-cli").update(SID, work, NOW, (r) => ({ ...r, open: true }));
    expect(await fire(id, deps({}))).toBe("notified");
    expect(calls()).toEqual([]);
  });
});

describe("install --only copilot-cli", () => {
  it("writes one hooks file with exec and args, so no shell parses the paths", () => {
    const json = JSON.parse(copilotHooksJson("/opt/node", "/s/bin/agent-rewake.mjs"));
    expect(json.version).toBe(1);
    expect(Object.keys(json.hooks)).toEqual([
      "sessionStart",
      "sessionEnd",
      "userPromptSubmitted",
      "errorOccurred",
    ]);
    expect(json.hooks.errorOccurred[0]).toEqual({
      type: "command",
      exec: "/opt/node",
      args: ["/s/bin/agent-rewake.mjs", "hook", "copilot-cli", "errorOccurred"],
      timeoutSec: 5,
    });
  });

  async function install(o: Partial<Parameters<typeof runCopilotInstall>[0]> = {}) {
    let output = "";
    const env = { HOME: join(dir, "home") };
    const code = await runCopilotInstall({
      uninstall: false,
      yes: true,
      dryRun: false,
      env,
      stateDir: state,
      node: process.execPath,
      bundle: join(dir, "missing.js"),
      interactive: false,
      out: (t) => {
        output += t;
      },
      ask: async () => true,
      programs: [{ path: FAKE, surface: "terminal", version: "1.0.92" }],
      ...o,
    });
    return { code, output, file: hooksFile(env, join(dir, "home")) };
  }

  it("adds the file, and uninstall deletes it", async () => {
    const r = await install();
    expect(r.code).toBe(0);
    expect(existsSync(r.file)).toBe(true);
    expect(r.output).toContain("Next, start a new GitHub Copilot CLI session");
    const u = await install({ uninstall: true });
    expect(u.code).toBe(0);
    expect(existsSync(r.file)).toBe(false);
  });

  it("refuses a Copilot too old for the hook form it needs, or none at all", async () => {
    expect(
      (await install({ programs: [{ path: FAKE, surface: "terminal", version: "1.0.40" }] }))
        .output,
    ).toContain(`needs ${MIN_COPILOT} or newer`);
    expect((await install({ programs: [] })).output).toContain("wasn't found");
  });
});

describe("Copilot's coded errors (1.0.92, tested offline)", () => {
  it("reads the code in the hook's message, even when Copilot calls it recoverable", () => {
    const text = JSON.stringify({
      message: "Sorry, you've exceeded your weekly rate limit.",
      code: "user_weekly_rate_limited",
      type: "user_weekly_rate_limited",
    });
    expect(classifyCopilotError(text, NOW, true)).toEqual({ kind: "weekly", billing: false });
    expect(copilotCode(JSON.stringify({ code: "session_quota_exceeded" }))).toEqual({
      kind: "session",
      billing: false,
    });
    // The text inside a JSON body, and Copilot's own "Last error" wording, read as the weekly limit.
    expect(
      classifyCopilotError(
        JSON.stringify({ message: "Sorry, you've exceeded your weekly rate limit." }),
        NOW,
      ),
    ).toMatchObject({ billing: false });
    expect(
      classifyCopilotError("429 Sorry, you've exceeded your weekly rate limit.", NOW),
    ).toMatchObject({ billing: false });
    // An uncoded error Copilot recovers from stays Copilot's to handle.
    expect(classifyCopilotError("429 Too Many Requests", NOW, true)).toBeUndefined();
  });
});
