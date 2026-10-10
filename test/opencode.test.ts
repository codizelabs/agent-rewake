import { spawnSync } from "node:child_process";
import {
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContinue } from "../src/continue.js";
import { classifyOpenCodeLimit } from "../src/core/limits/agents.js";
import { recognise } from "../src/core/limits/recognise.js";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import { DEFAULT_RESUME_PROMPT } from "../src/core/threads.js";
import { type ClosedDeps, closedAdapter, FIRE_ENV, reapClosed } from "../src/hosts/closed.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js";
import {
  OPENCODE_ID,
  opencodeHooks,
  opencodeHost,
  resumeOpenCode,
} from "../src/hosts/opencode/host.js";
import {
  opencodeConfigDir,
  opencodeInstalled,
  opencodePluginFile,
  planOpenCode,
  pluginSource,
  runOpenCodeInstall,
} from "../src/hosts/opencode/install.js";
import { installedPreviews } from "../src/hosts/previews.js";
import { SessionRecords } from "../src/hosts/sessions.js";
import { fire } from "../src/timers/fire.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const SID = "ses_1c2a3b4c5d6eAbCdEfGhIjKlMn";
const CHILD = "ses_1c2a3b4c5d6fZyXwVuTsRqPoNm";

/**
 * The retry message of a Go plan limit, as retry.ts builds it (`${message} - ${link}`, with the
 * name of the limit in front of "usage limit" when the server sends one).
 */
const GO =
  "Usage limit reached. It will reset in 2 hours 5 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_abc/go";
const FREE = "Free usage exceeded, subscribe to Go";

let dir: string;
let state: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-opencode-")));
  state = join(dir, "state");
  saveSettings(state, DEFAULT_SETTINGS);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps =
  (notes: string[], armed: number[], extra: Partial<ClosedDeps> = {}) =>
  (env: NodeJS.ProcessEnv, now: number): ClosedDeps => ({
    stateDir: state,
    now,
    env,
    arm: (_id, at) => armed.push(at),
    disarm: () => {},
    notify: (_t, b) => notes.push(b),
    ...extra,
  });

describe("OpenCode's usage limits", () => {
  it("reads the Go plan's retry message, with its wait as the reset", () => {
    expect(classifyOpenCodeLimit({ code: "account_rate_limit", text: GO }, NOW)).toEqual({
      kind: "other",
      billing: false,
      resetsAt: NOW + 2 * H + 5 * 60_000,
    });
    // Without the reason, the sentence alone is enough, and a named limit reads the same.
    expect(
      classifyOpenCodeLimit(
        {
          text: "5-hour usage limit reached. It will reset in 1 day 2 hours. To continue using this model now, enable usage from your available balance",
        },
        NOW,
      ),
    ).toMatchObject({ billing: false, resetsAt: NOW + 26 * H });
  });

  it("still reads the older OpenCode wording of the same limit", () => {
    // From a limit OpenCode showed in Zed (test/limit-samples.test.ts), before "It will reset in".
    expect(
      classifyOpenCodeLimit(
        {
          text: "5-hour usage limit reached. Resets in 4hr 10min. To continue using this model now, enable usage from your available balance",
        },
        NOW,
      ),
    ).toEqual({ kind: "other", billing: false, resetsAt: NOW + 4 * H + 10 * 60_000 });
  });

  it("reads every shape of the wait retry.ts prints", () => {
    const at = (wait: string) =>
      classifyOpenCodeLimit(
        { text: `Usage limit reached. It will reset in ${wait}. To continue using this model now` },
        NOW,
      )?.resetsAt;
    expect(at("3 days 4 hours")).toBe(NOW + 76 * H);
    expect(at("5 days")).toBe(NOW + 120 * H);
    expect(at("1 hour")).toBe(NOW + H);
    expect(at("1 hour 1 minute")).toBe(NOW + H + 60_000);
    expect(at("7 minutes")).toBe(NOW + 7 * 60_000);
    expect(at("less than a minute")).toBe(NOW + 60_000);
  });

  it("is a limit with no time when the server sent no retry-after (the wait is empty)", () => {
    expect(
      classifyOpenCodeLimit(
        { code: "account_rate_limit", text: "Usage limit reached. It will reset in . To continue" },
        NOW,
      ),
    ).toEqual({ kind: "other", billing: false });
  });

  it("takes the reset from the raw error's retry-after when it has one", () => {
    expect(
      classifyOpenCodeLimit({ code: "GoUsageLimitError", text: "x", resetsAt: NOW + 3 * H }, NOW),
    ).toEqual({ kind: "other", billing: false, resetsAt: NOW + 3 * H });
  });

  it("never resumes the free-usage limit, which is an offer to pay", () => {
    for (const input of [
      { code: "free_tier_limit", text: FREE },
      { text: FREE },
      { code: "FreeUsageLimitError", text: "anything" },
    ])
      expect(classifyOpenCodeLimit(input, NOW)).toEqual({ kind: "billing", billing: true });
  });

  it("ignores the retries OpenCode rides out itself", () => {
    for (const text of [
      "Too Many Requests",
      "Provider is overloaded",
      "Rate limit exceeded",
      "429 Too Many Requests",
      "",
    ])
      expect(classifyOpenCodeLimit({ code: "", text }, NOW), text).toBeUndefined();
    expect(classifyOpenCodeLimit({}, NOW)).toBeUndefined();
  });

  it("is the verdict recognise() gives for a hook signal", () => {
    expect(
      recognise({ agent: "opencode", source: "hook", code: "account_rate_limit", text: GO }, NOW),
    ).toMatchObject({
      isUsageLimit: true,
      isBilling: false,
      resetsAt: NOW + 2 * H + 5 * 60_000,
      confidence: "text",
    });
    expect(
      recognise({ agent: "opencode", source: "hook", code: "free_tier_limit", text: FREE }, NOW),
    ).toMatchObject({ isUsageLimit: false, isBilling: true });
    // A reset from a header is a structured one.
    expect(
      recognise(
        {
          agent: "opencode",
          source: "hook",
          code: "GoUsageLimitError",
          text: "",
          resetsAt: NOW + H,
        },
        NOW,
      ),
    ).toMatchObject({ resetsAt: NOW + H, confidence: "structured" });
  });
});

describe("OpenCode's plugin file", () => {
  it("is under XDG_CONFIG_HOME when set, else ~/.config", () => {
    expect(opencodePluginFile({}, "/home/a")).toBe(
      join("/home/a", ".config", "opencode", "plugins", "agent-rewake.js"),
    );
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: "" }, "/home/a")).toBe(
      join("/home/a", ".config", "opencode"),
    );
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/a")).toBe(
      join("/x/cfg", "opencode"),
    );
  });

  it("says Rewake wrote it, exports exactly one function and embeds the paths safely", () => {
    const text = pluginSource('/usr/bin/no"de', "C:\\rewake\\agent-rewake.mjs");
    expect(text.split("\n")[0]).toBe(
      "// Written by Agent Rewake (agent-rewake install --only opencode).",
    );
    expect(text).toContain("edits made here are lost");
    // OpenCode calls every export as a plugin, so a second export would be an error.
    expect(text.match(/^export /gm)).toHaveLength(1);
    expect(text).toContain('const NODE = "/usr/bin/no\\"de";');
    expect(text).toContain('const LAUNCHER = "C:\\\\rewake\\\\agent-rewake.mjs";');
    expect(text).toContain('"hook", "opencode"');
  });

  it("hands the events it cares about to Rewake, in order, and nothing else", () => {
    const rec = join(dir, "rec.mjs");
    const log = join(dir, "hooks.log");
    writeFileSync(
      rec,
      `import { appendFileSync } from "node:fs";
let s = "";
process.stdin.setEncoding("utf8");
for await (const c of process.stdin) s += c;
appendFileSync(process.env.REC, JSON.stringify({ argv: process.argv.slice(2), stdin: JSON.parse(s) }) + "\\n");
`,
    );
    writeFileSync(join(dir, "plugin.mjs"), pluginSource(process.execPath, rec));
    writeFileSync(
      join(dir, "drive.mjs"),
      `import { AgentRewake } from "./plugin.mjs";
const hooks = await AgentRewake({ directory: "/work/shop" });
const e = (type, properties) => hooks.event({ event: { type, properties } });
await e("session.created", { sessionID: "${SID}", info: { id: "${SID}" } });
await e("session.status", { sessionID: "${SID}", status: { type: "busy" } });
await e("message.updated", { sessionID: "${SID}", info: {} });
await e("session.status", { sessionID: "${SID}", status: { type: "retry", attempt: 1, message: ${JSON.stringify(GO)}, next: 1 } });
await e("session.error", { sessionID: "${SID}", error: { name: "APIError", data: { message: "x" } } });
await e("session.status", { sessionID: "${SID}", status: { type: "idle" } });
await hooks["chat.message"]({ sessionID: "${SID}", agent: "build" });
await hooks.dispose();
`,
    );
    const r = spawnSync(process.execPath, [join(dir, "drive.mjs")], {
      env: { ...process.env, REC: log },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; stdin: Record<string, unknown> });
    expect(calls.map((c) => c.argv.join(" "))).toEqual([
      "hook opencode session.created",
      "hook opencode session.status",
      "hook opencode session.error",
      "hook opencode session.status",
      "hook opencode chat.message",
      "hook opencode session.ended",
    ]);
    expect(calls.every((c) => c.stdin.directory === "/work/shop")).toBe(true);
    expect(calls[1]?.stdin.properties).toMatchObject({ status: { type: "retry", message: GO } });
    expect(calls[3]?.stdin.properties).toMatchObject({ status: { type: "idle" } });
    expect(calls[5]?.stdin.properties).toEqual({ sessionID: SID });
  });

  it("never throws into OpenCode, even when Rewake can't be started", () => {
    writeFileSync(join(dir, "plugin.mjs"), pluginSource("/no/such/node", "/no/such/launcher"));
    writeFileSync(
      join(dir, "drive.mjs"),
      `import { AgentRewake } from "./plugin.mjs";
const hooks = await AgentRewake({ directory: "/work" });
await hooks.event({ event: { type: "session.error", properties: { sessionID: "${SID}", error: {} } } });
await hooks.event({});
await hooks.event(undefined);
await hooks["chat.message"](undefined);
await hooks.dispose();
console.log("fine");
`,
    );
    const r = spawnSync(process.execPath, [join(dir, "drive.mjs")], { encoding: "utf8" });
    expect(r.stdout.trim(), r.stderr).toBe("fine");
  });
});

describe("agent-rewake install --only opencode", () => {
  const run = (o: {
    uninstall?: boolean;
    dryRun?: boolean;
    yes?: boolean;
    node?: string;
    env?: NodeJS.ProcessEnv;
    version?: string;
    out?: string[];
  }) =>
    runOpenCodeInstall({
      uninstall: o.uninstall ?? false,
      yes: o.yes ?? true,
      dryRun: o.dryRun ?? false,
      env: o.env ?? { HOME: dir },
      home: dir,
      stateDir: state,
      node: o.node ?? "/n",
      bundle: join(dir, "x.js"),
      interactive: false,
      out: (t) => o.out?.push(t),
      ask: async () => true,
      programs: [{ path: "/oc", surface: "terminal", ...(o.version && { version: o.version }) }],
    });
  const file = () => join(dir, ".config", "opencode", "plugins", "agent-rewake.js");
  const backups = () =>
    readdirSync(join(dir, ".config", "opencode", "plugins")).filter((f) =>
      f.includes(".agent-rewake-backup-"),
    );

  it("adds the plugin beside the person's own, says what it does, and takes only it out again", async () => {
    mkdirSync(join(dir, ".config", "opencode", "plugins"), { recursive: true });
    const mine = join(dir, ".config", "opencode", "plugins", "mine.ts");
    writeFileSync(mine, "export const Mine = async () => ({})\n");
    const out: string[] = [];
    expect(await run({ version: "1.18.35", out })).toBe(0);
    const said = out.join("");
    expect(said).toContain("preview, not tried");
    expect(said).toContain("start OpenCode again");
    // The honest words about permissions, before the person agrees.
    expect(said).toContain("allow most tools without asking by default");
    expect(said).toContain("Rewake never turns on auto-approve");
    expect(readFileSync(file(), "utf8")).toBe(
      pluginSource("/n", join(state, "bin", "agent-rewake.mjs")),
    );
    expect(opencodeInstalled({ HOME: dir }, dir)).toBe(true);
    expect(installedPreviews({ HOME: dir }, dir, state)).toContain("opencode");
    // Run twice: nothing to change.
    const again: string[] = [];
    expect(await run({ version: "1.18.35", out: again })).toBe(0);
    expect(again.join("")).toContain("already set up");
    expect(await run({ uninstall: true })).toBe(0);
    expect(existsSync(file())).toBe(false);
    expect(readFileSync(mine, "utf8")).toBe("export const Mine = async () => ({})\n");
    expect(opencodeInstalled({ HOME: dir }, dir)).toBe(false);
    const gone: string[] = [];
    expect(await run({ uninstall: true, out: gone })).toBe(0);
    expect(gone.join("")).toContain("nothing to remove");
  });

  it("backs up its own old file when it updates it", async () => {
    expect(await run({ node: "/n1" })).toBe(0);
    const old = readFileSync(file(), "utf8");
    expect(await run({ node: "/n2" })).toBe(0);
    expect(readFileSync(file(), "utf8")).toContain('"/n2"');
    const kept = backups();
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dirname(file()), kept[0] ?? ""), "utf8")).toBe(old);
  });

  it("never overwrites or deletes a file of that name that Rewake didn't write", async () => {
    mkdirSync(join(dir, ".config", "opencode", "plugins"), { recursive: true });
    const theirs = "export const Theirs = async () => ({})\n";
    writeFileSync(file(), theirs);
    const out: string[] = [];
    expect(await run({ out })).toBe(1);
    expect(out.join("")).toContain("Rewake didn't write it");
    expect(readFileSync(file(), "utf8")).toBe(theirs);
    expect(backups()).toEqual([]);
    expect(opencodeInstalled({ HOME: dir }, dir)).toBe(false);
    const un: string[] = [];
    expect(await run({ uninstall: true, out: un })).toBe(0);
    expect(un.join("")).toContain("isn't one Rewake wrote");
    expect(readFileSync(file(), "utf8")).toBe(theirs);
    expect(planOpenCode(file(), "/n", "/l")).toMatchObject({ error: expect.any(String) });
  });

  it("writes under XDG_CONFIG_HOME when the person set it, and nothing under ~/.config", async () => {
    const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, "cfg") };
    expect(await run({ env })).toBe(0);
    expect(existsSync(join(dir, "cfg", "opencode", "plugins", "agent-rewake.js"))).toBe(true);
    expect(existsSync(join(dir, ".config"))).toBe(false);
    expect(opencodeInstalled(env, dir)).toBe(true);
  });

  it("changes nothing on a dry run, for an OpenCode that is too old, or when it isn't there", async () => {
    const out: string[] = [];
    expect(await run({ dryRun: true, out })).toBe(0);
    expect(out.join("")).toContain("Dry run: nothing was changed.");
    expect(existsSync(join(dir, ".config"))).toBe(false);
    const old: string[] = [];
    expect(await run({ version: "1.18.34", out: old })).toBe(1);
    expect(old.join("")).toContain("too old for Rewake (it needs 1.18.35 or newer)");
    expect(existsSync(join(dir, ".config"))).toBe(false);
    const none: string[] = [];
    expect(
      await runOpenCodeInstall({
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
    expect(none.join("")).toContain("OpenCode wasn't found");
  });

  it("does nothing without --yes when it can't ask", async () => {
    const out: string[] = [];
    expect(await run({ yes: false, out })).toBe(1);
    expect(out.join("")).toContain("Not a terminal, so nothing was changed");
    expect(existsSync(join(dir, ".config"))).toBe(false);
  });
});

describe("OpenCode's plugin events", () => {
  const send = (
    handler: ReturnType<typeof opencodeHooks>,
    event: string,
    properties: Record<string, unknown>,
    at = NOW,
    env: NodeJS.ProcessEnv = {},
  ) =>
    runHook(
      handler,
      event,
      JSON.stringify({ properties, directory: join(dir, "shop") }),
      env,
      state,
      at,
    );
  const retry = (message: string, reason?: string) => ({
    sessionID: SID,
    status: {
      type: "retry",
      attempt: 1,
      message,
      next: NOW + 5000,
      ...(reason && {
        action: { reason, provider: "opencode", title: "t", message: "m", label: "l" },
      }),
    },
  });
  const idle = { sessionID: SID, status: { type: "idle" } };
  const records = () => new SessionRecords(state, OPENCODE_ID);
  const make = (notes: string[] = [], extra: Partial<ClosedDeps> = {}) =>
    opencodeHooks({
      closed: (ctx) => deps(notes, [], extra)(ctx.env, ctx.now),
      program: () => FAKE,
    });

  it("records the session and the Go limit with its reset, and offers to continue once it closes", async () => {
    const notes: string[] = [];
    const h = make(notes);
    await send(h, "session.created", { sessionID: SID, info: { id: SID } });
    expect(records().get(SID)).toMatchObject({ open: true, program: FAKE });
    await send(h, "session.status", retry(GO, "account_rate_limit"));
    expect(records().get(SID)?.limit).toMatchObject({
      kind: "other",
      billing: false,
      resetsAt: NOW + 2 * H + 5 * 60_000,
    });
    // Still open: nothing is said, and the session is left alone.
    expect(notes).toEqual([]);
    await send(h, "session.ended", { sessionID: SID });
    expect(records().get(SID)).toMatchObject({ open: false });
    expect(notes).toEqual([
      expect.stringMatching(
        /^OpenCode in the "shop" folder hit its usage limit\. Run "agent-rewake continue" to continue it /,
      ),
    ]);
  });

  it("reads the limit from the raw error too, with the retry-after header as the reset", async () => {
    const notes: string[] = [];
    const h = make(notes);
    await send(h, "session.error", {
      sessionID: SID,
      error: {
        name: "APIError",
        data: {
          message: "Rate limit",
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { "retry-after": "7200" },
          responseBody: '{"type":"error","error":{"type":"GoUsageLimitError"}}',
        },
      },
    });
    expect(records().get(SID)?.limit).toMatchObject({
      billing: false,
      resetsAt: NOW + 2 * H,
      confidence: "structured",
    });
    // Other errors are not limits: an abort, an overflow, an API error of another kind.
    await send(h, "session.error", {
      sessionID: CHILD,
      error: { name: "MessageAbortedError", data: { message: "x" } },
    });
    await send(h, "session.error", {
      sessionID: CHILD,
      error: { name: "APIError", data: { message: "x", responseBody: "{}" } },
    });
    await send(h, "session.error", {
      error: { name: "UnknownError", data: { message: "plugin failed" } },
    });
    expect(records().get(CHILD)?.limit).toBeUndefined();
    expect(records().list()).toHaveLength(2);
  });

  it("tells the person once about the free-usage limit, and never offers to continue it", async () => {
    const notes: string[] = [];
    const h = make(notes);
    await send(h, "session.created", { sessionID: SID, info: { id: SID } });
    for (let i = 0; i < 5; i++)
      await send(h, "session.status", retry(FREE, "free_tier_limit"), NOW + i * 1000);
    await send(
      h,
      "session.error",
      {
        sessionID: SID,
        error: {
          name: "APIError",
          data: { message: "x", responseBody: '{"error":"FreeUsageLimitError"}' },
        },
      },
      NOW + 6000,
    );
    await send(h, "session.ended", { sessionID: SID }, NOW + 7000);
    expect(records().get(SID)?.limit).toMatchObject({ billing: true });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("won't lift");
    expect(new ScheduleStore(state).list()).toEqual([]);
  });

  it("takes the end of a later turn as the person carrying on, but not the idle right after an error", async () => {
    const notes: string[] = [];
    const h = make(notes);
    await send(h, "session.created", { sessionID: SID, info: { id: SID } });
    await send(h, "session.status", retry(GO, "account_rate_limit"), NOW);
    // OpenCode waited, tried again and finished: the turn ends in idle, long after the limit.
    await send(h, "session.status", idle, NOW + 2 * H + 60_000);
    await send(h, "session.ended", { sessionID: SID }, NOW + 2 * H + 120_000);
    expect(notes).toEqual([]);

    // A short wait that OpenCode rode out: the turn ends within seconds of the retry notice.
    const quick: string[] = [];
    const q = make(quick);
    const Q = NOW + 5 * H;
    await send(
      q,
      "session.status",
      retry(
        "Usage limit reached. It will reset in less than a minute. To continue",
        "account_rate_limit",
      ),
      Q,
    );
    await send(q, "session.status", idle, Q + 8000);
    await send(q, "session.ended", { sessionID: SID }, Q + 9000);
    expect(quick).toEqual([]);

    // A turn that failed on its limit: the idle comes straight after the error.
    const failed: string[] = [];
    const g = make(failed);
    const T = NOW + 10 * H;
    await send(
      g,
      "session.created",
      { sessionID: CHILD.replace("6fZ", "70Z"), info: { id: CHILD.replace("6fZ", "70Z") } },
      T,
    );
    const id = CHILD.replace("6fZ", "70Z");
    await send(
      g,
      "session.error",
      {
        sessionID: id,
        error: {
          name: "APIError",
          data: {
            message: "x",
            responseBody: "GoUsageLimitError",
            responseHeaders: { "retry-after": "3600" },
          },
        },
      },
      T + 1000,
    );
    await send(g, "session.status", { sessionID: id, status: { type: "idle" } }, T + 1500);
    await send(g, "session.ended", { sessionID: id }, T + 2000);
    expect(failed).toEqual([expect.stringContaining("hit its usage limit")]);
  });

  it("takes a message sent after the limit as carrying on, and cancels what was planned", async () => {
    const notes: string[] = [];
    const h = make(notes);
    await send(h, "session.status", retry(GO, "account_rate_limit"), NOW);
    await send(h, "chat.message", { sessionID: SID }, NOW + 60_000);
    await send(h, "session.ended", { sessionID: SID }, NOW + 120_000);
    expect(notes).toEqual([]);
  });

  it("leaves a sub-agent's session alone: its limit is not a session to continue", async () => {
    const notes: string[] = [];
    const h = make(notes);
    await send(h, "session.created", { sessionID: SID, info: { id: SID } });
    await send(h, "session.created", { sessionID: CHILD, info: { id: CHILD, parentID: SID } });
    await send(h, "session.status", { ...retry(GO, "account_rate_limit"), sessionID: CHILD });
    await send(h, "session.status", { sessionID: CHILD, status: { type: "idle" } });
    expect(records().get(CHILD)).toMatchObject({ child: true });
    expect(records().get(CHILD)?.limit).toBeUndefined();
    expect(records().get(CHILD)?.open).not.toBe(true);
    expect(records().get(SID)).toMatchObject({ open: true });
  });

  it("notices a session whose OpenCode has gone without saying so", async () => {
    const notes: string[] = [];
    const armed: number[] = [];
    let alive = true;
    const closed = (ctx: { env: NodeJS.ProcessEnv; now: number }) =>
      deps(notes, armed, {
        agent: () => ({ pid: 4242, name: "opencode" }),
        running: () => alive,
      })(ctx.env, ctx.now);
    const h = opencodeHooks({ closed, program: () => FAKE });
    await send(h, "session.status", retry(GO, "account_rate_limit"));
    expect(records().get(SID)).toMatchObject({
      open: true,
      agents: [{ pid: 4242, name: "opencode" }],
    });
    expect(
      reapClosed([opencodeHost], deps(notes, armed, { running: () => alive })({}, NOW + 60_000)),
    ).toBe(0);
    alive = false;
    expect(
      reapClosed([opencodeHost], deps(notes, armed, { running: () => alive })({}, NOW + 60_000)),
    ).toBe(1);
    expect(notes).toEqual([expect.stringContaining('Run "agent-rewake continue"')]);
  });

  it("ignores ids that aren't OpenCode's, Rewake's own resume run, and Zed's own add-on", async () => {
    const h = make();
    await send(h, "session.created", { sessionID: "123e4567-e89b", info: {} });
    await send(h, "session.created", { sessionID: "ses_../../x", info: {} });
    await send(h, "session.created", {});
    await send(h, "session.status", retry(GO, "account_rate_limit"), NOW, { [FIRE_ENV]: "x" });
    await send(h, "session.created", { sessionID: SID, info: { id: SID } }, NOW, {
      AGENT_REWAKE_OWNER: "acp",
    });
    expect(records().list()).toEqual([]);
  });
});

describe("continuing an OpenCode session", () => {
  const record = (work: string) =>
    new SessionRecords(state, OPENCODE_ID).update(SID, work, NOW, (r) => ({
      ...r,
      program: FAKE,
      limit: { seenAt: NOW, kind: "other", billing: false, resetsAt: NOW + H },
    }));

  it("resumes in the session's folder with the message on stdin and no way past a question, once", async () => {
    const log = join(dir, "resume.log");
    const work = join(dir, "shop");
    mkdirSync(work);
    record(work);
    await runContinue({
      hosts: [opencodeHost],
      deps: deps([], [])({}, NOW),
      interactive: true,
      out: () => {},
      ask: async () => "",
    });
    const id = new ScheduleStore(state).list()[0]?.scheduleId ?? "";
    const hosts = new Map([
      [OPENCODE_ID, closedAdapter(opencodeHost, state, { ...process.env, FAKE_OPENCODE_LOG: log })],
    ]);
    const options = { stateDir: state, now: () => NOW + H + 61_000, hosts, notify: () => true };
    expect(await fire(id, options)).toBe("sent");
    const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0] ?? "{}") as {
      args: string[];
      cwd: string;
      stdin: string;
    };
    expect(call.cwd).toBe(work);
    expect(call.args).toEqual(["run", "--session", SID, "--dir", work]);
    // Never an auto-approve flag, under any of its names.
    expect(call.args.join(" ")).not.toMatch(/auto|yolo|dangerous|skip|permission/i);
    // The message arrived on stdin; none of it is in the argv that `ps` shows every process.
    expect(call.stdin).toBe(DEFAULT_RESUME_PROMPT);
    expect(await fire(id, options)).not.toBe("sent");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    expect(new ScheduleStore(state).get(id)?.status).toBe("sent");
  });

  it("holds back while the session is open", async () => {
    const work = join(dir, "shop");
    mkdirSync(work);
    record(work);
    const adapter = closedAdapter(opencodeHost, state, process.env);
    await runContinue({
      hosts: [opencodeHost],
      deps: deps([], [])({}, NOW),
      interactive: true,
      out: () => {},
      ask: async () => "",
    });
    const s = new ScheduleStore(state).list()[0];
    if (!s) throw new Error("no resume armed");
    expect(await adapter.check(s, NOW + H)).toMatchObject({ sessionOpen: false });
    new SessionRecords(state, OPENCODE_ID).update(SID, work, NOW, (r) => ({ ...r, open: true }));
    expect(await adapter.check(s, NOW + H)).toMatchObject({ sessionOpen: true });
  });

  it("knows a lost session, any other failure, no program and a folder that's gone", async () => {
    const r = record(dir);
    if (!r) throw new Error("no session record");
    const env = (FAKE_OPENCODE: string) => ({ ...process.env, FAKE_OPENCODE });
    expect(await resumeOpenCode(r, "Continue.", env("ok"))).toEqual({ ok: true });
    expect(await resumeOpenCode(r, "Continue.", env("gone"))).toEqual({
      ok: false,
      reason: "closed",
      detail: "deleted",
    });
    expect(await resumeOpenCode(r, "Continue.", env("failed"))).toMatchObject({
      ok: false,
      reason: "failed",
      detail: "exit 1",
    });
    const { program: _gone, ...noProgram } = r;
    expect(await resumeOpenCode(noProgram, "Continue.", env("ok"))).toMatchObject({
      reason: "unsupported",
    });
    expect(
      await resumeOpenCode({ ...r, cwd: join(dir, "gone") }, "Continue.", env("ok")),
    ).toMatchObject({ detail: "folder-gone" });
  });
});

describe("the whole loop, offline", () => {
  it("records a Go limit from the plugin's events, offers it after OpenCode closes, and continues it at the reset", async () => {
    const log = join(dir, "resume.log");
    const work = join(dir, "shop");
    mkdirSync(work);
    const notes: string[] = [];
    const armed: number[] = [];
    const h = opencodeHooks({
      closed: (ctx) => deps(notes, armed)(ctx.env, ctx.now),
      program: () => FAKE,
    });
    const at = (event: string, properties: Record<string, unknown>, t: number) =>
      runHook(h, event, JSON.stringify({ properties, directory: work }), {}, state, t);
    await at("session.created", { sessionID: SID, info: { id: SID } }, NOW);
    await at("chat.message", { sessionID: SID }, NOW + 1000);
    await at(
      "session.status",
      {
        sessionID: SID,
        status: {
          type: "retry",
          attempt: 1,
          message: GO,
          action: { reason: "account_rate_limit" },
          next: NOW + 2 * H,
        },
      },
      NOW + 60_000,
    );
    await at("session.ended", { sessionID: SID }, NOW + 120_000);
    expect(notes).toEqual([expect.stringContaining('Run "agent-rewake continue"')]);
    expect(new SessionRecords(state, OPENCODE_ID).get(SID)).toMatchObject({
      open: false,
      cwd: work,
      limit: { resetsAt: NOW + 60_000 + 2 * H + 5 * 60_000 },
    });

    // The person runs `agent-rewake continue`; at the reset the timer's `fire` resumes it.
    await runContinue({
      hosts: [opencodeHost],
      deps: deps([], armed)({}, NOW + 180_000),
      interactive: true,
      out: () => {},
      ask: async () => "",
    });
    const s = new ScheduleStore(state).list()[0];
    if (!s) throw new Error("no resume armed");
    expect(s.dueAt).toBeGreaterThan(NOW + 2 * H);
    const hosts = new Map([
      [OPENCODE_ID, closedAdapter(opencodeHost, state, { ...process.env, FAKE_OPENCODE_LOG: log })],
    ]);
    const options = { stateDir: state, now: () => s.dueAt + 1000, hosts, notify: () => true };
    expect(await fire(s.scheduleId, options)).toBe("sent");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0] ?? "{}")).toMatchObject({
      args: ["run", "--session", SID, "--dir", work],
      stdin: DEFAULT_RESUME_PROMPT,
    });
  });
});
