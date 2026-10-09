import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContinue } from "../src/continue.js";
import { classifyQwenFailure } from "../src/core/limits/agents.js";
import { recognise } from "../src/core/limits/recognise.js";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import { DEFAULT_RESUME_PROMPT } from "../src/core/threads.js";
import { type ClosedDeps, closedAdapter, FIRE_ENV } from "../src/hosts/closed.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js";
import { hooksTurnedOff } from "../src/hosts/policy.js";
import { installedPreviews } from "../src/hosts/previews.js";
import { qwenHooks, qwenHost, resumeQwen } from "../src/hosts/qwen/host.js";
import {
  ourGroup,
  planQwen,
  qwenHome,
  qwenInstalled,
  qwenSettingsFile,
  runQwenInstall,
} from "../src/hosts/qwen/install.js";
import { SessionRecords } from "../src/hosts/sessions.js";
import { fire } from "../src/timers/fire.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-qwen.mjs", import.meta.url));
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const SID = "123e4567-e89b-12d3-a456-426614174000";
/** The text Qwen Code gives when a token plan's quota is spent (quotaErrorDetection.ts:161-165). */
const WEEKLY =
  "429 Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC.";

let dir: string;
let state: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-qwen-")));
  state = join(dir, "state");
  chmodSync(FAKE, 0o755);
  saveSettings(state, DEFAULT_SETTINGS);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps =
  (notes: string[], armed: number[]) =>
  (env: NodeJS.ProcessEnv, now: number): ClosedDeps => ({
    stateDir: state,
    now,
    env,
    arm: (_id, at) => armed.push(at),
    disarm: () => {},
    notify: (_t, b) => notes.push(b),
  });

describe("Qwen Code's usage limits", () => {
  it("reads the token-plan quota text, with its reset as the next such time", () => {
    // 27 July has passed this year (it is 7 October 2026): the reset is next July.
    expect(classifyQwenFailure({ error: "rate_limit", errorDetails: WEEKLY }, NOW)).toEqual({
      kind: "weekly",
      billing: false,
      resetsAt: Date.UTC(2027, 6, 27, 9, 25),
    });
    // The reset can be days away, in this year.
    expect(
      classifyQwenFailure(
        {
          error: "rate_limit",
          errorDetails: WEEKLY.replace("07-27 09:25:00", "10-09 09:25:00"),
        },
        NOW,
      ),
    ).toEqual({ kind: "weekly", billing: false, resetsAt: Date.UTC(2026, 9, 9, 9, 25) });
  });

  it("takes a reset just passed as now, an older one as next year, and a date that doesn't exist as unknown", () => {
    const at = (when: string, noon = Date.UTC(2026, 9, 10, 12, 0)) =>
      classifyQwenFailure(
        { error: "rate_limit", errorDetails: WEEKLY.replace("07-27 09:25:00", when) },
        noon,
      )?.resetsAt;
    const noon = Date.UTC(2026, 9, 10, 12, 0);
    expect(at("10-10 11:55:00")).toBe(noon);
    expect(at("10-10 09:25:00")).toBe(Date.UTC(2027, 9, 10, 9, 25));
    expect(at("02-29 09:25:00")).toBeUndefined();
    expect(at("02-29 09:25:00", Date.UTC(2027, 11, 1))).toBe(Date.UTC(2028, 1, 29, 9, 25));
    expect(at("13-01 09:25:00")).toBeUndefined();
  });

  it("reads the message with Qwen's own prefix, and a quota that says no time", () => {
    expect(
      classifyQwenFailure(
        {
          error: "rate_limit",
          errorDetails: `Quota exhausted: ${WEEKLY.slice(4)}\n\nPlease retry after the reset time, or switch to another API key / auth method.`,
        },
        NOW,
      ),
    ).toMatchObject({ kind: "weekly", resetsAt: Date.UTC(2027, 6, 27, 9, 25) });
    const none = classifyQwenFailure(
      {
        error: "rate_limit",
        errorDetails:
          "Quota exhausted: hour allocated quota exceeded. Please retry after the reset time.",
      },
      NOW,
    );
    expect(none).toEqual({ kind: "other", billing: false });
  });

  it("never resumes after a billing error, and ignores other failures and plain throttles", () => {
    expect(classifyQwenFailure({ error: "billing_error", errorDetails: "402" }, NOW)).toEqual({
      kind: "billing",
      billing: true,
    });
    // Billing stays billing whatever the text says about a reset.
    expect(
      classifyQwenFailure({ error: "billing_error", errorDetails: WEEKLY }, NOW)?.billing,
    ).toBe(true);
    for (const error of ["server_error", "authentication_failed", "loop_detected", "unknown"])
      expect(classifyQwenFailure({ error, errorDetails: WEEKLY }, NOW)).toBeUndefined();
    // A 429 that is only a throttle: Qwen retries it itself.
    expect(
      classifyQwenFailure({ error: "rate_limit", errorDetails: "429 Rate limit exceeded." }, NOW),
    ).toBeUndefined();
    expect(classifyQwenFailure({ error: "rate_limit" }, NOW)).toBeUndefined();
  });

  it("is the verdict recognise() gives for a hook signal", () => {
    expect(
      recognise({ agent: "qwen", source: "hook", code: "rate_limit", text: WEEKLY }, NOW),
    ).toMatchObject({
      isUsageLimit: true,
      isBilling: false,
      window: "weekly",
      resetsAt: Date.UTC(2027, 6, 27, 9, 25),
      confidence: "text",
    });
    expect(
      recognise({ agent: "qwen", source: "hook", code: "billing_error", text: "402" }, NOW),
    ).toMatchObject({ isUsageLimit: false, isBilling: true });
  });
});

describe("Qwen Code's settings file", () => {
  it("is under QWEN_HOME when set (~ expanded), else ~/.qwen", () => {
    expect(qwenSettingsFile({}, "/home/a")).toBe(join("/home/a", ".qwen", "settings.json"));
    expect(qwenHome({ QWEN_HOME: "" }, "/home/a")).toBe(join("/home/a", ".qwen"));
    expect(qwenHome({ QWEN_HOME: "/data/q" }, "/home/a")).toBe("/data/q");
    expect(qwenHome({ QWEN_HOME: "~/q" }, "/home/a")).toBe(join("/home/a", "q"));
  });

  it("adds Rewake's hooks and keeps the person's settings, hooks and comments", () => {
    const file = join(dir, "settings.json");
    const mine = {
      matcher: "^run_shell_command$",
      hooks: [{ type: "command", command: "/me/check.sh", name: "check" }],
    };
    writeFileSync(
      file,
      `{\n  // my model\n  "model": { "name": "qwen3-coder" },\n  "hooks": {\n    "PreToolUse": ${JSON.stringify([mine])},\n    "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo hi" }] }]\n  }\n}\n`,
    );
    const plan = planQwen(file, "/usr/bin/node", "/s/launcher.mjs", false, "linux");
    if ("error" in plan) throw new Error(plan.error);
    const after = plan.changes[0]?.after ?? "";
    expect(after).toContain("// my model");
    const json = JSON.parse(after.replace("// my model", "")) as {
      model: unknown;
      hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
    };
    expect(json.model).toEqual({ name: "qwen3-coder" });
    expect(json.hooks.PreToolUse).toEqual([mine]);
    // Their own SessionStart hook stays, with Rewake's group after it.
    expect(json.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("echo hi");
    expect(Object.keys(json.hooks).sort()).toEqual(
      ["PreToolUse", "SessionEnd", "SessionStart", "Stop", "StopFailure"].sort(),
    );
    const failure = json.hooks.StopFailure?.[0];
    expect(failure?.matcher).toBe("rate_limit|billing_error");
    expect(failure?.hooks[0]).toEqual({
      type: "command",
      name: "Agent Rewake (StopFailure)",
      command: '"/usr/bin/node" "/s/launcher.mjs" hook qwen-code StopFailure',
      timeout: 5,
    });
  });

  it("makes a new file, changes nothing when run twice, and removes only its own entries", () => {
    const file = join(dir, "nested", "settings.json");
    const first = planQwen(file, "/n", "/l", false, "linux");
    if ("error" in first) throw new Error(first.error);
    expect(first.changes[0]).toMatchObject({ existed: false });
    mkdirSync(join(dir, "nested"));
    writeFileSync(file, first.changes[0]?.after ?? "");
    expect(planQwen(file, "/n", "/l", false, "linux")).toEqual({ changes: [], notes: [] });
    // Taken out again, a file Rewake made is left with no "hooks" key at all.
    const undone = planQwen(file, "/n", "/l", true, "linux");
    if ("error" in undone) throw new Error(undone.error);
    expect(JSON.parse(undone.changes[0]?.after ?? "")).toEqual({});
    // A newer Node path replaces the old entries instead of adding more.
    const moved = planQwen(file, "/n2", "/l", false, "linux");
    if ("error" in moved) throw new Error(moved.error);
    const text = moved.changes[0]?.after ?? "";
    expect(text.match(/hook qwen-code SessionEnd/g)).toHaveLength(1);
    expect(text).toContain('\\"/n2\\"');
    writeFileSync(
      file,
      `{ "theme": "dark", "hooks": ${JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] })} }`,
    );
    const added = planQwen(file, "/n", "/l", false, "linux");
    if ("error" in added) throw new Error(added.error);
    writeFileSync(file, added.changes[0]?.after ?? "");
    const gone = planQwen(file, "/n", "/l", true, "linux");
    if ("error" in gone) throw new Error(gone.error);
    expect(JSON.parse(gone.changes[0]?.after ?? "")).toEqual({
      theme: "dark",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
    });
    writeFileSync(file, gone.changes[0]?.after ?? "");
    expect(planQwen(file, "/n", "/l", true, "linux")).toEqual({ changes: [], notes: [] });
  });

  it("refuses a file it can't read as JSON and a hooks key that isn't an object", () => {
    const file = join(dir, "settings.json");
    writeFileSync(file, "{ not json");
    expect(planQwen(file, "/n", "/l", false)).toMatchObject({
      error: expect.stringContaining("isn't valid JSON"),
    });
    writeFileSync(file, '{ "hooks": [] }');
    expect(planQwen(file, "/n", "/l", false)).toMatchObject({
      error: expect.stringContaining("isn't an object"),
    });
    expect(planQwen(file, '/with"quote', "/l", false)).toMatchObject({
      error: expect.stringContaining("double quote"),
    });
  });

  it("refuses a Rewake event whose value isn't a list, and leaves other events alone on uninstall", () => {
    const file = join(dir, "settings.json");
    writeFileSync(file, '{ "hooks": { "Stop": {} } }');
    expect(planQwen(file, "/n", "/l", false, "linux")).toMatchObject({
      error: expect.stringContaining('"hooks.Stop" in its settings file'),
    });
    expect(planQwen(file, "/n", "/l", true, "linux")).toEqual({ changes: [], notes: [] });
  });

  it("runs Windows hooks in PowerShell, which was not tried", () => {
    const g = ourGroup("SessionEnd", "C:\\n\\node.exe", "C:\\s\\launcher.mjs", "win32");
    expect(g.hooks).toEqual([
      {
        type: "command",
        name: "Agent Rewake (SessionEnd)",
        command: "& 'C:\\n\\node.exe' 'C:\\s\\launcher.mjs' hook qwen-code SessionEnd",
        shell: "powershell",
        timeout: 5,
      },
    ]);
  });
});

describe("agent-rewake install --only qwen-code", () => {
  const run = (o: {
    uninstall?: boolean;
    dryRun?: boolean;
    yes?: boolean;
    env?: NodeJS.ProcessEnv;
    version?: string;
    out?: string[];
  }) =>
    runQwenInstall({
      uninstall: o.uninstall ?? false,
      yes: o.yes ?? true,
      dryRun: o.dryRun ?? false,
      env: o.env ?? { HOME: dir },
      home: dir,
      stateDir: state,
      node: "/n",
      bundle: join(dir, "x.js"),
      interactive: false,
      out: (t) => o.out?.push(t),
      ask: async () => true,
      programs: [{ path: "/q", surface: "terminal", ...(o.version && { version: o.version }) }],
    });

  it("backs up the person's settings, adds the hooks, and takes only them out again", async () => {
    const file = join(dir, ".qwen", "settings.json");
    mkdirSync(join(dir, ".qwen"));
    const original = '{\n  "theme": "dark"\n}\n';
    writeFileSync(file, original);
    const out: string[] = [];
    expect(await run({ version: "0.25.0", out })).toBe(0);
    expect(out.join("")).toContain("preview, not tried");
    expect(out.join("")).toContain("start a new Qwen Code session");
    expect(qwenInstalled({ HOME: dir }, dir)).toBe(true);
    expect(installedPreviews({ HOME: dir }, dir, state)).toContain("qwen-code");
    const backups = readdirSync(join(dir, ".qwen")).filter((f) =>
      f.includes(".agent-rewake-backup-"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, ".qwen", backups[0] ?? ""), "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(file, "utf8")).theme).toBe("dark");
    expect(await run({ uninstall: true })).toBe(0);
    expect(qwenInstalled({ HOME: dir }, dir)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).theme).toBe("dark");
  });

  it("writes to QWEN_HOME when the person set it, and nothing under ~/.qwen", async () => {
    const env = { HOME: dir, QWEN_HOME: join(dir, "elsewhere") };
    expect(await run({ env })).toBe(0);
    expect(existsSync(join(dir, "elsewhere", "settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".qwen"))).toBe(false);
    expect(qwenInstalled(env, dir)).toBe(true);
  });

  it("changes nothing on a dry run, for a Qwen Code that is too old, or when it isn't there", async () => {
    const out: string[] = [];
    expect(await run({ dryRun: true, out })).toBe(0);
    expect(out.join("")).toContain("Dry run: nothing was changed.");
    expect(existsSync(join(dir, ".qwen"))).toBe(false);
    const old: string[] = [];
    expect(await run({ version: "0.24.0", out: old })).toBe(1);
    expect(old.join("")).toContain("too old for Rewake (it needs 0.25.0 or newer)");
    expect(existsSync(join(dir, ".qwen"))).toBe(false);
    const none: string[] = [];
    expect(
      await runQwenInstall({
        uninstall: false,
        yes: true,
        dryRun: false,
        env: { HOME: dir },
        home: dir,
        stateDir: state,
        node: "/n",
        bundle: "/x",
        interactive: false,
        out: (t) => none.push(t),
        ask: async () => true,
        programs: [],
      }),
    ).toBe(1);
    expect(none.join("")).toContain("Qwen Code wasn't found");
  });

  it("says when the person's settings turn hooks off, and doctor sees it", async () => {
    mkdirSync(join(dir, ".qwen"));
    writeFileSync(join(dir, ".qwen", "settings.json"), '{ "disableAllHooks": true }');
    const out: string[] = [];
    expect(await run({ version: "0.25.0", out })).toBe(0);
    expect(out.join("")).toContain("has its hooks turned off (disableAllHooks)");
    expect(hooksTurnedOff("qwen-code", { HOME: dir }, dir)).toContain("disableAllHooks");
  });
});

describe("Qwen Code's hooks", () => {
  const input = (event: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: SID,
      transcript_path: join(dir, ".qwen", "projects", "-work-shop", "chats", `${SID}.jsonl`),
      cwd: join(dir, "shop"),
      hook_event_name: event,
      ...extra,
    });

  it("records the session and its limit, and says how to continue when it ends", async () => {
    const notes: string[] = [];
    const handler = qwenHooks({
      closed: (ctx) => deps(notes, [])(ctx.env, ctx.now),
      program: () => FAKE,
    });
    const send = (event: string, extra?: Record<string, unknown>) =>
      runHook(handler, event, input(event, extra), { QWEN_PROJECT_DIR: dir }, state, NOW);
    await send("SessionStart", { source: "startup" });
    expect(new SessionRecords(state, "qwen-code").get(SID)).toMatchObject({
      open: true,
      program: FAKE,
    });
    await send("StopFailure", { error: "rate_limit", error_details: WEEKLY });
    await send("SessionEnd", { reason: "prompt_input_exit" });
    expect(new SessionRecords(state, "qwen-code").get(SID)).toMatchObject({
      open: false,
      limit: { kind: "weekly", billing: false, resetsAt: Date.UTC(2027, 6, 27, 9, 25) },
    });
    expect(notes).toEqual([
      expect.stringMatching(
        /^Qwen Code in the "shop" folder hit its usage limit\. Run "agent-rewake continue" to continue it /,
      ),
    ]);
  });

  it("notes a billing error, and offers nothing to continue", async () => {
    const notes: string[] = [];
    const handler = qwenHooks({
      closed: (ctx) => deps(notes, [])(ctx.env, ctx.now),
      program: () => FAKE,
    });
    const send = (event: string, extra?: Record<string, unknown>) =>
      runHook(handler, event, input(event, extra), { QWEN_PROJECT_DIR: dir }, state, NOW);
    await send("SessionStart");
    await send("StopFailure", { error: "billing_error", error_details: "402 Payment required" });
    await send("SessionEnd");
    expect(new SessionRecords(state, "qwen-code").get(SID)?.limit).toMatchObject({
      billing: true,
    });
    expect(notes).toEqual([]);
    expect(new ScheduleStore(state).list()).toEqual([]);
  });

  it("takes a turn that ended well as the person carrying on after the limit", async () => {
    const notes: string[] = [];
    const handler = qwenHooks({
      closed: (ctx) => deps(notes, [])(ctx.env, ctx.now),
      program: () => FAKE,
    });
    const send = (event: string, at: number, extra?: Record<string, unknown>) =>
      runHook(handler, event, input(event, extra), { QWEN_PROJECT_DIR: dir }, state, at);
    await send("SessionStart", NOW);
    await send("StopFailure", NOW, { error: "rate_limit", error_details: WEEKLY });
    await send("Stop", NOW + 60_000);
    await send("SessionEnd", NOW + 120_000);
    expect(notes).toEqual([]);
  });

  it("ignores events that aren't Qwen's, a sub-agent's, and Rewake's own resume run", async () => {
    const handler = qwenHooks({
      closed: (ctx) => deps([], [])(ctx.env, ctx.now),
      program: () => FAKE,
    });
    const other = JSON.stringify({ session_id: SID, transcript_path: "/x/y.jsonl", cwd: dir });
    await runHook(handler, "SessionStart", other, {}, state, NOW);
    await runHook(
      handler,
      "SessionStart",
      input("SessionStart", { agent_id: "a1" }),
      { QWEN_PROJECT_DIR: dir },
      state,
      NOW,
    );
    expect(new SessionRecords(state, "qwen-code").list()).toEqual([]);
    // The resume run's own session start is not the person opening the session.
    await runHook(
      handler,
      "SessionStart",
      input("SessionStart"),
      { QWEN_PROJECT_DIR: dir, [FIRE_ENV]: "x" },
      state,
      NOW,
    );
    expect(new SessionRecords(state, "qwen-code").get(SID)?.open).not.toBe(true);
  });
});

describe("continuing a Qwen Code session", () => {
  const record = (work: string) =>
    new SessionRecords(state, "qwen-code").update(SID, work, NOW, (r) => ({
      ...r,
      program: FAKE,
      limit: { seenAt: NOW, kind: "weekly", billing: false, resetsAt: NOW + H },
    }));

  it("resumes with the default approval mode, in its folder, with the message on stdin", async () => {
    const log = join(dir, "resume.log");
    const work = join(dir, "shop");
    mkdirSync(work);
    record(work);
    await runContinue({
      hosts: [qwenHost],
      deps: deps([], [])({}, NOW),
      interactive: true,
      out: () => {},
      ask: async () => "",
    });
    const id = new ScheduleStore(state).list()[0]?.scheduleId ?? "";
    const hosts = new Map([
      ["qwen-code", closedAdapter(qwenHost, state, { ...process.env, FAKE_QWEN_LOG: log })],
    ]);
    const options = {
      stateDir: state,
      now: () => NOW + H + 61_000,
      hosts,
      notify: () => true,
    };
    expect(await fire(id, options)).toBe("sent");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const call = JSON.parse(calls[0] ?? "{}") as { args: string[]; cwd: string; stdin: string };
    expect(call.cwd).toBe(work);
    expect(call.args).toEqual(["--resume", SID, "--approval-mode", "default"]);
    // Never a way past a question: no --yolo, no other approval mode, no sandbox change.
    expect(call.args.join(" ")).not.toMatch(/yolo|auto|bypass|sandbox/i);
    // The message arrived on stdin; none of it is in the argv that `ps` shows every process.
    expect(call.stdin).toBe(DEFAULT_RESUME_PROMPT);
    expect(call.args).not.toContain("-p");
    expect(call.args).not.toContain("--prompt");
    // Once: the timer firing again sends nothing.
    expect(await fire(id, options)).not.toBe("sent");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    expect(new ScheduleStore(state).get(id)?.status).toBe("sent");
  });

  it("holds back while the session is open", async () => {
    const work = join(dir, "shop");
    mkdirSync(work);
    record(work);
    const adapter = closedAdapter(qwenHost, state, process.env);
    await runContinue({
      hosts: [qwenHost],
      deps: deps([], [])({}, NOW),
      interactive: true,
      out: () => {},
      ask: async () => "",
    });
    const s = new ScheduleStore(state).list()[0];
    if (!s) throw new Error("no resume armed");
    expect(await adapter.check(s, NOW + H)).toMatchObject({ sessionOpen: false });
    new SessionRecords(state, "qwen-code").update(SID, work, NOW, (r) => ({ ...r, open: true }));
    expect(await adapter.check(s, NOW + H)).toMatchObject({ sessionOpen: true });
  });

  it("knows the limit again from the text, a lost session, and any other failure", async () => {
    const r = record(dir);
    if (!r) throw new Error("no session record");
    const env = (FAKE_QWEN: string) => ({ ...process.env, FAKE_QWEN });
    const limited = await resumeQwen(r, "Continue.", env("limited"));
    expect(limited).toEqual({
      ok: false,
      reason: "limited",
      resetsAt: expect.any(Number),
    });
    const at = (limited as { resetsAt: number }).resetsAt;
    expect(at).toBeGreaterThan(Date.now());
    expect(new Date(at).toISOString().slice(5, 19)).toBe("07-27T09:25:00");
    expect(await resumeQwen(r, "Continue.", env("gone"))).toEqual({
      ok: false,
      reason: "closed",
      detail: "deleted",
    });
    expect(await resumeQwen(r, "Continue.", env("failed"))).toMatchObject({
      ok: false,
      reason: "failed",
      detail: "exit 1",
    });
    const { program: _gone, ...noProgram } = r;
    expect(await resumeQwen(noProgram, "Continue.", env("ok"))).toMatchObject({
      reason: "unsupported",
    });
    expect(
      await resumeQwen({ ...r, cwd: join(dir, "gone") }, "Continue.", env("ok")),
    ).toMatchObject({
      detail: "folder-gone",
    });
  });
});
