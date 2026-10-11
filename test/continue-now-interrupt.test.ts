import { spawn } from "node:child_process";
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
import { runContinue } from "../src/continue.js";
import { SessionLock } from "../src/core/lock.js";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { type Schedule, ScheduleStore } from "../src/core/store.js";
import type { ClosedDeps } from "../src/hosts/closed.js";
import { copilotHooks, copilotHost } from "../src/hosts/copilot/host.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js"; // registers the hosts

const FAKE = fileURLToPath(new URL("./fixtures/fake-copilot.mjs", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../dist/agent-rewake.js", import.meta.url));
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const SESSION = "8a3c1f2e-0b5d-4c7a-9e21-3f6b8d0c4a17";
const WEEKLY_IN =
  "You've reached your weekly rate limit. Please wait for your limit to reset in 3 hours or switch to auto model to continue.";

let dir: string;
let state: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-now-sigint-")));
  state = join(dir, "state");
  mkdirSync(join(dir, "shop"));
  mkdirSync(join(dir, "home"));
  chmodSync(FAKE, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(50);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A closed Copilot session stopped at its limit, with its resume planned. */
async function planned(): Promise<string> {
  saveSettings(state, { ...DEFAULT_SETTINGS, keepAwake: "never" });
  const deps: ClosedDeps = {
    stateDir: state,
    now: NOW,
    env: {},
    arm: () => undefined,
    disarm: () => undefined,
    notify: () => undefined,
    agent: () => undefined,
    running: () => true,
  };
  const handler = copilotHooks({ closed: () => deps, program: () => FAKE });
  const event = (name: string, input: Record<string, unknown>) =>
    runHook(
      handler,
      name,
      JSON.stringify({ sessionId: SESSION, timestamp: NOW, cwd: join(dir, "shop"), ...input }),
      {},
      state,
      NOW,
    );
  await event("sessionStart", { source: "startup" });
  await event("errorOccurred", { error: { message: WEEKLY_IN } });
  await event("sessionEnd", { reason: "error" });
  await runContinue({
    hosts: [copilotHost],
    deps,
    interactive: true,
    out: () => undefined,
    ask: async () => "",
  });
  const s = new ScheduleStore(state).list()[0] as Schedule;
  expect(s.status).toBe("scheduled");
  return s.scheduleId.slice(0, 8);
}

describe.skipIf(process.platform === "win32")("continue --now, Ctrl+C while the agent runs", () => {
  it("stops the agent, leaves the resume stopped (not sending) and exits 130", async () => {
    const id = await planned();
    const pidFile = join(dir, "agent.pid");
    const child = spawn(process.execPath, [BUNDLE, "continue", "--now", id, "--yes"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(dir, "home"),
        USERPROFILE: join(dir, "home"),
        AGENT_REWAKE_STATE_DIR: state,
        AGENT_REWAKE_TEST_NO_OS_TIMERS: "1",
        FAKE_COPILOT: "sleep",
        FAKE_COPILOT_PIDFILE: pidFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += String(c);
    });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    try {
      await until(
        "the agent to start",
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "",
      );
      const agent = Number(readFileSync(pidFile, "utf8"));
      expect(alive(agent)).toBe(true);
      child.kill("SIGINT");
      expect(await exited).toBe(130);
      await until("the agent to end", () => !alive(agent));
    } finally {
      child.kill("SIGKILL");
    }
    expect(out).toContain("Press Ctrl+C to stop it.");
    expect(out).not.toContain("continue --cancel");
    expect(out).toContain("The planned resume is cancelled too");
    expect(out.match(/^Stopping\./gm)).toHaveLength(1);
    const after = new ScheduleStore(state).list()[0];
    expect(after?.status).toBe("stopped");
    expect(after?.failureReason).toBe("you");
  }, 40_000);

  it("a second Ctrl+C ends an agent that ignores the first stop, at once", async () => {
    const id = await planned();
    const pidFile = join(dir, "agent.pid");
    const child = spawn(process.execPath, [BUNDLE, "continue", "--now", id, "--yes"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(dir, "home"),
        USERPROFILE: join(dir, "home"),
        AGENT_REWAKE_STATE_DIR: state,
        AGENT_REWAKE_TEST_NO_OS_TIMERS: "1",
        FAKE_COPILOT: "sleep",
        FAKE_COPILOT_STUBBORN: "1",
        FAKE_COPILOT_PIDFILE: pidFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += String(c);
    });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    let agent = 0;
    try {
      await until(
        "the agent to start",
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "",
      );
      agent = Number(readFileSync(pidFile, "utf8"));
      child.kill("SIGINT");
      await until("the first stop", () => out.includes("Stopping."));
      child.kill("SIGINT");
      expect(await exited).toBe(130);
      await until("the agent to end", () => !alive(agent));
    } finally {
      child.kill("SIGKILL");
      if (agent && alive(agent)) process.kill(agent, "SIGKILL");
    }
    expect(out).toContain("Ended the agent now.");
    expect(new ScheduleStore(state).list()[0]?.status).toBe("stopped");
  }, 40_000);

  it("Ctrl+C while waiting for a free place leaves the plan, and no lock stops the next run", async () => {
    const id = await planned();
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: join(dir, "home"),
      USERPROFILE: join(dir, "home"),
      AGENT_REWAKE_STATE_DIR: state,
      AGENT_REWAKE_TEST_NO_OS_TIMERS: "1",
      FAKE_COPILOT: "ok",
    };
    const run = () => {
      const child = spawn(process.execPath, [BUNDLE, "continue", "--now", id, "--yes"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c) => {
        out += String(c);
      });
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
      return { child, exited, out: () => out };
    };
    // Both places are taken, so the run waits for one.
    const lock = new SessionLock(state);
    expect(lock.acquire("resume-slot:1")).toBe(true);
    expect(lock.acquire("resume-slot:2")).toBe(true);
    const first = run();
    try {
      await wait(1_500);
      first.child.kill("SIGINT");
      expect(await first.exited).toBe(130);
    } finally {
      first.child.kill("SIGKILL");
    }
    expect(first.out()).toContain("Nothing was sent, and your resume is still planned.");
    const kept = new ScheduleStore(state).list()[0];
    expect(kept?.status).toBe("scheduled");
    expect(kept?.attempts).toEqual([]);
    // The places are free again: the next run goes straight through.
    lock.release("resume-slot:1");
    lock.release("resume-slot:2");
    const second = run();
    expect(await second.exited).toBe(0);
    expect(second.out()).toContain("Rewake continued");
    expect(new ScheduleStore(state).list()[0]?.status).toBe("sent");
  }, 40_000);
});
