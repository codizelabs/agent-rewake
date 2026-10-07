import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { type Schedule, ScheduleStore } from "../src/core/store.js";
import { ThreadStore } from "../src/core/threads.js";
import { codexAdapter } from "../src/hosts/codex/adapter.js";
import { codexProgram, type Usage } from "../src/hosts/codex/cli.js";
import { codexHooks } from "../src/hosts/codex/hooks.js";
import { MIN_CODEX, pickCodex, runCodexInstall } from "../src/hosts/codex/install.js";
import {
  hooksJson,
  installPlugin,
  marketplaceDir,
  pluginInstalled,
  uninstallPlugin,
  writeMarketplace,
} from "../src/hosts/codex/plugin.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js"; // registers the "codex" host
import { fire } from "../src/timers/fire.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const NOW = Date.parse("2026-10-07T12:00:00Z");
const THREAD = "0199a7f2-1b2c-7d3e-8f40-142dd9b73ad5";
const sec = (ms: number) => Math.floor(ms / 1000);
const ev = (payload: Record<string, unknown>) => JSON.stringify({ type: "event_msg", payload });
const RESETS = NOW + 2 * 3_600_000;
const LIMIT_LINES = [
  ev({ type: "task_started", turn_id: "t1" }),
  ev({
    type: "token_count",
    rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: sec(RESETS) } },
  }),
  ev({
    type: "task_complete",
    turn_id: "t1",
    error: { codex_error_info: "usage_limit_exceeded", message: "You've hit your usage limit." },
    completed_at: sec(NOW - 60_000),
  }),
];

let dir: string;
let state: string;
let rollout: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-codex-"));
  state = join(dir, "state");
  log = join(dir, "codex.log");
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
  writeFileSync(rollout, `${LIMIT_LINES.join("\n")}\n`);
  chmodSync(FAKE, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function hooks(noTimer = false) {
  const armed: [string, number][] = [];
  const disarmed: string[] = [];
  const notes: string[] = [];
  const handler = codexHooks({
    arm: (id, at) => {
      armed.push([id, at]);
      return !noTimer;
    },
    disarm: (id) => disarmed.push(id),
    notify: (_t, body) => notes.push(body),
    codexPath: () => FAKE,
  });
  const run = (event: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) =>
    runHook(
      handler,
      event,
      JSON.stringify({
        session_id: THREAD,
        transcript_path: rollout,
        cwd: "/work/shop",
        hook_event_name: event,
        ...input,
      }),
      env,
      state,
      NOW,
    );
  return { run, armed, disarmed, notes };
}
const blocked = (reply: string | undefined) =>
  JSON.parse(reply ?? "{}") as { decision?: string; reason?: string };
const resumes = () => new ScheduleStore(state).list();

describe("Codex hooks: typing rewake", () => {
  it("arms a resume for when the limit resets, and blocks the prompt so it never reaches the model", async () => {
    const h = hooks();
    const r = blocked(await h.run("UserPromptSubmit", { prompt: "rewake" }));
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(
      /^Rewake will continue this thread (at|on) .+\. Keep this computer on and awake until then\. If Codex is closed at that time, the thread continues when you next open it\. To cancel, send any other message in the thread\.$/,
    );
    const [s] = resumes();
    expect(s).toMatchObject({
      host: "codex",
      kind: "limit_resume",
      sessionId: THREAD,
      dueAt: RESETS + 60_000,
      sessionRef: { threadId: THREAD, transcript: rollout, codex: FAKE },
    });
    expect(h.armed).toEqual([[s?.scheduleId, RESETS + 60_000]]);
  });

  it("takes a time the person gives", async () => {
    const h = hooks();
    blocked(await h.run("UserPromptSubmit", { prompt: "Rewake 11pm" }));
    expect(new Date(resumes()[0]?.dueAt ?? 0).getHours()).toBe(23);
  });

  it("speaks the shared grammar: list, cancel, help, and one line for what Codex can't do", async () => {
    const h = hooks();
    const say = async (prompt: string) =>
      blocked(await h.run("UserPromptSubmit", { prompt })).reason ?? "";
    expect(await say("rewake list")).toBe(
      'Rewake: Nothing is set to continue this thread. At a usage limit, type "rewake" to continue after the reset.',
    );
    await say("rewake");
    expect(await say("rewake list")).toMatch(
      /^Rewake will continue this thread (at|on) .+\. To cancel: rewake cancel$/,
    );
    expect(await say("rewake cancel")).toBe(
      "Rewake: Cancelled. This thread won't be continued on its own.",
    );
    expect(resumes()[0]?.status).toBe("cancelled");
    expect(h.disarmed).toHaveLength(1);
    expect(await say("rewake cancel")).toBe("Rewake: Nothing is set to continue this thread.");
    expect(await say("rewake in 1h Run the tests")).toBe(
      "Rewake can't schedule messages in Codex. Type rewake help to see what it can do.",
    );
    expect(await say("rewake help")).toMatch(/^Rewake in Codex:\n\nrewake /);
    expect(await say("rewake whenever")).toBe(
      'Rewake: Didn\'t understand "whenever". Try rewake 3:30pm.',
    );
    // Accepted with a slash too, should a Codex surface pass it on.
    expect(await say("/rewake 11pm")).toMatch(/^Rewake will continue this thread/);
  });

  it("explains instead when there's no limit, it's billing, or no reset time is known", async () => {
    writeFileSync(rollout, `${LIMIT_LINES[0]}\n`);
    expect(blocked(await hooks().run("UserPromptSubmit", { prompt: "rewake" })).reason).toBe(
      "Rewake: this thread isn't at a usage limit, so there's nothing to continue.",
    );
    writeFileSync(
      rollout,
      [
        ev({
          type: "token_count",
          rate_limits: { rate_limit_reached_type: "workspace_owner_credits_depleted" },
        }),
        LIMIT_LINES[2],
      ].join("\n"),
    );
    expect(blocked(await hooks().run("UserPromptSubmit", { prompt: "rewake" })).reason).toContain(
      "credits or spending",
    );
    writeFileSync(rollout, `${LIMIT_LINES[2]}\n`);
    expect(blocked(await hooks().run("UserPromptSubmit", { prompt: "rewake" })).reason).toBe(
      'Rewake doesn\'t know when this limit resets. Type "rewake" with a time, for example "rewake 3:30pm".',
    );
    expect(resumes()).toEqual([]);
  });

  it("cancels the resume when the person types anything else, and lets that prompt through", async () => {
    const h = hooks();
    await h.run("UserPromptSubmit", { prompt: "rewake" });
    expect(
      await h.run("UserPromptSubmit", { prompt: "never mind, do this instead" }),
    ).toBeUndefined();
    expect(resumes()[0]?.status).toBe("cancelled");
    expect(h.disarmed).toHaveLength(1);
  });
});

describe("Codex hooks: when a session ends at a limit", () => {
  it("tells the person how to continue (the default)", async () => {
    const h = hooks();
    await h.run("SessionEnd", { reason: "other" });
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toMatch(
      /^Codex in the "shop" folder hit its usage limit\. Resume the thread in Codex and type "rewake", and Rewake continues it (at|on) .+, after the limit resets\.$/,
    );
    expect(resumes()).toEqual([]);
  });

  it("asks for a time in the notification when the reset time isn't known", async () => {
    writeFileSync(rollout, `${LIMIT_LINES[2]}\n`);
    const h = hooks();
    await h.run("SessionEnd", {});
    expect(h.notes).toEqual([
      'Codex in the "shop" folder hit its usage limit. Resume the thread in Codex and type "rewake" with a time, for example "rewake 3:30pm".',
    ]);
  });

  it("arms without asking when automatic resume is on and the reset is within a day", async () => {
    saveSettings(state, { ...DEFAULT_SETTINGS, newThreads: "on" });
    const h = hooks();
    await h.run("SessionEnd", { reason: "other" });
    expect(h.notes).toEqual([expect.stringMatching(/: Rewake will continue this thread (at|on) /)]);
    expect(resumes()[0]?.dueAt).toBe(RESETS + 60_000);
  });

  it("says so, and keeps nothing planned, when no timer can be set", async () => {
    const h = hooks(true);
    const r = blocked(await h.run("UserPromptSubmit", { prompt: "rewake" }));
    expect(r.reason).toMatch(/^Rewake couldn't set a timer on this computer/);
    expect(resumes()[0]?.status).toBe("cancelled");
  });

  it("does nothing when automatic resume is off, or a resume is already set", async () => {
    saveSettings(state, { ...DEFAULT_SETTINGS, newThreads: "off" });
    const h = hooks();
    await h.run("SessionEnd", {});
    expect(h.notes).toEqual([]);
    saveSettings(state, DEFAULT_SETTINGS);
    await h.run("UserPromptSubmit", { prompt: "rewake" });
    await h.run("SessionEnd", {});
    expect(h.notes).toEqual([]);
    expect(resumes()).toHaveLength(1);
  });
});

describe("Codex hooks: standing down", () => {
  it("does nothing in sessions Rewake's Zed add-on runs, by marker or by record", async () => {
    const h = hooks();
    expect(
      await h.run("UserPromptSubmit", { prompt: "rewake" }, { AGENT_REWAKE_OWNER: "acp" }),
    ).toBeUndefined();
    new ThreadStore(state).update(THREAD, "/work/shop", { autoResume: false }, NOW);
    expect(await h.run("UserPromptSubmit", { prompt: "rewake" })).toBeUndefined();
    expect(resumes()).toEqual([]);
  });

  it("ignores events from other agents (Grok also runs other agents' hooks)", async () => {
    const h = hooks();
    expect(
      await runHook(
        codexHooks({ arm: () => {}, disarm: () => {}, notify: () => {}, codexPath: () => FAKE }),
        "UserPromptSubmit",
        JSON.stringify({
          sessionId: "x",
          transcriptPath: "/h/.grok/sessions/x.jsonl",
          prompt: "rewake",
        }),
        {},
        state,
        NOW,
      ),
    ).toBeUndefined();
    expect(h.armed).toEqual([]);
  });
});

describe("Codex at fire time", () => {
  async function armed(): Promise<Schedule> {
    await hooks().run("UserPromptSubmit", { prompt: "rewake" });
    return resumes().find((r) => r.status === "scheduled") as Schedule;
  }
  const deps = (env: NodeJS.ProcessEnv) => ({
    stateDir: state,
    now: () => RESETS + 61_000,
    hosts: new Map([
      [
        "codex",
        codexAdapter({
          env: { ...process.env, FAKE_CODEX_LOG: log, ...env },
          node: process.execPath,
        }),
      ],
    ]),
    notify: () => true,
  });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { args: string[]; thread?: string; message?: string })
      : [];

  it("waits for the recorded reset when Codex can't say whether usage is back", async () => {
    const s = await armed();
    // A time the person chose before the reset.
    new ScheduleStore(state).put({ ...s, dueAt: RESETS - 3_600_000 });
    const early = {
      ...deps({ FAKE_CODEX_USAGE: "unknown" }),
      now: () => RESETS - 3_600_000 + 1000,
    };
    expect(await fire(s.scheduleId, early)).toBe("waiting");
    expect(calls().filter((c) => c.args[0] === "queue")).toHaveLength(0);
    expect(new ScheduleStore(state).get(s.scheduleId)?.dueAt).toBeGreaterThanOrEqual(RESETS);
  });

  it("checks usage, then queues the message into the same thread, once", async () => {
    const s = await armed();
    expect(await fire(s.scheduleId, deps({}))).toBe("sent");
    const queued = calls().filter((c) => c.args[0] === "queue");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ thread: THREAD, message: s.text });
    expect(calls().some((c) => c.args[0] === "app-server")).toBe(true);
    // Never a flag that widens permissions or skips hook trust.
    for (const c of calls())
      expect(c.args.join(" ")).not.toMatch(/dangerously|(^| )-s( |$)|(^| )-a( |$)/);
    expect(await fire(s.scheduleId, deps({}))).toBe("gone");
    expect(calls().filter((c) => c.args[0] === "queue")).toHaveLength(1);
  });

  it("waits when Codex says it's still limited", async () => {
    const s = await armed();
    const later = RESETS + 3_600_000;
    expect(
      await fire(
        s.scheduleId,
        deps({ FAKE_CODEX_USAGE: "limited", FAKE_CODEX_RESETS_AT: String(sec(later)) }),
      ),
    ).toBe("waiting");
    expect(new ScheduleStore(state).get(s.scheduleId)?.dueAt).toBe(later + 60_000);
    expect(calls().filter((c) => c.args[0] === "queue")).toEqual([]);
  });

  it("skips when the person carried on in the thread", async () => {
    const s = await armed();
    writeFileSync(
      rollout,
      `${[...LIMIT_LINES, ev({ type: "task_started", turn_id: "t2" })].join("\n")}\n`,
    );
    expect(await fire(s.scheduleId, deps({}))).toBe("skipped");
    expect(calls().filter((c) => c.args[0] === "queue")).toEqual([]);
  });

  it("after a later limit, asking again continues at the reset Codex reported", async () => {
    const s = await armed();
    const later = RESETS + 2 * 86_400_000;
    expect(
      await fire(
        s.scheduleId,
        deps({ FAKE_CODEX_USAGE: "limited", FAKE_CODEX_RESETS_AT: String(sec(later)) }),
      ),
    ).toBe("notified");
    const h = hooks();
    const reply = blocked(await h.run("UserPromptSubmit", { prompt: "rewake" })).reason ?? "";
    const again = resumes().find((r) => r.status === "scheduled");
    expect(again?.dueAt).toBe(later + 60_000);
    expect(reply).toMatch(/^Rewake will continue this thread (at|on) /);
  });

  it("queues through Codex's daemon when one runs, and reports archived threads", async () => {
    const s = await armed();
    expect(await fire(s.scheduleId, deps({ FAKE_CODEX_QUEUE: "daemon" }))).toBe("sent");
    expect(
      calls()
        .filter((c) => c.args[0] === "queue")
        .map((c) => c.args.includes("--remote")),
    ).toEqual([false, true]);
    const t = await armed();
    expect(await fire(t.scheduleId, deps({ FAKE_CODEX_QUEUE: "archived" }))).toBe("failed");
    expect(new ScheduleStore(state).get(t.scheduleId)?.status).toBe("failed");
  });

  it("doesn't send when signed out of Codex", async () => {
    const s = await armed();
    expect(await fire(s.scheduleId, deps({ FAKE_CODEX_USAGE: "signed-out" }))).toBe("failed");
    expect(calls().filter((c) => c.args[0] === "queue")).toEqual([]);
  });

  /** Fire deps whose usage check answers from `answers` in turn (then "allowed"), at the record's dueAt. */
  const answering = (answers: Usage[], notes: string[]) => ({
    ...deps({}),
    now: () => (resumes()[0] as Schedule).dueAt,
    hosts: new Map([
      [
        "codex",
        codexAdapter({
          env: { ...process.env, FAKE_CODEX_LOG: log },
          node: process.execPath,
          readUsage: async () => answers.shift() ?? { ok: true, allowed: true },
        }),
      ],
    ]),
    notify: (_title: string, body: string) => {
      notes.push(body);
      return true;
    },
  });

  it("checks again later when Codex's usage check doesn't answer (offline), then sends", async () => {
    const s = await armed();
    const d = answering(
      [
        { ok: false, reason: "timeout" },
        { ok: false, reason: "error" },
      ],
      [],
    );
    expect(await fire(s.scheduleId, d)).toBe("waiting");
    expect(await fire(s.scheduleId, d)).toBe("waiting");
    expect(calls().filter((c) => c.args[0] === "queue")).toEqual([]);
    expect(await fire(s.scheduleId, d)).toBe("sent");
    expect(calls().filter((c) => c.args[0] === "queue")).toHaveLength(1);
  });

  it("sends as before when this Codex has no usage check to ask", async () => {
    const s = await armed();
    const d = answering([{ ok: false, reason: "unsupported" }], []);
    expect(await fire(s.scheduleId, d)).toBe("sent");
    expect(calls().filter((c) => c.args[0] === "queue")).toHaveLength(1);
  });

  it("tells the person, without sending, when the usage check never answers", async () => {
    const s = await armed();
    const notes: string[] = [];
    const d = answering(
      Array.from({ length: 5 }, () => ({ ok: false, reason: "timeout" }) as const),
      notes,
    );
    for (let i = 0; i < 4; i++) expect(await fire(s.scheduleId, d)).toBe("waiting");
    expect(await fire(s.scheduleId, d)).toBe("failed");
    expect(calls().filter((c) => c.args[0] === "queue")).toEqual([]);
    expect(notes).toEqual([
      'Codex in the "shop" folder: Rewake couldn\'t continue the thread. Resume the thread in Codex to continue.',
    ]);
  });

  it("runs an npm install's codex script with Node, which a timer's PATH may not find", () => {
    expect(codexProgram(FAKE, "/opt/node")).toEqual({ command: "/opt/node", args: [FAKE] });
    expect(codexProgram("/usr/local/bin/codex-native", "/opt/node")).toEqual({
      command: "/usr/local/bin/codex-native",
      args: [],
    });
  });
});

describe("Codex plugin and install", () => {
  it("writes hooks whose command text has no version, so Codex's trust survives updates", () => {
    const text = hooksJson("/opt/node/bin/node", "/s/bin/agent-rewake.mjs");
    const hooks = JSON.parse(text).hooks as Record<
      string,
      { hooks: { command: string; timeout: number }[] }[]
    >;
    expect(Object.keys(hooks)).toEqual(["SessionStart", "UserPromptSubmit", "SessionEnd"]);
    expect(hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(
      '"/opt/node/bin/node" "/s/bin/agent-rewake.mjs" hook codex UserPromptSubmit',
    );
    expect(text).not.toMatch(/\d+\.\d+\.\d+/);
    const root = writeMarketplace(state, "/n", "/l.mjs");
    expect(root).toBe(marketplaceDir(state));
    expect(existsSync(join(root, ".agents", "plugins", "marketplace.json"))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(root, "plugins", "agent-rewake", ".codex-plugin", "plugin.json"), "utf8"),
      ).hooks,
    ).toBe("./hooks/hooks.json");
  });

  it("installs and removes with Codex's own commands", async () => {
    const env = { ...process.env, FAKE_CODEX_LOG: log };
    const codex = codexProgram(FAKE);
    expect(await installPlugin(codex, "/m", env)).toEqual({ ok: true });
    expect(await uninstallPlugin(codex, state, env)).toEqual({ ok: true });
    const args = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { args: string[] }).args.join(" "));
    expect(args).toEqual([
      "plugin marketplace add /m --json",
      "plugin add agent-rewake@agent-rewake --json",
      "plugin remove agent-rewake@agent-rewake",
      "plugin marketplace remove agent-rewake",
    ]);
    expect(await installPlugin(codex, "/m", { ...env, FAKE_CODEX_PLUGIN: "fail" })).toMatchObject({
      ok: false,
    });
    // The plugin can't be added after the marketplace was: the marketplace is removed again.
    rmSync(log);
    expect(
      await installPlugin(codex, "/m", { ...env, FAKE_CODEX_PLUGIN: "fail-add" }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { args: string[] }).args.join(" ")),
    ).toEqual([
      "plugin marketplace add /m --json",
      "plugin add agent-rewake@agent-rewake --json",
      "plugin marketplace remove agent-rewake",
    ]);
  });

  it("knows whether Codex lists the plugin, from Codex's own config", () => {
    const home = join(dir, "h");
    mkdirSync(join(home, ".codex"), { recursive: true });
    expect(pluginInstalled({}, home)).toBe(false);
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '[plugins."agent-rewake@agent-rewake"]\nenabled = true\n',
    );
    expect(pluginInstalled({}, home)).toBe(true);
  });

  it("picks the newest Codex CLI, else the ChatGPT app's copy", () => {
    const app = { path: "/A/codex", surface: "ChatGPT app", version: "0.170.0" };
    expect(
      pickCodex([
        app,
        { path: "/a", surface: "terminal", version: "0.150.0" },
        { path: "/b", surface: "terminal", version: "0.160.1" },
      ])?.path,
    ).toBe("/b");
    expect(pickCodex([app])?.path).toBe("/A/codex");
  });

  async function install(o: Partial<Parameters<typeof runCodexInstall>[0]> = {}) {
    let output = "";
    const installed: string[] = [];
    const code = await runCodexInstall({
      uninstall: false,
      yes: true,
      dryRun: false,
      env: { HOME: join(dir, "h"), FAKE_CODEX_LOG: log },
      stateDir: state,
      node: process.execPath,
      bundle: join(dir, "missing.js"),
      interactive: false,
      out: (t) => {
        output += t;
      },
      ask: async () => true,
      programs: [{ path: FAKE, surface: "terminal", version: "0.160.1" }],
      install: async (_c, d) => {
        installed.push(d);
        return { ok: true };
      },
      ...o,
    });
    return { code, output, installed };
  }

  it("says what it will run, asks, installs, and names the one thing to do next", async () => {
    const r = await install();
    expect(r.code).toBe(0);
    expect(r.installed).toEqual([marketplaceDir(state)]);
    expect(r.output).toContain(
      "Agent Rewake (preview) will add its plugin to Codex 0.160.1, with Codex's own commands:",
    );
    expect(r.output).toContain("choose Review hooks and trust the Agent Rewake hooks");
    expect(r.output).not.toContain("Trust all");
  });

  it("changes nothing on a dry run, a no, or without a terminal", async () => {
    expect((await install({ dryRun: true })).installed).toEqual([]);
    expect(
      (await install({ yes: false, interactive: true, ask: async () => false })).installed,
    ).toEqual([]);
    const r = await install({ yes: false, interactive: false });
    expect(r.code).toBe(1);
    expect(r.installed).toEqual([]);
  });

  it("says so when Codex doesn't list Rewake's hooks (an organisation's policy)", async () => {
    const blocked = await install({ list: async () => [] });
    expect(blocked.code).toBe(1);
    expect(blocked.output).toContain("doesn't list Rewake's hooks, so it won't run them");
    const listed = await install({
      list: async () => [
        { command: `"x" "${join(state, "bin", "agent-rewake.mjs")}" hook codex Stop` },
      ],
    });
    expect(listed.code).toBe(0);
    // Codex didn't answer: nothing to conclude, install stands.
    expect((await install({ list: async () => undefined })).code).toBe(0);
  });

  it("refuses a Codex that's too old or missing, with the fix", async () => {
    const old = await install({
      programs: [{ path: FAKE, surface: "terminal", version: "0.140.0" }],
    });
    expect(old.code).toBe(1);
    expect(old.output).toContain(`needs ${MIN_CODEX} or newer`);
    expect(old.installed).toEqual([]);
    expect((await install({ programs: [] })).output).toContain("Codex wasn't found");
  });

  it("installs a Codex newer than the one tested, and says so", async () => {
    const newer = await install({
      programs: [{ path: FAKE, surface: "terminal", version: "0.170.0" }],
    });
    expect(newer.code).toBe(0);
    expect(newer.output).toContain(
      "Codex 0.170.0 is newer than the versions Rewake was tested with (up to 0.160.1).",
    );
    const tested = await install({
      programs: [{ path: FAKE, surface: "terminal", version: "0.160.1" }],
    });
    expect(tested.output).not.toContain("newer than the versions Rewake was tested with");
  });
});
