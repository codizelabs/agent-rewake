import {
  chmodSync,
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
import { runContinue } from "../src/continue.js";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import {
  antigravityHooks,
  antigravityHost,
  classifyAntigravityStop,
  surfaceOf,
} from "../src/hosts/antigravity/host.js";
import {
  antigravityHooksJson,
  pluginDir,
  runAntigravityInstall,
} from "../src/hosts/antigravity/install.js";
import { type ClosedDeps, closedAdapter } from "../src/hosts/closed.js";
import {
  classifyGeminiError,
  geminiHooks,
  geminiHost,
  lastErrorText,
} from "../src/hosts/gemini/host.js";
import { geminiHooksJson, runGeminiInstall } from "../src/hosts/gemini/install.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js";
import { SessionRecords } from "../src/hosts/sessions.js";
import { fire } from "../src/timers/fire.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-resume.mjs", import.meta.url));
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const SID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

let dir: string;
let state: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-google-")));
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

describe("Gemini CLI", () => {
  it("reads the reset from the error text, and knows a limit from other errors", () => {
    expect(
      classifyGeminiError(
        "[API Error: RESOURCE_EXHAUSTED: Your quota will reset after 1h30m0s.]",
        NOW,
      ),
    ).toEqual({
      kind: "other",
      billing: false,
      resetsAt: NOW + 1.5 * H,
    });
    expect(
      classifyGeminiError(
        "You have exhausted your daily quota. Resets at 2026-10-08T07:00:00Z",
        NOW,
      ),
    ).toMatchObject({
      kind: "daily",
      resetsAt: Date.parse("2026-10-08T07:00:00Z"),
    });
    expect(classifyGeminiError("[API Error: 500 Internal]", NOW)).toBeUndefined();
  });

  it("only counts the newest record of the session file", () => {
    const f = join(dir, "s.jsonl");
    const err = JSON.stringify({ type: "error", content: "RESOURCE_EXHAUSTED" });
    writeFileSync(f, `${err}\n`);
    expect(lastErrorText(f)).toBe("RESOURCE_EXHAUSTED");
    writeFileSync(f, `${err}\n${JSON.stringify({ type: "gemini", content: "ok" })}\n`);
    expect(lastErrorText(f)).toBeUndefined();
    writeFileSync(
      f,
      `${JSON.stringify({ type: "error", content: [{ text: "Individual " }, { text: "quota reached" }] })}\n`,
    );
    expect(lastErrorText(f)).toBe("Individual quota reached");
  });

  it("records the session and its limit, and says how to continue when it ends", async () => {
    const notes: string[] = [];
    const handler = geminiHooks({
      closed: (ctx) => deps(notes, [])(ctx.env, ctx.now),
      program: () => FAKE,
    });
    const transcript = join(dir, ".gemini", "tmp", "abc", "chats", "session-1.jsonl");
    mkdirSync(join(transcript, ".."), { recursive: true });
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "error", content: "[API Error: RESOURCE_EXHAUSTED … reset after 2h0m0s]" })}\n`,
    );
    const event = (name: string) =>
      runHook(
        handler,
        name,
        JSON.stringify({
          session_id: SID,
          transcript_path: transcript,
          cwd: join(dir, "shop"),
          hook_event_name: name,
        }),
        { GEMINI_SESSION_ID: SID },
        state,
        NOW,
      );
    await event("SessionStart");
    await event("AfterAgent");
    await event("SessionEnd");
    expect(new SessionRecords(state, "gemini-cli").get(SID)).toMatchObject({
      open: false,
      program: FAKE,
      limit: { resetsAt: NOW + 2 * H },
    });
    expect(notes).toEqual([
      expect.stringMatching(
        /^Gemini CLI in the "shop" folder hit its usage limit\. Run "agent-rewake continue"/,
      ),
    ]);
  });

  it("resumes the closed session with --approval-mode default, in its folder", async () => {
    const log = join(dir, "resume.log");
    const work = join(dir, "shop");
    mkdirSync(work);
    new SessionRecords(state, "gemini-cli").update(SID, work, NOW, (r) => ({
      ...r,
      program: FAKE,
      limit: { seenAt: NOW, kind: "other", billing: false, resetsAt: NOW + H },
    }));
    await runContinue({
      hosts: [geminiHost],
      deps: deps([], [])({}, NOW),
      interactive: true,
      out: () => {},
      ask: async () => "",
    });
    const id = new ScheduleStore(state).list()[0]?.scheduleId ?? "";
    const outcome = await fire(id, {
      stateDir: state,
      now: () => NOW + H + 61_000,
      hosts: new Map([
        ["gemini-cli", closedAdapter(geminiHost, state, { ...process.env, FAKE_RESUME_LOG: log })],
      ]),
      notify: () => true,
    });
    expect(outcome).toBe("sent");
    const call = JSON.parse(readFileSync(log, "utf8").trim()) as { args: string[]; cwd: string };
    expect(call.cwd).toBe(work);
    expect(call.args).toEqual([
      "--resume",
      SID,
      "-p",
      expect.any(String),
      "--approval-mode",
      "default",
      "-o",
      "json",
    ]);
    expect(call.args.join(" ")).not.toMatch(/--yolo|--skip-trust/);
  });

  it("writes linkable hooks with millisecond timeouts", () => {
    const json = JSON.parse(geminiHooksJson("/n", "/l.mjs"));
    expect(Object.keys(json.hooks)).toEqual([
      "SessionStart",
      "SessionEnd",
      "BeforeAgent",
      "AfterAgent",
    ]);
    expect(json.hooks.AfterAgent[0].hooks[0]).toEqual({
      type: "command",
      name: "agent-rewake-after-agent",
      command: '"/n" "/l.mjs" hook gemini-cli AfterAgent',
      timeout: 5000,
    });
  });

  it("checks that Gemini's hooks are on, links with Gemini's own command, and never answers its question", async () => {
    const home = join(dir, "home");
    const calls: string[][] = [];
    const run = (o: Partial<Parameters<typeof runGeminiInstall>[0]> = {}) => {
      let output = "";
      return runGeminiInstall({
        uninstall: false,
        yes: true,
        dryRun: false,
        env: { HOME: home },
        stateDir: state,
        node: "/n",
        bundle: join(dir, "x.js"),
        interactive: true,
        out: (t) => {
          output += t;
        },
        ask: async () => true,
        programs: [{ path: "/g", surface: "terminal", version: "0.62.0" }],
        run: (_p, a) => {
          calls.push(a);
          return 0;
        },
        ...o,
      }).then((code) => ({ code, output }));
    };
    const off = await run();
    expect(off.code).toBe(1);
    expect(off.output).toContain("Gemini CLI runs extension hooks only when they're turned on");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "settings.json"),
      '{ // on\n "hooksConfig": { "enabled": true } }',
    );
    expect((await run()).code).toBe(0);
    expect(calls).toEqual([["extensions", "link", join(state, "hosts", "gemini-extension")]]);
    expect(calls.flat()).not.toContain("--consent");
    const noTerminal = await run({ interactive: false });
    expect(noTerminal.code).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("Antigravity CLI", () => {
  it("reads a quota stop and its reset; anything else isn't a limit", () => {
    expect(
      classifyAntigravityStop(
        { terminationReason: "error", error: "Individual quota reached. Resets in 16h39m20s" },
        NOW,
      ),
    ).toEqual({
      kind: "other",
      billing: false,
      resetsAt: NOW + (16 * 3600 + 39 * 60 + 20) * 1000,
    });
    expect(classifyAntigravityStop({ terminationReason: "model_stop" }, NOW)).toBeUndefined();
    expect(
      classifyAntigravityStop({ terminationReason: "error", error: "network" }, NOW),
    ).toBeUndefined();
  });

  it("knows which surface wrote a conversation", () => {
    const home = join(dir, "h");
    expect(surfaceOf(join(home, ".gemini", "antigravity-cli", "brain", "x.jsonl"), {}, home)).toBe(
      "antigravity-cli",
    );
    expect(surfaceOf(join(home, ".gemini", "antigravity-acp", "c", "x.jsonl"), {}, home)).toBe(
      "antigravity-acp",
    );
  });

  it("records the CLI's limits only, and always lets the stop happen", async () => {
    const notes: string[] = [];
    const handler = antigravityHooks({
      closed: (ctx) => deps(notes, [])(ctx.env, ctx.now),
      program: () => FAKE,
    });
    const home = join(dir, "h");
    const stop = (surface: string) =>
      runHook(
        handler,
        "Stop",
        JSON.stringify({
          conversationId: SID,
          workspacePaths: [join(dir, "app")],
          transcriptPath: join(home, ".gemini", surface, "brain", SID, "t.jsonl"),
          terminationReason: "error",
          error: "Individual quota reached. Resets in 1h0m0s",
        }),
        { GEMINI_HOME: join(home, ".gemini") },
        state,
        NOW,
      );
    expect(await stop("antigravity-acp")).toBe('{"decision":"allow"}');
    expect(new SessionRecords(state, "antigravity").get(SID)).toBeUndefined();
    expect(await stop("antigravity-cli")).toBe('{"decision":"allow"}');
    expect(new SessionRecords(state, "antigravity").get(SID)).toMatchObject({
      open: false,
      limit: { resetsAt: NOW + H },
    });
    expect(notes).toHaveLength(1);
  });

  it("only notifies while an agy process runs, and judges a resume by its response", async () => {
    const log = join(dir, "resume.log");
    new SessionRecords(state, "antigravity").update(SID, dir, NOW, (r) => ({
      ...r,
      program: FAKE,
      limit: { seenAt: NOW, kind: "other", billing: false, resetsAt: NOW + H },
    }));
    await runContinue({
      hosts: [antigravityHost(() => false)],
      deps: deps([], [])({}, NOW),
      interactive: true,
      out: () => {},
      ask: async () => "",
    });
    const id = new ScheduleStore(state).list()[0]?.scheduleId ?? "";
    const at = (open: boolean, env: NodeJS.ProcessEnv = {}) =>
      fire(id, {
        stateDir: state,
        now: () => NOW + H + 61_000,
        hosts: new Map([
          [
            "antigravity",
            closedAdapter(
              antigravityHost(() => open),
              state,
              { ...process.env, FAKE_RESUME_LOG: log, ...env },
            ),
          ],
        ]),
        notify: () => true,
      });
    expect(await at(true)).toBe("notified");
    expect(existsSync(log)).toBe(false);
  });

  it("installs one plugin folder with a Stop hook, and removes it", async () => {
    const home = join(dir, "home");
    const env = { HOME: home };
    const run = (uninstall: boolean, programs = [{ path: "/agy", surface: "terminal" }]) =>
      runAntigravityInstall({
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
        programs,
      });
    expect(await run(false, [])).toBe(1);
    expect(await run(false)).toBe(0);
    expect(JSON.parse(readFileSync(join(pluginDir(env, home), "hooks.json"), "utf8"))).toEqual(
      JSON.parse(antigravityHooksJson("/n", join(state, "bin", "agent-rewake.mjs"))),
    );
    expect(await run(true)).toBe(0);
    expect(existsSync(pluginDir(env, home))).toBe(false);
  });
});
