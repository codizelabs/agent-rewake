import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContinue } from "../src/continue.js";
import { classifyCursorError } from "../src/core/limits/agents.js";
import { recogniseForHost } from "../src/core/limits/recognise.js";
import { ScheduleStore } from "../src/core/store.js";
import { armClosed, type ClosedDeps, onLimit, onSessionEnd } from "../src/hosts/closed.js";
import { CURSOR_ID, cursorHooks, cursorHost, transcriptError } from "../src/hosts/cursor/host.js";
import {
  cursorFound,
  cursorInstalled,
  planCursor,
  WAIT_SECONDS,
} from "../src/hosts/cursor/install.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js";
import { SessionRecords } from "../src/hosts/sessions.js";
import { notice } from "../src/timers/fire.js";

let dir: string;
let state: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-cursor-"));
  state = join(dir, "state");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;
const CHAT = "8114c47b-80eb-47b5-bb6d-53ad1c731995";
const LIMIT = "You've hit your rate limit. Please try again later.";
const FREE =
  "You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.";

describe("Cursor's hooks file", () => {
  it("adds Rewake's two hooks and keeps the person's; uninstall removes only Rewake's", () => {
    const file = join(dir, "hooks.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 1, hooks: { stop: [{ command: "./my-audit.sh" }] } }),
    );
    const plan = planCursor(file, "/n", "/l.mjs", false);
    if ("error" in plan) throw new Error(plan.error);
    const after = JSON.parse(plan.changes[0]?.after ?? "{}");
    expect(after.hooks.stop).toEqual([
      { command: "./my-audit.sh" },
      { command: '"/n" "/l.mjs" hook cursor stop', timeout: WAIT_SECONDS },
    ]);
    expect(after.hooks.beforeSubmitPrompt).toEqual([
      { command: '"/n" "/l.mjs" hook cursor beforeSubmitPrompt', timeout: 10 },
    ]);
    writeFileSync(file, plan.changes[0]?.after ?? "");
    expect(cursorInstalled(dir)).toBe(false); // not ~/.cursor here
    // Installing again changes nothing; uninstall leaves the person's hook.
    const again = planCursor(file, "/n", "/l.mjs", false);
    expect("changes" in again && again.changes).toEqual([]);
    const back = planCursor(file, "/n", "/l.mjs", true);
    if ("error" in back) throw new Error(back.error);
    expect(JSON.parse(back.changes[0]?.after ?? "{}").hooks).toEqual({
      stop: [{ command: "./my-audit.sh" }],
    });
  });

  it("refuses a path with a double quote in it rather than write a broken command", () => {
    expect(planCursor(join(dir, "hooks.json"), '/my "node"/node', "/l.mjs", false)).toMatchObject({
      error: expect.stringContaining("contains a double quote"),
    });
  });

  it("leaves a file it can't read alone", () => {
    const file = join(dir, "hooks.json");
    writeFileSync(file, "{ nope");
    expect(planCursor(file, "/n", "/l.mjs", false)).toMatchObject({
      error: expect.stringContaining("isn't valid JSON"),
    });
  });

  it("reads a hooks file saved with a byte-order mark, as Windows editors may write it", () => {
    const file = join(dir, "hooks.json");
    writeFileSync(
      file,
      `\uFEFF${JSON.stringify({ version: 1, hooks: { stop: [{ command: "./my-audit.sh" }] } })}`,
    );
    const plan = planCursor(file, "/n", "/l.mjs", false);
    if ("error" in plan) throw new Error(plan.error);
    expect(JSON.parse(plan.changes[0]?.after ?? "{}").hooks.stop[0]).toEqual({
      command: "./my-audit.sh",
    });
  });

  it("on Windows, finds Cursor's command on a copied environment's Path", () => {
    const exists = (p: string) =>
      p === "C:\\Users\\o\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd";
    const env = {
      Path: "C:\\Windows;C:\\Users\\o\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin",
      PATHEXT: ".EXE;.CMD",
    };
    expect(cursorFound(env, "C:\\Users\\o", "win32", exists)).toBe(true);
    expect(cursorFound({ Path: "C:\\Windows" }, "C:\\Users\\o", "win32", exists)).toBe(false);
  });

  it("is found in ~/.cursor/hooks.json", () => {
    mkdirSync(join(dir, ".cursor"));
    const plan = planCursor(join(dir, ".cursor", "hooks.json"), "/n", "/l.mjs", false);
    if ("error" in plan) throw new Error(plan.error);
    writeFileSync(join(dir, ".cursor", "hooks.json"), plan.changes[0]?.after ?? "");
    expect(cursorInstalled(dir)).toBe(true);
  });
});

describe("Cursor's transcript", () => {
  it("gives the error of a turn that ended in one, and nothing otherwise", () => {
    const t = join(dir, "t.jsonl");
    writeFileSync(
      t,
      `{"type":"user"}\n{"type":"turn_ended","status":"error","error":"${LIMIT}"}\n`,
    );
    expect(transcriptError(t)).toBe(LIMIT);
    writeFileSync(t, `{"type":"turn_ended","status":"success"}\n`);
    expect(transcriptError(t)).toBeUndefined();
    expect(transcriptError(join(dir, "missing.jsonl"))).toBeUndefined();
  });
});

describe("Cursor's hooks: a limit, the person's choice, the continue", () => {
  let clock = NOW;
  const notes: string[] = [];
  const armed: [string, number][] = [];
  const deps = (now = clock): ClosedDeps => ({
    stateDir: state,
    now,
    env: {},
    arm: (id, at) => armed.push([id, at]),
    disarm: () => {},
    notify: (_t, b) => notes.push(b),
  });
  beforeEach(() => {
    clock = NOW;
    notes.length = 0;
    armed.length = 0;
  });
  const transcript = (error?: string) => {
    const t = join(dir, `t-${Math.random()}.jsonl`);
    writeFileSync(
      t,
      `${JSON.stringify(error ? { type: "turn_ended", status: "error", error } : { type: "turn_ended", status: "success" })}\n`,
    );
    return t;
  };
  const input = (o: Record<string, unknown>) =>
    JSON.stringify({
      conversation_id: CHAT,
      hook_event_name: "stop",
      cursor_version: "3.23.23",
      workspace_roots: ["/work/shop"],
      user_email: "person@example.com",
      ...o,
    });
  /** The hook with a fake clock: each wait moves time on, and `during` runs once, mid-wait. */
  const handler = (during?: () => void) =>
    cursorHooks({
      closed: () => deps(),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        during?.();
        during = undefined;
      },
      waitMs: 60 * 60_000,
    });

  it("a normal turn ends at once", async () => {
    const out = await runHook(
      handler(),
      "stop",
      input({ status: "completed", transcript_path: transcript() }),
      {},
      state,
      clock,
    );
    expect(out).toBe("{}");
    expect(notes).toEqual([]);
  });

  it("at a limit: says how to continue, waits for the chosen time, then continues the same chat", async () => {
    const choose = () => {
      // The person ran `agent-rewake continue` and picked 20 minutes from now.
      const r = new SessionRecords(state, CURSOR_ID).get(CHAT);
      if (r) armClosed(cursorHost, r, NOW + 20 * 60_000, deps(clock));
    };
    const out = await runHook(
      handler(choose),
      "stop",
      input({ status: "error", transcript_path: transcript(LIMIT) }),
      {},
      state,
      clock,
    );
    expect(notes[0]).toBe(
      'Cursor in the "shop" folder hit its usage limit. Run "agent-rewake continue" and choose when to continue it.',
    );
    expect(JSON.parse(out ?? "{}").followup_message).toMatch(
      /^Resume the work from where you were interrupted\. Agent Rewake sent this message/,
    );
    expect(clock).toBeGreaterThanOrEqual(NOW + 20 * 60_000);
    expect(new ScheduleStore(state).list()[0]?.status).toBe("sent");
    // The timer only follows up, a few minutes after the time.
    expect(armed[0]?.[1]).toBe(NOW + 20 * 60_000 + 3 * 60_000);
  });

  it("stays silent when the person typed in the chat meanwhile", async () => {
    const typed = () => {
      const r = new SessionRecords(state, CURSOR_ID).get(CHAT);
      if (r) armClosed(cursorHost, r, NOW + 10 * 60_000, deps(clock));
      void runHook(
        handler(),
        "beforeSubmitPrompt",
        input({ hook_event_name: "beforeSubmitPrompt" }),
        {},
        state,
        clock,
      );
    };
    const out = await runHook(
      handler(typed),
      "stop",
      input({ status: "error", transcript_path: transcript(LIMIT) }),
      {},
      state,
      clock,
    );
    expect(out).toBe("{}");
    expect(new ScheduleStore(state).list()[0]?.status).toBe("cancelled");
  });

  it("never waits for a limit that waiting won't lift, says so, and never stores the email", async () => {
    const free = await runHook(
      handler(),
      "stop",
      input({ status: "error", transcript_path: transcript(FREE) }),
      {},
      state,
      clock,
    );
    expect(free).toBe("{}");
    expect(notes).toEqual([
      "Cursor in the \"shop\" folder hit a usage limit that waiting won't lift (it needs a paid plan, more usage or a new month), so Rewake can't continue it. Continue the chat in Cursor when you can.",
    ]);
    const out = await runHook(
      handler(),
      "stop",
      input({ status: "error", transcript_path: transcript("Add a payment method to continue") }),
      {},
      state,
      clock,
    );
    expect(out).toBe("{}");
    const files = readdirSync(join(state, "hosts", CURSOR_ID, "sessions"));
    const text = files
      .map((f) => readFileSync(join(state, "hosts", CURSOR_ID, "sessions", f), "utf8"))
      .join("");
    expect(text).not.toContain("person@example.com");
  });

  it.each([
    [
      "the Pro plan's remedy",
      "You've hit your usage limit\nSwitch to Auto for more usage or set a Spend Limit to continue with Sonnet.",
    ],
    [
      "a free plan's monthly allowance",
      "You've hit your free requests limit. Your usage limits will reset when your monthly cycle ends on 10/2/2026.",
    ],
    ["a free plan's upgrade offer", FREE],
  ])("never offers to wait for %s", (_name, text) => {
    expect(classifyCursorError(text)).toEqual({ kind: "billing", billing: true });
  });

  it("still waits for a plain rate limit that says nothing of a plan", () => {
    expect(classifyCursorError("You've hit your rate limit. Please try again later.")).toEqual({
      kind: "other",
      billing: false,
    });
  });

  it("ignores events from other agents", async () => {
    const out = await runHook(
      handler(),
      "stop",
      JSON.stringify({ conversation_id: CHAT, status: "error" }),
      {},
      state,
      clock,
    );
    expect(out).toBeUndefined();
  });

  it("tells the person when its window was closed at the time", () => {
    expect(
      notice("failed", 'Cursor in the "shop" folder', NOW, {
        noun: "chat",
        agentName: "Cursor",
        reopen: "open the chat in Cursor",
        cause: "window-closed",
      }),
    ).toBe(
      'Cursor in the "shop" folder: the time you chose has come, but Rewake couldn\'t continue the chat (was its window closed or reloaded?). Open the chat in Cursor to continue.',
    );
  });
  it("says so, truthfully, when the chosen time is later than it can wait", async () => {
    const choose = () => {
      const r = new SessionRecords(state, CURSOR_ID).get(CHAT);
      if (r) armClosed(cursorHost, r, NOW + 2 * 60 * 60_000, deps(clock));
    };
    const out = await runHook(
      handler(choose),
      "stop",
      input({ status: "error", transcript_path: transcript(LIMIT) }),
      {},
      state,
      clock,
    );
    expect(out).toBe("{}");
    expect(new ScheduleStore(state).list()[0]).toMatchObject({
      status: "failed",
      failureReason: "too-late",
    });
    expect(notes[1]).toMatch(
      /^Cursor in the "shop" folder: Rewake can continue a Cursor chat only within 4 hours of its usage limit, so it won't continue this one /,
    );
    expect(notes.join(" ")).not.toContain("window was closed");
  });

  describe("/rewake typed into the chat", () => {
    const atLimit = (text = LIMIT) => {
      const limit = recogniseForHost({ agent: "cursor", source: "hook", text }, clock);
      if (!limit) throw new Error("not recognised");
      onLimit(cursorHost, CHAT, "/work/shop", limit, deps(clock), transcript(text));
      onSessionEnd(cursorHost, CHAT, "/work/shop", deps(clock));
      notes.length = 0;
      armed.length = 0;
    };
    const type = async (prompt: string) =>
      JSON.parse(
        (await runHook(
          handler(),
          "beforeSubmitPrompt",
          input({ hook_event_name: "beforeSubmitPrompt", prompt }),
          {},
          state,
          clock,
        )) ?? "{}",
      ) as { continue?: boolean; user_message?: string };

    it("says there's nothing to continue before any limit", async () => {
      expect((await type("/rewake")).user_message).toBe(
        "Rewake: this chat isn't at a usage limit, so there's nothing to continue.",
      );
    });

    it("says it doesn't know the reset time yet when the limit gave none", async () => {
      atLimit();
      const r = await type("/rewake");
      expect(r.continue).toBe(false);
      expect(r.user_message).toBe("Rewake doesn't know when this resets yet. Try /rewake 3:30pm.");
    });

    it("says when its history is large", async () => {
      atLimit();
      new SessionRecords(state, CURSOR_ID).update(CHAT, "/work/shop", clock, (x) => ({
        ...x,
        historyBytes: 7 * 1024 * 1024,
      }));
      const r = await type("/rewake in 1h");
      expect(r.user_message).toMatch(
        / This chat is large \(about 7 MB of history\); continuing it re-reads that and uses your plan\.$/,
      );
    });

    it("arms a continue at a chosen time, within 4 hours, and the slash is optional", async () => {
      atLimit();
      const r = await type("/rewake in 1h");
      expect(r.user_message).toMatch(/^Rewake will continue this chat /);
      expect(armed[0]?.[1]).toBe(NOW + 60 * 60_000 + 3 * 60_000);
      const again = await type("rewake in 1h");
      expect(again.user_message).toMatch(/^Rewake will continue this chat /);
    });

    it("refuses a time more than 4 hours after the limit", async () => {
      atLimit();
      const r = await type("/rewake in 5h");
      expect(r.user_message).toContain("only continue a Cursor chat within 4 hours");
      expect(armed).toEqual([]);
    });

    it("refuses to continue a limit that waiting won't lift", async () => {
      atLimit(FREE);
      const r = await type("/rewake");
      expect(r.user_message).toBe(
        "Rewake can't continue after this limit: this limit is about credits or spending, which waiting doesn't fix.",
      );
    });

    it("lists what's planned, and says when nothing is", async () => {
      atLimit();
      expect((await type("/rewake list")).user_message).toBe(
        "Rewake: Nothing is set to continue this chat. At a usage limit, type /rewake to continue after the reset.",
      );
      await type("/rewake in 1h");
      const r = await type("/rewake list");
      expect(r.user_message).toMatch(
        /^Rewake will continue this chat .* To cancel: \/rewake cancel$/,
      );
    });

    it("cancels what's planned", async () => {
      atLimit();
      await type("/rewake in 1h");
      const cancelled = await type("/rewake cancel");
      expect(cancelled.user_message).toBe(
        "Rewake: Cancelled. This chat won't be continued on its own.",
      );
      const again = await type("/rewake cancel");
      expect(again.user_message).toBe("Rewake: Nothing is set to continue this chat.");
    });

    it("doesn't match ordinary text, so it falls through to the usual typed-in-chat handling", async () => {
      const out = await runHook(
        handler(),
        "beforeSubmitPrompt",
        input({ hook_event_name: "beforeSubmitPrompt", prompt: "please rewrite this function" }),
        {},
        state,
        clock,
      );
      expect(out).toBeUndefined();
    });
  });
});

describe("agent-rewake continue, for a Cursor chat", () => {
  const limited = (seenAt: number, now: number) => {
    const d: ClosedDeps = {
      stateDir: state,
      now,
      env: {},
      arm: () => {},
      disarm: () => {},
      notify: () => {},
    };
    const limit = recogniseForHost({ agent: "cursor", source: "hook", text: LIMIT }, seenAt);
    if (!limit) throw new Error("not recognised");
    onLimit(cursorHost, CHAT, "/work/shop", limit, { ...d, now: seenAt });
    onSessionEnd(cursorHost, CHAT, "/work/shop", { ...d, now: seenAt });
    return d;
  };
  const run = async (d: ClosedDeps, answers: string[]) => {
    const out: string[] = [];
    const code = await runContinue({
      hosts: [cursorHost],
      deps: d,
      interactive: true,
      out: (t) => out.push(t),
      ask: async () => answers.shift() ?? "",
    });
    return { code, text: out.join("") };
  };

  it("offers only times within 4 hours of the limit, and refuses a later one", async () => {
    const d = limited(NOW, NOW + 30 * 60_000);
    const { text } = await run(d, [""]);
    expect(text).toContain("(It can wait until");
    expect(text).toContain("1. In 1 hour");
    expect(text).toContain("2. In 3 hours");
    expect(text).not.toContain("In 5 hours");
    expect(text).toContain("3. Another time");
    const later = await run(d, ["3", "in 4h"]);
    expect(later.code).toBe(1);
    expect(later.text).toContain("4 hours after its usage limit. Choose an earlier time");
    expect(new ScheduleStore(state).list()).toEqual([]);
    const ok = await run(d, ["1"]);
    expect(ok.code).toBe(0);
    expect(ok.text).toContain("Keep that Cursor window open until then");
    expect(ok.text).toContain("Typing in the chat before then cancels this continue.");
    expect(ok.text).not.toContain("--always");
  });

  it("says when the 4 hours have passed", async () => {
    const d = limited(NOW, NOW + 4 * 60 * 60_000);
    const { code, text } = await run(d, []);
    expect(code).toBe(1);
    expect(text).toContain("only within 4 hours of its usage limit, and that time has passed");
  });
});
