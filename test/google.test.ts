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
import { nextMidnight } from "../src/core/time.js";
import {
  agyOpenIn,
  agyProcesses,
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
  transcriptSessionId,
  withApiKeyReset,
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

  it("isn't fooled by the billing words Gemini puts in every quota error", () => {
    expect(
      classifyGeminiError(
        "[API Error: You exceeded your current quota, please check your plan and billing details. Your daily quota will reset after 9h12m0s.]",
        NOW,
      ),
    ).toEqual({ kind: "daily", billing: false, resetsAt: NOW + (9 * 60 + 12) * 60_000 });
    // A per-minute quota with a short retry is Gemini CLI's to ride out.
    expect(
      classifyGeminiError(
        "[API Error: RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details. Please retry in 44.09s.]",
        NOW,
      ),
    ).toBeUndefined();
    expect(
      classifyGeminiError("[API Error: RESOURCE_EXHAUSTED: No capacity available for model]", NOW),
    ).toBeUndefined();
    // No quota for this model on the account's tier: no wait brings it.
    expect(
      classifyGeminiError(
        "[API Error: RESOURCE_EXHAUSTED: Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0]",
        NOW,
      ),
    ).toEqual({ kind: "billing", billing: true });
  });

  it("passes over the bookkeeping records Gemini appends after an error", () => {
    const f = join(dir, "s.jsonl");
    writeFileSync(
      f,
      [
        JSON.stringify({ sessionId: "11111111-2222-3333-4444-555555555555", kind: "main" }),
        JSON.stringify({ type: "user", content: "go" }),
        JSON.stringify({ type: "error", content: "RESOURCE_EXHAUSTED" }),
        JSON.stringify({ $set: { lastUpdated: "2026-10-07T12:00:00Z" } }),
        JSON.stringify({ type: "info", content: "Switched model" }),
        "",
      ].join("\n"),
    );
    expect(lastErrorText(f)).toBe("RESOURCE_EXHAUSTED");
    expect(transcriptSessionId(f)).toBe("11111111-2222-3333-4444-555555555555");
    expect(transcriptSessionId(join(dir, "missing.jsonl"))).toBeUndefined();
  });

  it("gives an API-key quota with no reset the next midnight Pacific", () => {
    const now = Date.parse("2026-10-07T12:00:00Z"); // 05:00 in Los Angeles (PDT)
    const limit = { kind: "daily", billing: false };
    expect(withApiKeyReset(limit, true, now).resetsAt).toBe(Date.parse("2026-10-08T07:00:00Z"));
    expect(withApiKeyReset(limit, false, now).resetsAt).toBeUndefined();
    expect(withApiKeyReset({ ...limit, resetsAt: now + H }, true, now).resetsAt).toBe(now + H);
    // Across the change back to standard time (1 November 2026): midnight PST is 08:00 UTC.
    expect(nextMidnight("America/Los_Angeles", Date.parse("2026-11-01T12:00:00Z"))).toBe(
      Date.parse("2026-11-02T08:00:00Z"),
    );
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
    // The person switched to a fallback model: Gemini gives the hook a new session_id, but the
    // file (and the id `gemini --resume` takes) stays the same.
    writeFileSync(
      transcript,
      `${JSON.stringify({ sessionId: SID, kind: "main" })}\n${readFileSync(transcript, "utf8")}`,
    );
    await runHook(
      handler,
      "AfterAgent",
      JSON.stringify({
        session_id: "fallback-0001",
        transcript_path: transcript,
        cwd: join(dir, "shop"),
        hook_event_name: "AfterAgent",
      }),
      { GEMINI_SESSION_ID: "fallback-0001" },
      state,
      NOW,
    );
    await event("SessionEnd");
    expect(new SessionRecords(state, "gemini-cli").get("fallback-0001")).toBeUndefined();
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
    // Turned off explicitly: refused, with where to turn them on.
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "settings.json"),
      '{ // off\n "hooksConfig": { "enabled": false } }',
    );
    const off = await run();
    expect(off.code).toBe(1);
    expect(off.output).toContain("Gemini CLI's hooks are turned off");
    expect(calls).toEqual([]);
    // Not set at all: on, as Gemini's own default is.
    writeFileSync(join(home, ".gemini", "settings.json"), "{}");
    expect((await run()).code).toBe(0);
    expect(calls).toEqual([["extensions", "link", join(state, "hosts", "gemini-extension")]]);
    expect(calls.flat()).not.toContain("--consent");
    const noTerminal = await run({ interactive: false });
    expect(noTerminal.code).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("Antigravity CLI: is a conversation open?", () => {
  const ps = (command: string, args: string[]) => {
    if (command === "ps")
      return [
        "  101 /usr/local/bin/agy",
        "  102 node /opt/homebrew/lib/node_modules/agy/bin/agy --conversation x",
        "  103 agy remote-control start",
        "  104 /usr/bin/vim agy.txt",
      ].join("\n");
    if (command === "lsof")
      return (
        { "101": "p101\nfcwd\nn/work/other\n", "102": "p102\nfcwd\nn/work/shop\n" }[
          args[2] as string
        ] ?? ""
      );
    return "";
  };

  it("finds agy run directly or through Node, but not Remote Control's service", () => {
    expect(agyProcesses("darwin", ps)).toEqual([
      { pid: 101, cwd: "/work/other" },
      { pid: 102, cwd: "/work/shop" },
    ]);
  });

  it("holds a resume back only for an agy in that folder, or one whose folder is unknown", () => {
    expect(agyOpenIn("/work/shop", agyProcesses("darwin", ps))).toBe(true);
    expect(agyOpenIn("/work/api", agyProcesses("darwin", ps))).toBe(false);
    expect(agyOpenIn("/work/api", [{ pid: 7 }])).toBe(true);
    expect(agyOpenIn("/work/api", [])).toBe(false);
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
    // A reset time wins over the offer of overages.
    expect(
      classifyAntigravityStop(
        {
          terminationReason: "error",
          error:
            "Individual quota reached. Contact your administrator to enable overages. Resets in 4h10m0s",
        },
        NOW,
      ),
    ).toEqual({ kind: "other", billing: false, resetsAt: NOW + (4 * 60 + 10) * 60_000 });
    // Seconds away: Antigravity waits that out itself.
    expect(
      classifyAntigravityStop(
        {
          terminationReason: "error",
          error: "RESOURCE_EXHAUSTED: Your quota will reset after 5s.",
        },
        NOW,
      ),
    ).toBeUndefined();
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

  it("at a limit in the app or the IDE, says when it resets, once per reset", async () => {
    const notes: string[] = [];
    const handler = antigravityHooks({
      closed: (ctx) => deps(notes, [])(ctx.env, ctx.now),
      program: () => FAKE,
    });
    const home = join(dir, "h");
    const stop = (surface: string, id = SID) =>
      runHook(
        handler,
        "Stop",
        JSON.stringify({
          conversationId: id,
          workspacePaths: [join(dir, "app")],
          transcriptPath: join(home, ".gemini", surface, "brain", id, "t.jsonl"),
          terminationReason: "error",
          error: "Individual quota reached. Resets in 1h0m0s",
        }),
        { GEMINI_HOME: join(home, ".gemini") },
        state,
        NOW,
      );
    expect(await stop("antigravity")).toBe('{"decision":"allow"}');
    expect(await stop("antigravity")).toBe('{"decision":"allow"}');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(
      /^Antigravity hit its usage limit in the Antigravity app\. It resets (at|on) .+\. Rewake can't continue conversations there, so continue yours after the reset\.$/,
    );
    await stop("antigravity-ide", "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4c");
    expect(notes[1]).toContain("in the Antigravity IDE");
    // Nothing is recorded to continue: only the CLI's conversations can be.
    expect(new SessionRecords(state, "antigravity").get(SID)).toBeUndefined();
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
    let output = "";
    const run = (
      uninstall: boolean,
      programs = [{ path: "/agy", surface: "terminal" }],
      surfaces: string[] = [],
    ) =>
      runAntigravityInstall({
        uninstall,
        yes: true,
        dryRun: false,
        env,
        stateDir: state,
        node: "/n",
        bundle: join(dir, "x.js"),
        interactive: false,
        out: (t) => {
          output += t;
        },
        ask: async () => true,
        programs,
        surfaces,
      });
    expect(await run(false, [])).toBe(1);
    // Only the app: the plugin goes in, to say when limits reset there.
    output = "";
    expect(await run(false, [], ["app"])).toBe(0);
    expect(output).toContain("it can only tell you when a usage limit resets");
    expect(await run(false)).toBe(0);
    expect(JSON.parse(readFileSync(join(pluginDir(env, home), "hooks.json"), "utf8"))).toEqual(
      JSON.parse(antigravityHooksJson("/n", join(state, "bin", "agent-rewake.mjs"))),
    );
    expect(await run(true)).toBe(0);
    expect(existsSync(pluginDir(env, home))).toBe(false);
  });
});
