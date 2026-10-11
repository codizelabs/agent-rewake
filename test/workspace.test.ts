import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings, saveSettings } from "../src/core/settings.js";
import { registerHost, type Schedule, ScheduleStore } from "../src/core/store.js";
import { armClosed, type ClosedDeps, type ClosedHost } from "../src/hosts/closed.js";
import type { HostAdapter, SendResult } from "../src/hosts/host.js";
import { SessionRecords } from "../src/hosts/sessions.js";
import { type FireDeps, fire, notice, WORKSPACE_NOTE } from "../src/timers/fire.js";
import { explainSchedule } from "../src/ui/overview.js";
import {
  fingerprintWorkspace,
  type WorkspaceFingerprint,
  workspaceChange,
} from "../src/util/workspace.js";

registerHost("test");
registerHost("copilot-cli");

const NOW = Date.parse("2026-10-07T12:00:00Z");
const baseSettings = (): Settings => ({ ...DEFAULT_SETTINGS });

let root: string;
let repo: string;
let state: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rewake-ws-"));
  repo = join(root, "shop");
  state = join(root, "state");
  home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(state);
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Git in the temp repo only: its own identity and no global configuration. */
function git(...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}
function makeRepo(): void {
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
}

describe("fingerprintWorkspace", () => {
  it("gives the commit and a hash for a clean work tree, the same twice", () => {
    makeRepo();
    const a = fingerprintWorkspace(repo);
    expect(a).toMatchObject({ dirty: false });
    expect(a?.commit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(a?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintWorkspace(repo)).toEqual(a);
  });

  it("changes with a new commit", () => {
    makeRepo();
    const before = fingerprintWorkspace(repo) as WorkspaceFingerprint;
    writeFileSync(join(repo, "b.txt"), "two\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "second");
    const after = fingerprintWorkspace(repo) as WorkspaceFingerprint;
    expect(after.commit).not.toBe(before.commit);
    expect(workspaceChange(before, after)).toEqual({ commit: true, changes: false });
  });

  it("changes with a changed or new file, and says it is dirty", () => {
    makeRepo();
    const clean = fingerprintWorkspace(repo) as WorkspaceFingerprint;
    writeFileSync(join(repo, "a.txt"), "edited\n");
    const edited = fingerprintWorkspace(repo) as WorkspaceFingerprint;
    expect(edited.dirty).toBe(true);
    expect(workspaceChange(clean, edited)).toEqual({ commit: false, changes: true });
  });

  it("ignores untracked files: .DS_Store, build output and logs don't count", () => {
    makeRepo();
    const before = fingerprintWorkspace(repo);
    writeFileSync(join(repo, ".DS_Store"), "x\n");
    writeFileSync(join(repo, "build.log"), "x\n");
    expect(fingerprintWorkspace(repo)).toEqual(before);
    expect(before?.dirty).toBe(false);
  });

  it("gives nothing when its time is used up", () => {
    makeRepo();
    expect(fingerprintWorkspace(repo, 0)).toBeUndefined();
  });

  it("looks at names and status only: editing a changed file again changes nothing", () => {
    makeRepo();
    writeFileSync(join(repo, "a.txt"), "edited\n");
    const first = fingerprintWorkspace(repo);
    writeFileSync(join(repo, "a.txt"), "edited differently\n");
    expect(fingerprintWorkspace(repo)).toEqual(first);
  });

  it("gives nothing outside a work tree, for a missing folder or none", () => {
    expect(fingerprintWorkspace(repo)).toBeUndefined();
    expect(fingerprintWorkspace(join(root, "gone"))).toBeUndefined();
    expect(fingerprintWorkspace("")).toBeUndefined();
  });

  it("gives nothing, without an error, when git is missing", () => {
    makeRepo();
    const path = process.env.PATH;
    process.env.PATH = join(root, "nothing-here");
    try {
      expect(fingerprintWorkspace(repo)).toBeUndefined();
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("arming records the fingerprint", () => {
  const host: ClosedHost = {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    resume: async () => ({ ok: true }),
  };
  const deps = (): ClosedDeps => ({
    stateDir: state,
    now: NOW,
    env: {},
    arm: () => {},
    disarm: () => {},
    notify: () => {},
    agent: () => ({ pid: 1, name: "copilot" }),
    running: () => false,
  });

  it("keeps the commit, the hash and dirty, and no file name", () => {
    makeRepo();
    writeFileSync(join(repo, "a.txt"), "secret-plans\n");
    git("mv", "a.txt", "secret-plans.txt");
    const records = new SessionRecords(state, host.id);
    records.update("s1", repo, NOW, (r) => r);
    const r = records.get("s1");
    const order: string[] = [];
    const d = deps();
    const armed = armClosed(host, r as NonNullable<typeof r>, NOW + 3_600_000, {
      ...d,
      // Armed before the fingerprint is taken: it can never delay arming.
      arm: (id) =>
        order.push(`armed:${new ScheduleStore(state).get(id)?.workspace ? "with" : "without"}`),
    });
    expect(order).toEqual(["armed:without"]);
    expect(armed.workspace).toEqual(fingerprintWorkspace(repo));
    expect(armed.workspace?.dirty).toBe(true);
    const file = readFileSync(join(state, "schedules", `${armed.scheduleId}.json`), "utf8");
    expect(file).not.toContain("secret-plans");
    expect(new ScheduleStore(state).get(armed.scheduleId)?.workspace).toEqual(armed.workspace);
  });

  it("records none outside a git folder", () => {
    const records = new SessionRecords(state, host.id);
    records.update("s1", repo, NOW, (r) => r);
    const r = records.get("s1");
    const armed = armClosed(host, r as NonNullable<typeof r>, NOW + 3_600_000, deps());
    expect(armed.workspace).toBeUndefined();
  });
});

describe("fire and the project changing while it waited", () => {
  function plan(): Schedule {
    makeRepo();
    const store = new ScheduleStore(state);
    const s = store.create({
      sessionId: "thread-1",
      cwd: repo,
      text: "Continue.",
      dueAt: NOW,
      kind: "limit_resume",
      createdBy: "auto",
      now: NOW - 3_600_000,
    });
    store.put({
      ...s,
      host: "test",
      sessionRef: { threadId: "thread-1" },
      workspace: fingerprintWorkspace(repo) as WorkspaceFingerprint,
    });
    return store.get(s.scheduleId) as Schedule;
  }
  function setup(setting?: Settings["workspaceChanged"], send: SendResult = { ok: true }) {
    if (setting) saveSettings(state, { ...baseSettings(), workspaceChanged: setting });
    const sent: string[] = [];
    const notes: string[] = [];
    const host: HostAdapter = {
      id: "test",
      name: "Codex",
      noun: "thread",
      check: async () => ({}),
      send: async (s) => {
        sent.push(s.text);
        return send;
      },
    };
    const deps: FireDeps = {
      stateDir: state,
      now: () => NOW + 60_000,
      hosts: new Map([["test", host]]),
      notify: (_t, body) => {
        notes.push(body);
        return true;
      },
    };
    return { deps, sent, notes };
  }
  const commit = () => {
    writeFileSync(join(repo, "b.txt"), "two\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "second");
  };

  it("sends the message unchanged, and says nothing, when nothing changed", async () => {
    const s = plan();
    const { deps, sent, notes } = setup();
    expect(await fire(s.scheduleId, deps)).toBe("sent");
    expect(sent).toEqual(["Continue."]);
    expect(notes).toEqual([]);
  });

  it("tell (the default): sends the message as it was and only tells the person", async () => {
    const s = plan();
    commit();
    const { deps, sent, notes } = setup();
    expect(await fire(s.scheduleId, deps)).toBe("sent");
    expect(sent).toEqual(["Continue."]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("tracked files or latest commit changed while the thread waited");
    expect(notes[0]).toContain("sent its message as it was");
    expect(notes[0]).toContain(
      "Change this with: agent-rewake settings workspace-changed (tell, note, hold or off).",
    );
  });

  it("untracked files alone say nothing", async () => {
    const s = plan();
    writeFileSync(join(repo, "build.log"), "x\n");
    const { deps, sent, notes } = setup();
    expect(await fire(s.scheduleId, deps)).toBe("sent");
    expect(sent).toEqual(["Continue."]);
    expect(notes).toEqual([]);
  });

  it("note: adds the fixed line after a blank line, and tells the person", async () => {
    const s = plan();
    commit();
    const { deps, sent, notes } = setup("note");
    expect(await fire(s.scheduleId, deps)).toBe("sent");
    expect(sent).toEqual([`Continue.\n\n${WORKSPACE_NOTE}`]);
    expect(WORKSPACE_NOTE).not.toMatch(/[\\/]|shop|b\.txt|main|master/);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("so Rewake added a line to its message");
    expect(notes[0]).toContain("settings workspace-changed");
    // The stored message is untouched.
    expect(new ScheduleStore(state).get(s.scheduleId)?.text).toBe("Continue.");
  });

  it("note: changes to tracked files count too", async () => {
    const s = plan();
    writeFileSync(join(repo, "a.txt"), "edited\n");
    const { deps, sent } = setup("note");
    expect(await fire(s.scheduleId, deps)).toBe("sent");
    expect(sent[0]).toContain(WORKSPACE_NOTE);
  });

  it("hold: sends nothing, marks needs attention and says what changed and how to go on", async () => {
    const s = plan();
    commit();
    writeFileSync(join(repo, "a.txt"), "edited\n");
    const { deps, sent, notes } = setup("hold");
    expect(await fire(s.scheduleId, deps)).toBe("notified");
    expect(sent).toEqual([]);
    const after = new ScheduleStore(state).get(s.scheduleId);
    expect(after?.status).toBe("needs_attention");
    expect(after?.attempts).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("its latest commit moved and its tracked files differ");
    expect(notes[0]).toContain('run "agent-rewake continue"');
    expect(notes[0]).not.toContain(repo);
    // Once only: a second run does nothing.
    expect(await fire(s.scheduleId, deps)).toBe("gone");
    expect(sent).toEqual([]);
  });

  it("off: sends the message unchanged", async () => {
    const s = plan();
    commit();
    const { deps, sent, notes } = setup("off");
    expect(await fire(s.scheduleId, deps)).toBe("sent");
    expect(sent).toEqual(["Continue."]);
    expect(notes).toEqual([]);
  });

  it("sends once only, with the note", async () => {
    const s = plan();
    commit();
    const { deps, sent } = setup("note");
    expect(await fire(s.scheduleId, deps)).toBe("sent");
    expect(await fire(s.scheduleId, deps)).toBe("gone");
    expect(sent).toHaveLength(1);
  });

  it("a resume planned outside a git folder is sent as it was", async () => {
    makeRepo();
    const store = new ScheduleStore(state);
    const s = store.create({
      sessionId: "thread-1",
      cwd: repo,
      text: "Continue.",
      dueAt: NOW,
      kind: "limit_resume",
      createdBy: "auto",
      now: NOW - 3_600_000,
    });
    store.put({ ...s, host: "test", sessionRef: { threadId: "thread-1" } });
    commit();
    const { deps, sent } = setup("hold");
    expect(await fire(s.scheduleId, deps)).toBe("sent");
    expect(sent).toEqual(["Continue."]);
  });
});

describe("the hold notice and --explain", () => {
  it("names the host's own way to ask again when it has one", () => {
    const text = notice("workspace", "Codex", NOW, {
      noun: "thread",
      agentName: "Codex",
      again: () => 'Resume the thread in Codex and type "rewake".',
      workspace: { commit: false, changes: true },
    });
    expect(text).toContain("(its tracked files differ)");
    expect(text).toContain('type "rewake"');
  });

  it("--explain mentions the check for a resume that has a fingerprint", () => {
    makeRepo();
    const store = new ScheduleStore(state);
    const s = store.create({
      sessionId: "thread-1",
      cwd: repo,
      text: "Continue.",
      dueAt: NOW + 3_600_000,
      kind: "limit_resume",
      createdBy: "auto",
      now: NOW,
    });
    store.put({
      ...s,
      host: "test",
      workspace: fingerprintWorkspace(repo) as WorkspaceFingerprint,
    });
    const hostOf = () => ({ name: "Codex", noun: "thread" });
    const tell = explainSchedule(state, s.scheduleId, NOW, hostOf);
    expect(tell.ok && tell.text).toContain("it tells you and sends the message as it is");
    saveSettings(state, { ...baseSettings(), workspaceChanged: "note" });
    const note = explainSchedule(state, s.scheduleId, NOW, hostOf);
    expect(note.ok && note.text).toContain("re-read files before editing");
    saveSettings(state, { ...baseSettings(), workspaceChanged: "hold" });
    const hold = explainSchedule(state, s.scheduleId, NOW, hostOf);
    expect(hold.ok && hold.text).toContain("Rewake sends nothing and tells you");
    expect(hold.ok && hold.text).toContain("latest git commit or tracked files");
    saveSettings(state, { ...baseSettings(), workspaceChanged: "off" });
    const off = explainSchedule(state, s.scheduleId, NOW, hostOf);
    expect(off.ok && off.text).not.toContain("tracked files");
  });
});
