import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { runContinue } from "../src/continue.js";
import { MAX_REARMS } from "../src/core/resume.js";
import { registerHost, type Schedule, ScheduleStore } from "../src/core/store.js";
import { formatAt } from "../src/core/time.js";
import type { ClosedDeps } from "../src/hosts/closed.js";
import type { HostAdapter, HostFacts, SendResult } from "../src/hosts/host.js";
import { type FireDeps, fire } from "../src/timers/fire.js";
import type { TimerHost } from "../src/timers/timers.js";
import { explainSchedule } from "../src/ui/overview.js";

registerHost("test");

const NOW = Date.parse("2026-10-07T12:00:00Z");
const H = 3_600_000;

let dir: string;
let store: ScheduleStore;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-now-")));
  store = new ScheduleStore(join(dir, "state"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A planned resume of the stand-in agent, due in two hours. */
function planned(sessionId: string, folder: string, extra: Partial<Schedule> = {}): Schedule {
  const s = store.create({
    sessionId,
    cwd: `/work/${folder}`,
    text: "Continue where you left off.",
    dueAt: NOW + 2 * H,
    kind: "limit_resume",
    createdBy: "auto",
    now: NOW - H,
  });
  store.put({ ...s, host: "test", sessionRef: { threadId: sessionId }, ...extra });
  return store.get(s.scheduleId) as Schedule;
}

interface Setup {
  facts?: HostFacts;
  send?: SendResult;
}

/** Runs `continue --now` against a stand-in agent whose timer calls and sends are recorded. */
function harness(o: Setup = {}) {
  const sent: string[] = [];
  const notes: string[] = [];
  const calls: string[][] = [];
  const host: HostAdapter = {
    id: "test",
    name: "Codex",
    noun: "thread",
    check: async () => o.facts ?? {},
    send: async (_s, key) => {
      sent.push(key);
      return o.send ?? { ok: true };
    },
  };
  const timers: TimerHost = {
    platform: "linux",
    stateDir: join(dir, "state"),
    node: "/n",
    cli: "/c.mjs",
    run: (command, args) => {
      calls.push([command, ...args]);
      return {
        status: 0,
        stdout: args.includes("is-system-running") ? "running\n" : "",
        stderr: "",
      };
    },
    detached: () => {},
    exists: () => true,
    uid: () => 1000,
  };
  const fireDeps: FireDeps = {
    stateDir: join(dir, "state"),
    now: () => NOW,
    hosts: new Map([["test", host]]),
    timers,
    notify: (_t, body) => {
      notes.push(body);
      return true;
    },
    immediate: true,
  };
  const closed: ClosedDeps = {
    stateDir: join(dir, "state"),
    now: NOW,
    env: {},
    arm: () => undefined,
    disarm: () => undefined,
    notify: () => undefined,
  };
  async function now(
    o2: { nowId?: string; yes?: boolean; interactive?: boolean } = {},
    answers: string[] = [],
  ) {
    let output = "";
    let errors = "";
    const asked: string[] = [];
    const code = await runContinue({
      mode: "now",
      ...(o2.nowId !== undefined && { nowId: o2.nowId }),
      yes: o2.yes ?? false,
      hostOf: (id) => (id === "test" ? { name: "Codex", noun: "thread" } : undefined),
      hosts: [],
      deps: closed,
      interactive: o2.interactive ?? true,
      fireNow: (id) => fire(id, fireDeps),
      out: (t) => {
        output += t;
      },
      err: (t) => {
        errors += t;
      },
      ask: async (q) => {
        asked.push(q);
        return answers.shift() ?? "";
      },
    });
    return { code, output, errors, asked };
  }
  return { now, sent, notes, calls, fireDeps };
}

const idOf = (s: Schedule) => s.scheduleId.slice(0, 8);

describe("continue --now <id>", () => {
  it("resumes that one before its time, with --yes and no question, and removes its timer", async () => {
    const shop = planned("thread-shop", "shop");
    const cafe = planned("thread-cafe", "cafe");
    const h = harness();
    const r = await h.now({ nowId: idOf(shop), yes: true });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
    expect(r.output).toContain('Codex in the "shop" folder');
    expect(r.output).toContain("Rewake continued");
    expect(h.sent).toEqual([`${shop.scheduleId}:${shop.dueAt}`]);
    expect(store.get(shop.scheduleId)?.status).toBe("sent");
    expect(store.get(cafe.scheduleId)).toEqual(cafe);
    expect(h.calls.at(-1)).toEqual([
      "systemctl",
      "--user",
      "stop",
      `codizelabs-agent-rewake-${shop.scheduleId}.timer`,
    ]);
  });

  it("says what will be sent, to which session and folder, and sends nothing on No", async () => {
    const shop = planned("thread-shop", "shop");
    const h = harness();
    const r = await h.now({ nowId: idOf(shop).toUpperCase() }, ["n"]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Rewake will continue Codex in the "shop" folder now');
    expect(r.output).not.toContain("thread-shop");
    expect(r.output).toContain('"Continue where you left off."');
    expect(r.asked).toEqual(["Continue it now? [y/N] "]);
    expect(r.output).toContain("Nothing was changed.");
    expect(h.sent).toEqual([]);
    expect(store.get(shop.scheduleId)).toEqual(shop);
  });

  it("treats Enter as No, and y as Yes", async () => {
    const shop = planned("thread-shop", "shop");
    const h = harness();
    expect((await h.now({ nowId: idOf(shop) }, [""])).code).toBe(1);
    expect(h.sent).toEqual([]);
    expect((await h.now({ nowId: idOf(shop) }, ["y"])).code).toBe(0);
    expect(h.sent).toHaveLength(1);
  });

  it("says when no planned resume has that id, and changes nothing", async () => {
    const shop = planned("thread-shop", "shop");
    const h = harness();
    const r = await h.now({ nowId: "zzzzzzzz", yes: true });
    expect(r.code).toBe(1);
    expect(r.errors).toContain('No planned resume starts with "zzzzzzzz"');
    expect(h.sent).toEqual([]);
    expect(store.get(shop.scheduleId)).toEqual(shop);
  });

  it("sends a Zed thread's message to its own menu, and sends nothing", async () => {
    const zed = store.create({
      sessionId: "zed-thread",
      cwd: "/work/shop",
      text: "Run the tests",
      dueAt: NOW + H,
      createdBy: "command",
      now: NOW,
    });
    const h = harness();
    const r = await h.now({ nowId: idOf(zed), yes: true });
    expect(r.code).toBe(1);
    expect(r.errors).toContain("Zed thread");
    expect(store.get(zed.scheduleId)?.status).toBe("scheduled");
  });

  it("is once only: a second --now sends nothing", async () => {
    const shop = planned("thread-shop", "shop");
    const h = harness();
    expect((await h.now({ nowId: idOf(shop), yes: true })).code).toBe(0);
    const again = await h.now({ nowId: idOf(shop), yes: true });
    expect(again.code).toBe(0);
    expect(again.output).toContain("was already sent");
    expect(h.sent).toHaveLength(1);
  });

  it("leaves a cancelled resume alone", async () => {
    const shop = planned("thread-shop", "shop");
    store.cancel(shop.scheduleId, NOW);
    const h = harness();
    const r = await h.now({ nowId: idOf(shop), yes: true });
    expect(r.output).toContain("was cancelled");
    expect(h.sent).toEqual([]);
  });

  it("leaves a resume already being sent alone", async () => {
    const shop = planned("thread-shop", "shop", { status: "sending" });
    const h = harness();
    const r = await h.now({ nowId: idOf(shop), yes: true });
    expect(r.code).toBe(1);
    expect(r.output).toContain("already continuing");
    expect(h.sent).toEqual([]);
  });

  const STILL_ON =
    "The usage limit is still on, so nothing was sent. Your resume is still planned for ";

  /** The stored resume without its edit time: a run that found the limit on must change nothing else. */
  const same = (id: string) => {
    const { updatedAt: _t, ...rest } = store.get(id) as Schedule;
    return rest;
  };

  /** What the resume's own timer does at its time, with a healthy agent. */
  async function timerFire(s: Schedule, setup: Setup = {}) {
    const ok = harness(setup);
    const { immediate: _on, ...plain } = ok.fireDeps;
    const outcome = await fire(s.scheduleId, { ...plain, now: () => s.dueAt });
    return { outcome, sent: ok.sent, status: store.get(s.scheduleId)?.status };
  }

  const LIMITED_CASES: [string, Setup][] = [
    ["no reset known", { facts: { usageAllowed: false } }],
    ["a stated reset", { facts: { usageAllowed: false, newResetsAt: NOW + 3 * H } }],
    ["a reset more than a day away", { facts: { usageAllowed: false, newResetsAt: NOW + 48 * H } }],
    ["the send comes back limited", { send: { ok: false, reason: "limited" } }],
    [
      "the send comes back limited with a reset",
      { send: { ok: false, reason: "limited", resetsAt: NOW + 3 * H } },
    ],
    [
      "the send comes back limited with a reset more than a day away",
      { send: { ok: false, reason: "limited", resetsAt: NOW + 48 * H } },
    ],
  ];

  for (const [name, setup] of LIMITED_CASES)
    it(`leaves the plan alone when the limit is still on: ${name}`, async () => {
      const shop = planned("thread-shop", "shop", { rearms: 2 });
      const before = same(shop.scheduleId);
      const h = harness(setup);
      // Four times in a row: nothing drifts, nothing is counted, nothing fails.
      for (let i = 0; i < 4; i++) {
        const r = await h.now({ nowId: idOf(shop), yes: true });
        expect(r.code).toBe(0);
        expect(r.output).toContain(`${STILL_ON}${formatAt(shop.dueAt, NOW)}.`);
        expect(same(shop.scheduleId)).toEqual(before);
      }
      expect(store.get(shop.scheduleId)?.status).toBe("scheduled");
      expect(h.notes).toEqual([]);
      // No timer was moved.
      expect(h.calls.some((c) => c[0] === "systemd-run")).toBe(false);
      // The timer's own run at the planned time still sends it, once.
      const t = await timerFire(store.get(shop.scheduleId) as Schedule);
      expect(t.outcome).toBe("sent");
      expect(t.sent).toHaveLength(1);
    });

  const KEPT_CASES: [string, Setup, string, string, string][] = [
    [
      "the session is open",
      { facts: { sessionOpen: true } },
      "is open, so nothing was sent",
      "notified",
      "needs_attention",
    ],
    [
      "the session changed since the limit",
      { facts: { changedSince: true } },
      "has changed since it stopped, so nothing was sent",
      "notified",
      "needs_attention",
    ],
    [
      "the person typed after the limit",
      { facts: { userTypedSince: true } },
      "You typed in the thread after the limit, so nothing was sent",
      "skipped",
      "stopped",
    ],
    [
      "the agent continued by itself",
      { facts: { nativeContinued: true } },
      "The agent has already continued by itself, so nothing was sent",
      "skipped",
      "stopped",
    ],
  ];

  for (const [name, setup, said, timerOutcome, timerStatus] of KEPT_CASES)
    it(`leaves the plan and its timer alone when ${name}`, async () => {
      const shop = planned("thread-shop", "shop", { rearms: 1 });
      const before = same(shop.scheduleId);
      const h = harness(setup);
      for (let i = 0; i < 2; i++) {
        const r = await h.now({ nowId: idOf(shop), yes: true });
        expect(r.code).toBe(1);
        expect(r.output).toContain(said);
        expect(r.output).toContain(formatAt(shop.dueAt, NOW));
        expect(same(shop.scheduleId)).toEqual(before);
      }
      expect(h.sent).toEqual([]);
      expect(h.notes).toEqual([]);
      // Its timer wasn't stopped or moved.
      expect(h.calls.some((c) => c[0] === "systemd-run" || c.includes("stop"))).toBe(false);
      // The timer's own run behaves as it always did with the same facts...
      const t = await timerFire(store.get(shop.scheduleId) as Schedule, setup);
      expect(t.outcome).toBe(timerOutcome);
      expect(t.status).toBe(timerStatus);
      expect(t.sent).toEqual([]);
    });

  it("a plan kept after the session was open still sends at its time once it is closed", async () => {
    const shop = planned("thread-shop", "shop");
    await harness({ facts: { sessionOpen: true } }).now({ nowId: idOf(shop), yes: true });
    const t = await timerFire(store.get(shop.scheduleId) as Schedule);
    expect(t.outcome).toBe("sent");
  });

  it("leaves the plan alone when the message could not reach the agent", async () => {
    const shop = planned("thread-shop", "shop");
    const before = same(shop.scheduleId);
    const h = harness({ send: { ok: false, reason: "failed", detail: "signed-out" } });
    const r = await h.now({ nowId: idOf(shop), yes: true });
    expect(r.code).toBe(1);
    expect(h.notes.join("\n")).toContain("signed out");
    expect(r.output).toContain("Your resume is still planned for");
    expect(same(shop.scheduleId)).toEqual(before);
    expect(h.calls.some((c) => c.includes("stop"))).toBe(false);
  });

  it("leaves a resume that was already tried several times alone, not failed", async () => {
    const shop = planned("thread-shop", "shop", { rearms: MAX_REARMS });
    const before = same(shop.scheduleId);
    const h = harness({ facts: { usageAllowed: false } });
    const r = await h.now({ nowId: idOf(shop), yes: true });
    expect(r.code).toBe(0);
    expect(same(shop.scheduleId)).toEqual(before);
  });

  it("keeps the window busy notice and the Ctrl+C line in what it shows first", async () => {
    const shop = planned("thread-shop", "shop");
    const r = await harness().now({ nowId: idOf(shop) }, ["n"]);
    expect(r.output).toContain(
      "This window stays busy until the agent finishes (up to 3 hours); waiting for a free place to run can take a few minutes. Ctrl+C stops it and cancels this planned resume.",
    );
    expect(r.output).toContain("Nothing is sent, and your resume stays planned for its time, if");
    expect(r.output).not.toContain("Folder:");
    expect(r.output).not.toContain("/work/shop");
  });

  it("names the full path only for resumes in two folders of the same name", async () => {
    planned("thread-a", "one/shop");
    planned("thread-b", "two/shop");
    planned("thread-c", "cafe");
    const r = await harness().now({}, [""]);
    expect(r.output).toContain("(/work/one/shop)");
    expect(r.output).toContain("(/work/two/shop)");
    expect(r.output).not.toContain("(/work/cafe)");
  });

  it("doesn't continue a Cursor chat from here, and changes nothing", async () => {
    const chat = planned("chat-1", "shop", { host: "cursor" });
    const h = harness();
    let output = "";
    const code = await runContinue({
      mode: "now",
      nowId: idOf(chat),
      yes: true,
      hosts: [
        {
          id: "cursor",
          name: "Cursor",
          noun: "chat",
          reopen: "open the chat in Cursor",
          maxWaitAfterLimitMs: 4 * H - 60_000,
          resume: async () => ({ ok: false, reason: "failed", detail: "window-closed" }),
        },
      ],
      deps: {
        stateDir: join(dir, "state"),
        now: NOW,
        env: {},
        arm: () => undefined,
        disarm: () => undefined,
        notify: () => undefined,
      },
      interactive: true,
      fireNow: (id) => fire(id, h.fireDeps),
      out: (t) => {
        output += t;
      },
      ask: async () => "y",
    });
    expect(code).toBe(1);
    expect(output).toContain("within 4 hours of its usage limit");
    expect(store.get(chat.scheduleId)).toEqual(chat);
    expect(h.sent).toEqual([]);
  });
});

describe("continue --now with no id", () => {
  it("with one planned, names it and asks", async () => {
    const shop = planned("thread-shop", "shop");
    const h = harness();
    const r = await h.now({}, ["y"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Rewake will continue Codex in the "shop" folder now');
    expect(r.asked).toEqual(["Continue it now? [y/N] "]);
    expect(store.get(shop.scheduleId)?.status).toBe("sent");
  });

  it("with one planned and --yes, doesn't ask", async () => {
    planned("thread-shop", "shop");
    const h = harness();
    const r = await h.now({ yes: true });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
    expect(h.sent).toHaveLength(1);
  });

  it("with several, lists them to pick one, then asks", async () => {
    const shop = planned("thread-shop", "shop");
    const cafe = planned("thread-cafe", "cafe");
    const h = harness();
    const r = await h.now({}, ["2", "y"]);
    expect(r.output).toContain("Planned resumes:");
    expect(r.output).toContain(`[${idOf(shop)}]`);
    expect(r.output).toContain(`[${idOf(cafe)}]`);
    expect(r.asked[0]).toContain("Which one should Rewake continue now? (1-2");
    const list = store.list();
    const picked = list.filter((s) => s.status === "sent");
    expect(picked).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(list.filter((s) => s.status === "scheduled")).toHaveLength(1);
  });

  it("with several, sends nothing on Enter or on a number out of range", async () => {
    planned("thread-shop", "shop");
    planned("thread-cafe", "cafe");
    const h = harness();
    expect((await h.now({}, [""])).output).toContain("Nothing was changed.");
    expect((await h.now({}, ["9"])).output).toContain("Nothing was changed.");
    expect(h.sent).toEqual([]);
  });

  it("with only a Cursor chat planned, says why it can't be continued from here", async () => {
    planned("chat-1", "shop", { host: "cursor" });
    const h = harness();
    let output = "";
    const code = await runContinue({
      mode: "now",
      hosts: [
        {
          id: "cursor",
          name: "Cursor",
          noun: "chat",
          maxWaitAfterLimitMs: 4 * H - 60_000,
          resume: async () => ({ ok: false, reason: "failed", detail: "window-closed" }),
        },
      ],
      deps: {
        stateDir: join(dir, "state"),
        now: NOW,
        env: {},
        arm: () => undefined,
        disarm: () => undefined,
        notify: () => undefined,
      },
      interactive: true,
      fireNow: (id) => fire(id, h.fireDeps),
      out: (t) => {
        output += t;
      },
      ask: async () => "y",
    });
    expect(code).toBe(0);
    expect(output).toContain("Nothing here can be continued now: Cursor can only be continued");
    expect(output).not.toContain("isn't set to continue");
  });

  it("with none planned, says so", async () => {
    const h = harness();
    const r = await h.now({});
    expect(r.code).toBe(0);
    expect(r.output).toContain("Nothing to resume now");
  });
});

describe("continue --now without a terminal", () => {
  it("refuses without --yes, with or without an id, and sends nothing", async () => {
    const shop = planned("thread-shop", "shop");
    const h = harness();
    for (const o of [{ nowId: idOf(shop) }, {}, { yes: true }]) {
      const r = await h.now({ ...o, interactive: false });
      expect(r.code).toBe(1);
      expect(r.errors).toContain("continue --now <id> --yes");
    }
    expect(h.sent).toEqual([]);
    expect(store.get(shop.scheduleId)).toEqual(shop);
  });

  it("goes ahead with the id and --yes", async () => {
    const shop = planned("thread-shop", "shop");
    const h = harness();
    const r = await h.now({ nowId: idOf(shop), yes: true, interactive: false });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
    expect(h.sent).toHaveLength(1);
  });
});

describe("fire, asked to run now", () => {
  it("is the only thing that skips the wait: without it an early run does nothing", async () => {
    const shop = planned("thread-shop", "shop");
    const h = harness();
    const { immediate: _on, ...plain } = h.fireDeps;
    expect(await fire(shop.scheduleId, plain)).toBe("early");
    expect(h.sent).toEqual([]);
    expect(await fire(shop.scheduleId, h.fireDeps)).toBe("sent");
    expect(h.sent).toHaveLength(1);
  });

  it("doesn't count a resume overdue by hours as too late when the person asked", async () => {
    const shop = planned("thread-shop", "shop", { dueAt: NOW - 5 * H });
    const h = harness();
    expect(await fire(shop.scheduleId, h.fireDeps)).toBe("sent");
  });
});

describe("agent-rewake continue --now", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    mkdirSync(join(dir, "zed"));
    mkdirSync(join(dir, "home"));
    env = {
      AGENT_REWAKE_ZED_CONFIG_DIR: join(dir, "zed"),
      AGENT_REWAKE_ZED_DATA_DIR: join(dir, "data"),
      AGENT_REWAKE_STATE_DIR: join(dir, "state"),
      HOME: dir,
      USERPROFILE: dir,
      PATH: process.env.PATH ?? "",
    };
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function run(argv: string[]): Promise<{ code: number; text: string }> {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    const code = await main(argv, env);
    vi.restoreAllMocks();
    return { code, text: out.join("") };
  }

  it("takes --now with an id and --yes, in either order", async () => {
    for (const argv of [
      ["continue", "--now", "zzzzzzzz", "--yes"],
      ["continue", "--yes", "--now", "zzzzzzzz"],
      ["continue", "--now", "-y", "zzzzzzzz"],
    ]) {
      const r = await run(argv);
      expect(r.code).toBe(1);
      expect(r.text).toContain('No planned resume starts with "zzzzzzzz"');
    }
  });

  it("refuses without a terminal and without --yes", async () => {
    const r = await run(["continue", "--now", "zzzzzzzz"]);
    expect(r.code).toBe(1);
    expect(r.text).toContain("continue --now <id> --yes");
  });

  it("takes one id at most, and --yes only with --now", async () => {
    expect((await run(["continue", "--now", "a", "b"])).code).toBe(2);
    expect((await run(["continue", "--now", "--always"])).code).toBe(2);
    const alone = await run(["continue", "--yes"]);
    expect(alone.code).toBe(2);
    expect(alone.text).toContain("--now [<id>] [--yes]");
  });
});

describe("schedules --explain", () => {
  it("names the command that resumes it now, for a resume outside Zed only", () => {
    const shop = planned("thread-shop", "shop");
    const hostOf = (h: string) => (h === "test" ? { name: "Codex", noun: "thread" } : undefined);
    const r = explainSchedule(join(dir, "state"), idOf(shop), NOW, hostOf, "en-US");
    expect(r.ok && r.text).toContain(`agent-rewake continue --now ${idOf(shop)}`);
    const zed = store.create({
      sessionId: "zed-thread",
      cwd: "/work/shop",
      text: "Run the tests",
      dueAt: NOW + H,
      createdBy: "command",
      now: NOW,
    });
    const z = explainSchedule(join(dir, "state"), idOf(zed), NOW, hostOf, "en-US");
    expect(z.ok && z.text).not.toContain("--now");
  });
});
