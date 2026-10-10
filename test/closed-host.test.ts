import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import {
  type ClosedDeps,
  type ClosedHost,
  closedAdapter,
  FIRE_ENV,
  onSessionEnd,
  onSessionStart,
} from "../src/hosts/closed.js";
import "../src/hosts/index.js"; // registers the hosts
import { SessionRecords } from "../src/hosts/sessions.js";

/**
 * The closed-session hosts' shared rules (src/hosts/closed.ts) that no single host's tests pin:
 * Rewake's own resume run (FIRE_ENV) is never taken for the person, and a session whose record is
 * gone is reported as deleted without running the agent.
 */

const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const SID = "1f0e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";

let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "rewake-closed-"));
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

function host(resumed: string[]): ClosedHost {
  return {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    resume: async (r) => {
      resumed.push(r.sessionId);
      return { ok: true };
    },
  };
}

function deps(env: NodeJS.ProcessEnv, armed: string[], notes: string[], now = NOW): ClosedDeps {
  return {
    stateDir: state,
    now,
    env,
    arm: (id) => armed.push(id),
    disarm: () => {},
    notify: (_t, b) => notes.push(b),
    agent: () => ({ pid: 4242, name: "copilot" }),
    running: () => false,
  };
}

describe("Rewake's own resume run (FIRE_ENV)", () => {
  it("doesn't mark the session open when it starts", () => {
    const records = new SessionRecords(state, "copilot-cli");
    records.update(SID, "/work", NOW - H, (r) => ({ ...r, open: false, closedAt: NOW - H }));
    const before = records.get(SID);
    onSessionStart(host([]), SID, "/work", deps({ [FIRE_ENV]: "resume-1" }, [], []));
    expect(records.get(SID)).toEqual(before);
    // The person opening it is recorded.
    onSessionStart(host([]), SID, "/work", deps({}, [], []));
    expect(records.get(SID)?.open).toBe(true);
  });

  it("doesn't arm or offer another resume when it ends at the limit again", () => {
    saveSettings(state, { ...DEFAULT_SETTINGS, newThreads: "on" });
    const records = new SessionRecords(state, "copilot-cli");
    records.update(SID, "/work", NOW, (r) => ({
      ...r,
      open: true,
      limit: { kind: "session", billing: false, resetsAt: NOW + H, seenAt: NOW },
    }));
    const armed: string[] = [];
    const notes: string[] = [];
    onSessionEnd(host([]), SID, "/work", deps({ [FIRE_ENV]: "resume-1" }, armed, notes));
    expect(records.get(SID)?.open).toBe(false);
    expect(armed).toEqual([]);
    expect(notes).toEqual([]);
    // The same end by the person arms the resume (automatic resume is on).
    records.update(SID, "/work", NOW, (r) => ({ ...r, open: true }));
    onSessionEnd(host([]), SID, "/work", deps({}, armed, notes));
    expect(armed).toHaveLength(1);
  });

  it("says when an automatically-armed resume's history is large", () => {
    saveSettings(state, { ...DEFAULT_SETTINGS, newThreads: "on" });
    const records = new SessionRecords(state, "copilot-cli");
    records.update(SID, "/work", NOW, (r) => ({
      ...r,
      open: true,
      historyBytes: 7 * 1024 * 1024,
      limit: { kind: "session", billing: false, resetsAt: NOW + H, seenAt: NOW },
    }));
    const notes: string[] = [];
    onSessionEnd(host([]), SID, "/work", deps({}, [], notes));
    expect(notes[0]).toMatch(/ This session is large \(about 7 MB of history\); continuing it/);
  });
});

describe("a resume whose session record is gone", () => {
  it("checks as nothing known and sends nothing, reporting the session as deleted", async () => {
    const resumed: string[] = [];
    const store = new ScheduleStore(state);
    const s = store.create({
      sessionId: SID,
      cwd: "/work",
      text: "Continue.",
      dueAt: NOW,
      kind: "limit_resume",
      createdBy: "auto",
      now: NOW - H,
    });
    const resume = { ...s, host: "copilot-cli", sessionRef: { sessionId: SID, cwd: "/work" } };
    const adapter = closedAdapter(host(resumed), state, {});
    expect(await adapter.check(resume, NOW)).toEqual({});
    expect(await adapter.send(resume, "k")).toEqual({
      ok: false,
      reason: "closed",
      detail: "deleted",
    });
    expect(resumed).toEqual([]);
  });
});
