import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/core/store.js";
import {
  type ClosedDeps,
  type ClosedHost,
  closedAdapter,
  ensureProgram,
  FIRE_ENV,
  sessionEnv,
} from "../src/hosts/closed.js";
import { SessionRecords } from "../src/hosts/sessions.js";
import { notice } from "../src/timers/fire.js";

/**
 * A closed session is continued by an OS timer, which starts without the person's shell: the
 * agent's own settings variables are recorded with the session and given back to the resume; a key
 * the session had only from the shell stops the resume with a reason, and is never recorded.
 */
let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "rewake-resume-env-"));
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;
const SID = "s-1";
let seen: NodeJS.ProcessEnv | undefined;
const host: ClosedHost = {
  id: "copilot-cli",
  name: "GitHub Copilot CLI",
  settingsVars: ["COPILOT_HOME", "COPILOT_PROVIDER_BASE_URL", "COPILOT_FAKE_API_KEY"],
  keyVars: ["COPILOT_PROVIDER_API_KEY"],
  resume: async (_r, _t, env) => {
    seen = env;
    return { ok: true };
  },
};
const deps = (env: NodeJS.ProcessEnv): ClosedDeps => ({
  stateDir: state,
  now: NOW,
  env,
  arm: () => {},
  disarm: () => {},
  notify: () => {},
});
const shell = {
  HOME: "/home/p",
  COPILOT_HOME: "/home/p/.copilot-work",
  COPILOT_PROVIDER_BASE_URL: "https://llm.example",
  COPILOT_FAKE_API_KEY: "never-recorded",
  XDG_CONFIG_HOME: "/home/p/.config-x",
  PATH: "/usr/bin",
};

describe("sessionEnv", () => {
  it("records the agent's settings, never a value that looks secret, and only key names", () => {
    expect(sessionEnv(host, { ...shell, COPILOT_PROVIDER_API_KEY: "sk-secret" })).toEqual({
      env: {
        XDG_CONFIG_HOME: "/home/p/.config-x",
        COPILOT_HOME: "/home/p/.copilot-work",
        COPILOT_PROVIDER_BASE_URL: "https://llm.example",
      },
      keysSet: ["COPILOT_PROVIDER_API_KEY"],
    });
    expect(
      JSON.stringify(sessionEnv(host, { ...shell, COPILOT_PROVIDER_API_KEY: "sk-secret" })),
    ).not.toContain("sk-secret");
  });
});

describe("a resume from a timer", () => {
  const record = (env: NodeJS.ProcessEnv) => {
    ensureProgram(host, SID, "/work", deps(env), () => "/usr/bin/copilot");
    return new SessionRecords(state, host.id).get(SID);
  };
  const schedule = () =>
    new ScheduleStore(state).create({
      sessionId: SID,
      cwd: "/work",
      text: "continue",
      dueAt: NOW,
      kind: "auto_limit_resume",
      createdBy: "auto",
      now: NOW,
    });

  it("runs the agent with the session's own settings over the timer's environment", async () => {
    expect(record(shell)?.env?.COPILOT_HOME).toBe("/home/p/.copilot-work");
    // launchd: HOME and a minimal PATH, nothing from the shell profile.
    const timer = { HOME: "/home/p", PATH: "/usr/bin:/bin" };
    const s = schedule();
    expect(await closedAdapter(host, state, timer).send(s, "k")).toEqual({ ok: true });
    expect(seen).toMatchObject({
      COPILOT_HOME: "/home/p/.copilot-work",
      COPILOT_PROVIDER_BASE_URL: "https://llm.example",
      XDG_CONFIG_HOME: "/home/p/.config-x",
      PATH: "/usr/bin:/bin",
      [FIRE_ENV]: s.scheduleId,
    });
  });

  it("stops with a reason when the session's key came only from the shell", async () => {
    record({ ...shell, COPILOT_PROVIDER_API_KEY: "sk-secret" });
    seen = undefined;
    const result = await closedAdapter(host, state, { HOME: "/home/p" }).send(schedule(), "k");
    expect(result).toEqual({ ok: false, reason: "failed", detail: "missing-key" });
    expect(seen).toBeUndefined();
    // With the key in the timer's environment too (set system-wide), it runs.
    expect(
      await closedAdapter(host, state, { HOME: "/home/p", COPILOT_PROVIDER_API_KEY: "k" }).send(
        schedule(),
        "k",
      ),
    ).toEqual({ ok: true });
  });

  it("a resume run's own hooks don't overwrite the session's settings", () => {
    record(shell);
    record({ HOME: "/home/p", [FIRE_ENV]: "x" });
    expect(new SessionRecords(state, host.id).get(SID)?.env?.COPILOT_HOME).toBe(
      "/home/p/.copilot-work",
    );
  });

  it("tells the person why, and what to do", () => {
    expect(
      notice("failed", "GitHub Copilot CLI", NOW, {
        noun: "session",
        agentName: "GitHub Copilot CLI",
        cause: "missing-key",
      }),
    ).toBe(
      "GitHub Copilot CLI: Rewake couldn't continue the session because it used a key or token from your shell, and Rewake never stores those. Open the session to continue. Next time, sign in to GitHub Copilot CLI and remove the key from your shell profile.",
    );
  });
});
