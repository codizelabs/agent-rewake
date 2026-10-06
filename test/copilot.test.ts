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
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import { type ClosedDeps, closedAdapter, FIRE_ENV } from "../src/hosts/closed.js";
import { copilotHooks, copilotHost } from "../src/hosts/copilot/host.js";
import {
  copilotHooksJson,
  hooksFile,
  MIN_COPILOT,
  runCopilotInstall,
} from "../src/hosts/copilot/install.js";
import { classifyCopilotError, parseCopilotReset } from "../src/hosts/copilot/recognise.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js"; // registers the hosts
import { SessionRecords } from "../src/hosts/sessions.js";
import { fire } from "../src/timers/fire.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-copilot.mjs", import.meta.url));
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const SID = "8a3c1f2e-0b5d-4c7a-9e21-3f6b8d0c4a17";
const WEEKLY =
  "You've reached your weekly rate limit. Please wait for your limit to reset on October 7, 2026 at 3:00 PM or switch to auto model to continue.";

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
    expect(classifyCopilotError(WEEKLY, NOW)).toEqual({
      kind: "weekly",
      billing: false,
      resetsAt: new Date(2026, 9, 7, 15, 0).getTime(),
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
    expect(classifyCopilotError("You've hit your rate limit.", NOW)).toEqual({
      kind: "other",
      billing: false,
    });
    expect(classifyCopilotError("Connection reset by peer", NOW)).toBeUndefined();
    expect(parseCopilotReset("reset on Smarch 1, 2026 at 1:00 AM", NOW)).toBeUndefined();
  });
});

function harness(settings = DEFAULT_SETTINGS) {
  saveSettings(state, settings);
  const armed: [string, number][] = [];
  const notes: string[] = [];
  const deps = (env: NodeJS.ProcessEnv = {}, now = NOW): ClosedDeps => ({
    stateDir: state,
    now,
    env,
    arm: (id, at) => armed.push([id, at]),
    disarm: () => {},
    notify: (_t, b) => notes.push(b),
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
  return { armed, notes, deps, event };
}

describe("Copilot's hooks", () => {
  it("records the session and its limit, and at the end says how to continue (the default)", async () => {
    const h = harness();
    await h.event("sessionStart", { source: "startup" });
    await h.event("userPromptSubmitted", { prompt: "fix the build" });
    await h.event("errorOccurred", {
      error: { message: WEEKLY, name: "Error" },
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
        /^GitHub Copilot CLI in shop hit its usage limit\. Run "agent-rewake continue" to continue it at (3:01 PM|15:01) today, after the limit resets\.$/,
      ),
    ]);
    expect(h.armed).toEqual([]);
  });

  it("arms at the end when automatic resume is on and the reset is within a day", async () => {
    const h = harness({ ...DEFAULT_SETTINGS, newThreads: "on" });
    await h.event("errorOccurred", { error: { message: WEEKLY } });
    await h.event("sessionEnd", { reason: "error" });
    expect(h.armed.map(([, at]) => at)).toEqual([new Date(2026, 9, 7, 15, 1).getTime()]);
    expect(h.notes).toEqual([
      expect.stringMatching(
        /^Rewake will continue GitHub Copilot CLI in shop at (3:01 PM|15:01) today\. Keep this computer on and awake until then\./,
      ),
    ]);
  });

  it("never offers a billing limit, or one the person answered by typing", async () => {
    const h = harness();
    await h.event("errorOccurred", { error: { message: "You've run out of your AI credits" } });
    await h.event("sessionEnd", { reason: "error" });
    await h.event("errorOccurred", { error: { message: WEEKLY } }, {}, NOW + 1000);
    await h.event("userPromptSubmitted", { prompt: "go on" }, {}, NOW + 2000);
    await h.event("sessionEnd", { reason: "complete" }, {}, NOW + 3000);
    expect(h.notes).toEqual([]);
  });

  it("stands down for Zed's sessions and for other agents' events", async () => {
    const h = harness();
    await h.event("errorOccurred", { error: { message: WEEKLY } }, { AGENT_REWAKE_OWNER: "acp" });
    await h.event("errorOccurred", { error: { message: WEEKLY }, hookEventName: "StopFailure" });
    await h.event(
      "errorOccurred",
      { error: { message: WEEKLY } },
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

describe("agent-rewake continue", () => {
  async function limited(h: ReturnType<typeof harness>) {
    await h.event("sessionStart", { source: "startup" });
    await h.event("errorOccurred", { error: { message: WEEKLY } });
    await h.event("sessionEnd", { reason: "error" });
  }
  const run = async (h: ReturnType<typeof harness>, answers: string[], interactive = true) => {
    let output = "";
    const code = await runContinue({
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

  it("names the one session waiting and arms it on yes", async () => {
    const h = harness();
    await limited(h);
    const r = await run(h, []);
    expect(r.code).toBe(0);
    expect(r.output).toContain("agent-rewake continue --always");
    expect(r.output).toMatch(
      /^Rewake will continue GitHub Copilot CLI in shop at (3:01 PM|15:01) today\. Keep this computer on and awake until then\./,
    );
    expect(h.armed).toHaveLength(1);
    expect(new ScheduleStore(state).list()[0]).toMatchObject({
      host: "copilot-cli",
      sessionId: SID,
    });
    expect(waiting({ hosts: [copilotHost], deps: h.deps() })).toEqual([]);
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
    expect(output).toMatch(/^Cancelled: GitHub Copilot CLI in shop at /);
    expect(new ScheduleStore(state).list()[0]?.status).toBe("cancelled");
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
    await h.event("errorOccurred", { error: { message: WEEKLY } });
    await h.event("sessionEnd", { reason: "error" });
    expect(h.armed).toHaveLength(1);
    expect(await mode("ask")).toMatch(/^Rewake will ask again/);
  });

  it("offers preset times when the limit didn't say", async () => {
    const h = harness();
    await h.event("errorOccurred", { error: { message: "You've hit your rate limit." } });
    await h.event("sessionEnd", { reason: "error" });
    const r = await run(h, ["2"]);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/1\. In 1 hour \(.+\)\n {2}2\. In 3 hours/);
    expect(h.armed.map(([, at]) => at)).toEqual([NOW + 3 * H]);
  });

  it("takes another time, and asks again when it can't read one", async () => {
    const h = harness();
    await h.event("errorOccurred", { error: { message: "You've hit your rate limit." } });
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
    await h.event("errorOccurred", { error: { message: WEEKLY } });
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
          .map((l) => JSON.parse(l) as { args: string[]; cwd: string; fire: string })
      : [];

  it("resumes the same closed session headless, in its folder, with no permission flags", async () => {
    const id = await armed();
    expect(await fire(id, deps({}))).toBe("sent");
    expect(calls()).toEqual([
      {
        args: [
          `--resume=${SID}`,
          "-p",
          expect.any(String),
          "--no-ask-user",
          "--output-format",
          "json",
          "--no-auto-update",
        ],
        cwd: work,
        fire: id,
      },
    ]);
    expect(calls()[0]?.args.join(" ")).not.toMatch(/--allow|--yolo/);
  });

  it("waits and tries later when the run hits the limit again", async () => {
    const id = await armed();
    expect(await fire(id, deps({ FAKE_COPILOT: "limited" }))).toBe("waiting");
    expect(new ScheduleStore(state).get(id)?.status).toBe("scheduled");
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
