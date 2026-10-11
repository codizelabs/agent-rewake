import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { runContinue } from "../src/continue.js";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { registerHost, type Schedule, ScheduleStore } from "../src/core/store.js";
import type { ClosedDeps } from "../src/hosts/closed.js";
import { copilotHooks, copilotHost } from "../src/hosts/copilot/host.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js"; // registers the hosts

const FAKE = fileURLToPath(new URL("./fixtures/fake-copilot.mjs", import.meta.url));
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const SHOP = "8a3c1f2e-0b5d-4c7a-9e21-3f6b8d0c4a17";
const CAFE = "5d2e9b10-7c4f-4a3b-8e6d-1f0a2b3c4d5e";
/** Resets at 15:00 today in any time zone. */
const WEEKLY_IN =
  "You've reached your weekly rate limit. Please wait for your limit to reset in 3 hours or switch to auto model to continue.";
const SENDING =
  'Not cancelled: Rewake is already continuing GitHub Copilot CLI in the "shop" folder. It finishes on its own; resume the session with "copilot --resume" afterwards to see what it did.\n';

let dir: string;
let state: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-cancel-one-")));
  state = join(dir, "state");
  mkdirSync(join(dir, "shop"));
  mkdirSync(join(dir, "cafe"));
  chmodSync(FAKE, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness() {
  saveSettings(state, DEFAULT_SETTINGS);
  const armed: [string, number][] = [];
  const disarmed: string[] = [];
  const deps = (env: NodeJS.ProcessEnv = {}, now = NOW): ClosedDeps => ({
    stateDir: state,
    now,
    env,
    arm: (id, at) => armed.push([id, at]),
    disarm: (id) => disarmed.push(id),
    notify: () => undefined,
    agent: () => undefined,
    running: () => true,
  });
  const handler = copilotHooks({ closed: (ctx) => deps(ctx.env, ctx.now), program: () => FAKE });
  const event = (sessionId: string, folder: string, name: string, input: Record<string, unknown>) =>
    runHook(
      handler,
      name,
      JSON.stringify({ sessionId, timestamp: NOW, cwd: join(dir, folder), ...input }),
      {},
      state,
      NOW,
    );
  return { armed, disarmed, deps, event };
}
type Harness = ReturnType<typeof harness>;

/** A Copilot session in this folder stops at its limit and closes. */
async function limited(h: Harness, sessionId: string, folder: string) {
  await h.event(sessionId, folder, "sessionStart", { source: "startup" });
  await h.event(sessionId, folder, "errorOccurred", { error: { message: WEEKLY_IN } });
  await h.event(sessionId, folder, "sessionEnd", { reason: "error" });
}

async function cont(
  h: Harness,
  o: {
    mode?: "cancel";
    cancelId?: string;
    hostOf?: (id: string) => { name: string; noun?: string } | undefined;
  } = {},
  answers: string[] = [],
) {
  let output = "";
  const asked: string[] = [];
  const code = await runContinue({
    ...o,
    hosts: [copilotHost],
    deps: h.deps(),
    interactive: true,
    out: (t) => {
      output += t;
    },
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
  });
  return { code, output, asked };
}

/** Two closed Copilot sessions, each with a planned resume: "shop" and "cafe". */
async function twoPending() {
  const h = harness();
  await limited(h, SHOP, "shop");
  await cont(h);
  await limited(h, CAFE, "cafe");
  await cont(h);
  const store = new ScheduleStore(state);
  const list = store.list();
  const shop = list.find((s) => s.sessionId === SHOP) as Schedule;
  const cafe = list.find((s) => s.sessionId === CAFE) as Schedule;
  expect(shop?.status).toBe("scheduled");
  expect(cafe?.status).toBe("scheduled");
  h.disarmed.length = 0;
  return { h, store, shop, cafe };
}

describe("continue --cancel <id>", () => {
  it("cancels only the resume whose id starts with it", async () => {
    const { h, store, shop, cafe } = await twoPending();
    const r = await cont(h, { mode: "cancel", cancelId: shop.scheduleId.slice(0, 8) });
    expect(r.code).toBe(0);
    expect(r.output.startsWith("Cancelled: ")).toBe(true);
    expect(r.output).toContain('"shop"');
    expect(store.get(shop.scheduleId)?.status).toBe("cancelled");
    expect(store.get(cafe.scheduleId)).toEqual(cafe);
    expect(h.disarmed).toEqual([shop.scheduleId]);
  });

  it("reads the id in any case", async () => {
    const { h, store, shop, cafe } = await twoPending();
    const r = await cont(h, {
      mode: "cancel",
      cancelId: cafe.scheduleId.slice(0, 8).toUpperCase(),
    });
    expect(r.code).toBe(0);
    expect(store.get(cafe.scheduleId)?.status).toBe("cancelled");
    expect(store.get(shop.scheduleId)?.status).toBe("scheduled");
  });

  it("leaves a resume that is already being sent, with the same words as --cancel", async () => {
    const { h, store, shop, cafe } = await twoPending();
    store.update(shop.scheduleId, (x) => ({ ...x, status: "sending" }), NOW);
    const r = await cont(h, { mode: "cancel", cancelId: shop.scheduleId.slice(0, 8) });
    expect(r.code).toBe(1);
    expect(r.output).toBe(SENDING);
    expect(store.get(shop.scheduleId)?.status).toBe("sending");
    expect(store.get(cafe.scheduleId)?.status).toBe("scheduled");
    expect(h.disarmed).toEqual([]);
  });

  it("says when no planned resume has that id", async () => {
    const { h, store } = await twoPending();
    const before = store.list();
    const r = await cont(h, { mode: "cancel", cancelId: "zzzzzzzz" });
    expect(r.code).toBe(1);
    expect(r.output).toContain('No planned resume starts with "zzzzzzzz"');
    expect(store.list()).toEqual(before);
    expect(h.disarmed).toEqual([]);
  });

  it("asks for more of the id when it fits more than one", async () => {
    const { h, store, shop, cafe } = await twoPending();
    store.remove(shop.scheduleId);
    store.remove(cafe.scheduleId);
    const one = { ...shop, scheduleId: "abc11111-1111-4111-8111-111111111111" };
    const two = { ...cafe, scheduleId: "abc22222-2222-4222-8222-222222222222" };
    store.put(one);
    store.put(two);
    const r = await cont(h, { mode: "cancel", cancelId: "abc" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/^agent-rewake: More than one/);
    // The matches are listed, so the person can give one of them.
    expect(r.output).toContain('  abc11111  GitHub Copilot CLI in the "shop" folder at ');
    expect(r.output).toContain('  abc22222  GitHub Copilot CLI in the "cafe" folder at ');
    expect(store.get(one.scheduleId)?.status).toBe("scheduled");
    expect(store.get(two.scheduleId)?.status).toBe("scheduled");
    expect(h.disarmed).toEqual([]);
  });

  it("sends a Zed thread's message to the schedules page", async () => {
    const h = harness();
    const store = new ScheduleStore(state);
    const zed = store.create({
      sessionId: "zed-thread-1",
      cwd: join(dir, "shop"),
      text: "Run the tests",
      dueAt: NOW + H,
      createdBy: "command",
      now: NOW,
    });
    const r = await cont(h, { mode: "cancel", cancelId: zed.scheduleId.slice(0, 8) });
    expect(r.code).toBe(1);
    expect(r.output).toContain("agent-rewake ui");
    expect(store.get(zed.scheduleId)?.status).toBe("scheduled");
    expect(h.disarmed).toEqual([]);
  });

  it("says there's nothing to cancel when the resume has finished", async () => {
    const { h, store, shop } = await twoPending();
    store.update(shop.scheduleId, (x) => ({ ...x, status: "sent" }), NOW);
    const r = await cont(h, { mode: "cancel", cancelId: shop.scheduleId.slice(0, 8) });
    expect(r.code).toBe(0);
    expect(r.output.startsWith("Nothing to cancel")).toBe(true);
    expect(store.get(shop.scheduleId)?.status).toBe("sent");
    expect(h.disarmed).toEqual([]);
  });

  it("cancels a Codex resume, named by hostOf", async () => {
    registerHost("codex");
    const h = harness();
    const store = new ScheduleStore(state);
    const made = store.create({
      sessionId: "019f-codex-thread",
      cwd: join(dir, "shop"),
      text: "Continue.",
      dueAt: NOW + H,
      kind: "limit_resume",
      createdBy: "auto",
      now: NOW,
    });
    store.put({ ...made, host: "codex", sessionRef: { threadId: made.sessionId } });
    const r = await cont(h, {
      mode: "cancel",
      cancelId: made.scheduleId.slice(0, 8),
      hostOf: (id) => (id === "codex" ? { name: "Codex", noun: "thread" } : undefined),
    });
    expect(r.code).toBe(0);
    expect(r.output.startsWith("Cancelled: Codex")).toBe(true);
    expect(store.get(made.scheduleId)?.status).toBe("cancelled");
    expect(h.disarmed).toEqual([made.scheduleId]);
  });
});

describe("continue --cancel with several planned, in a terminal (G3)", () => {
  it("lists them by number and cancels the one picked", async () => {
    const { h, store, shop, cafe } = await twoPending();
    const r = await cont(h, { mode: "cancel" }, ["2"]);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toContain('"all"');
    const listed = r.output.split("\n").filter((l) => /^ {2}\d\. /.test(l));
    expect(listed).toHaveLength(2);
    const second = store.list().find((s) => listed[1]?.includes(s.scheduleId.slice(0, 8)));
    expect(second).toBeDefined();
    expect(store.get(second?.scheduleId ?? "")?.status).toBe("cancelled");
    const other = second?.scheduleId === shop.scheduleId ? cafe : shop;
    expect(store.get(other.scheduleId)?.status).toBe("scheduled");
    expect(h.disarmed).toEqual([second?.scheduleId]);
  });

  it('"all" cancels every one', async () => {
    const { h, store, shop, cafe } = await twoPending();
    await cont(h, { mode: "cancel" }, ["all"]);
    expect(store.get(shop.scheduleId)?.status).toBe("cancelled");
    expect(store.get(cafe.scheduleId)?.status).toBe("cancelled");
  });

  it("Enter keeps them all", async () => {
    const { h, store, shop, cafe } = await twoPending();
    const r = await cont(h, { mode: "cancel" }, [""]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("Nothing was changed.");
    expect(store.get(shop.scheduleId)?.status).toBe("scheduled");
    expect(store.get(cafe.scheduleId)?.status).toBe("scheduled");
    expect(h.disarmed).toEqual([]);
  });
});

describe("agent-rewake continue --cancel <id>", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    mkdirSync(join(dir, "zed"));
    mkdirSync(join(dir, "home"));
    env = {
      AGENT_REWAKE_ZED_CONFIG_DIR: join(dir, "zed"),
      AGENT_REWAKE_ZED_DATA_DIR: join(dir, "data"),
      AGENT_REWAKE_STATE_DIR: state,
      HOME: dir,
      USERPROFILE: dir,
      PATH: process.env.PATH ?? "",
    };
    // Nothing here may touch the real home folder.
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    const code = await main(argv, env);
    vi.restoreAllMocks();
    return { code, out: out.join(""), err: err.join("") };
  }

  it("says when no planned resume has the id", async () => {
    const r = await run(["continue", "--cancel", "zzzzzzzz"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain('No planned resume starts with "zzzzzzzz"');
  });

  it("takes one id, and only after --cancel", async () => {
    expect((await run(["continue", "--cancel", "a", "b"])).code).toBe(2);
    expect((await run(["continue", "--always", "x"])).code).toBe(2);
  });
});
