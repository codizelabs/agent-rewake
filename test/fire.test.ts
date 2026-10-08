import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATE_MS, MAX_REARMS } from "../src/core/resume.js";
import { registerHost, type Schedule, ScheduleStore } from "../src/core/store.js";
import {
  type HostAdapter,
  type HostFacts,
  resumeDeadline,
  type SendResult,
} from "../src/hosts/host.js";
import { type FireDeps, fire, notice, SENDING_STALE_MS } from "../src/timers/fire.js";
import type { TimerHost } from "../src/timers/timers.js";

registerHost("test");

const NOW = Date.parse("2026-10-07T12:00:00Z");
let dir: string;
let store: ScheduleStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-fire-"));
  store = new ScheduleStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function resume(extra: Partial<Schedule> = {}): Schedule {
  const s = store.create({
    sessionId: "thread-1",
    cwd: "/work/shop",
    text: "Continue.",
    dueAt: NOW,
    kind: "limit_resume",
    createdBy: "auto",
    now: NOW - 3_600_000,
  });
  store.put({ ...s, host: "test", sessionRef: { threadId: "thread-1" }, ...extra });
  return store.get(s.scheduleId) as Schedule;
}

function setup(o: { facts?: HostFacts; send?: SendResult; now?: number; throws?: boolean } = {}) {
  const sent: string[] = [];
  const notes: string[] = [];
  const calls: string[][] = [];
  const host: HostAdapter = {
    id: "test",
    name: "Codex",
    noun: "thread",
    check: async () => {
      if (o.throws) throw new Error("no session file");
      return o.facts ?? {};
    },
    send: async (_s, key) => {
      sent.push(key);
      return o.send ?? { ok: true };
    },
  };
  const timers: TimerHost = {
    platform: "linux",
    stateDir: dir,
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
  const deps: FireDeps = {
    stateDir: dir,
    now: () => o.now ?? NOW + 60_000,
    hosts: new Map([["test", host]]),
    timers,
    notify: (_t, body) => {
      notes.push(body);
      return true;
    },
  };
  return { deps, sent, notes, calls };
}

describe("fire", () => {
  it("sends once, records the attempt and removes its timer", async () => {
    const r = resume();
    const { deps, sent, calls } = setup();
    expect(await fire(r.scheduleId, deps)).toBe("sent");
    expect(sent).toEqual([`${r.scheduleId}:${NOW}`]);
    const after = store.get(r.scheduleId);
    expect(after?.status).toBe("sent");
    expect(after?.attempts).toMatchObject([{ n: 1, outcome: "sent" }]);
    expect(calls.at(-1)).toEqual([
      "systemctl",
      "--user",
      "stop",
      `codizelabs-agent-rewake-${r.scheduleId}.timer`,
    ]);
    // A second run (a duplicate timer, a sweep) sends nothing.
    expect(await fire(r.scheduleId, deps)).toBe("gone");
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when the person cancels while the agent is being checked", async () => {
    const r = resume();
    const { deps, sent } = setup();
    const host = deps.hosts.get("test") as HostAdapter;
    (deps.hosts as Map<string, HostAdapter>).set("test", {
      ...host,
      check: async () => {
        // `agent-rewake continue --cancel`, or typing in the session, lands right now.
        expect(new ScheduleStore(dir).cancel(r.scheduleId, NOW + 30_000)).toBe(true);
        return {};
      },
    });
    expect(await fire(r.scheduleId, deps)).toBe("gone");
    expect(sent).toEqual([]);
    expect(store.get(r.scheduleId)?.status).toBe("cancelled");
  });

  it("a continue already being sent can't be cancelled, and says so", async () => {
    const r = resume();
    const { deps } = setup();
    const host = deps.hosts.get("test") as HostAdapter;
    let cancelled: boolean | undefined;
    (deps.hosts as Map<string, HostAdapter>).set("test", {
      ...host,
      send: async () => {
        cancelled = new ScheduleStore(dir).cancel(r.scheduleId, NOW + 61_000);
        return { ok: true };
      },
    });
    expect(await fire(r.scheduleId, deps)).toBe("sent");
    expect(cancelled).toBe(false);
    expect(store.get(r.scheduleId)?.status).toBe("sent");
  });

  it("does nothing when run early (launchd runs a job once when it's loaded)", async () => {
    const r = resume();
    const { deps, sent } = setup({ now: NOW - 5 * 60_000 });
    expect(await fire(r.scheduleId, deps)).toBe("early");
    expect(sent).toEqual([]);
    expect(store.get(r.scheduleId)?.status).toBe("scheduled");
  });

  it("only notifies when the session is open: never a second writer", async () => {
    const r = resume();
    const { deps, sent, notes } = setup({ facts: { sessionOpen: true } });
    expect(await fire(r.scheduleId, deps)).toBe("notified");
    expect(sent).toEqual([]);
    expect(store.get(r.scheduleId)?.status).toBe("needs_attention");
    expect(notes).toEqual([
      'Codex in the "shop" folder: the usage limit has reset. The thread is open, so Rewake didn\'t send anything. Continue it there.',
    ]);
  });

  it("only notifies when more than 30 minutes late", async () => {
    const r = resume();
    const { deps, sent, notes } = setup({ now: NOW + LATE_MS + 1 });
    expect(await fire(r.scheduleId, deps)).toBe("notified");
    expect(sent).toEqual([]);
    expect(store.get(r.scheduleId)?.status).toBe("missed");
    expect(notes[0]).toContain("but couldn't run then (the computer may have been off or asleep)");
  });

  it("stops when the person typed after the limit, or the agent continued by itself", async () => {
    for (const facts of [{ userTypedSince: true }, { nativeContinued: true }]) {
      const r = resume();
      const { deps, sent, notes } = setup({ facts });
      expect(await fire(r.scheduleId, deps)).toBe("skipped");
      expect(sent).toEqual([]);
      expect(notes).toEqual([]);
      expect(store.get(r.scheduleId)?.status).toBe("stopped");
    }
  });

  it("waits for a later reset and re-arms its timer", async () => {
    const r = resume();
    const later = NOW + 2 * 3_600_000;
    const { deps, sent, calls } = setup({ facts: { usageAllowed: false, newResetsAt: later } });
    expect(await fire(r.scheduleId, deps)).toBe("waiting");
    expect(sent).toEqual([]);
    const after = store.get(r.scheduleId);
    expect(after?.status).toBe("scheduled");
    expect(after?.rearms).toBe(1);
    expect(after?.dueAt).toBe(later + 60_000);
    expect(calls.some((c) => c[0] === "systemd-run")).toBe(true);
  });

  it("gives up after the last re-arm and says so", async () => {
    const r = resume({ rearms: MAX_REARMS });
    const { deps, notes } = setup({ facts: { usageAllowed: false } });
    expect(await fire(r.scheduleId, deps)).toBe("failed");
    expect(store.get(r.scheduleId)?.status).toBe("failed");
    expect(notes[0]).toContain("is still at its usage limit, so Rewake didn't continue.");
  });

  it("tries again later when the agent is limited at send time", async () => {
    const r = resume();
    const { deps } = setup({ send: { ok: false, reason: "limited" } });
    expect(await fire(r.scheduleId, deps)).toBe("waiting");
    const after = store.get(r.scheduleId);
    expect(after?.status).toBe("scheduled");
    expect(after?.attempts).toMatchObject([{ outcome: "limited" }]);
    // The new due time has a new idempotency key, so the next try can send.
    const again = setup({ now: (after?.dueAt ?? 0) + 1000 });
    expect(await fire(r.scheduleId, again.deps)).toBe("sent");
  });

  it("waits for the reset a run still at the limit reports, instead of giving up", async () => {
    const r = resume({ rearms: 1 });
    const later = NOW + 5 * 3_600_000;
    const { deps } = setup({ send: { ok: false, reason: "limited", resetsAt: later } });
    expect(await fire(r.scheduleId, deps)).toBe("waiting");
    expect(store.get(r.scheduleId)).toMatchObject({
      status: "scheduled",
      dueAt: later + 60_000,
      rearms: 2,
    });
  });

  it("asks rather than waits when that reset is more than a day away", async () => {
    const r = resume();
    const weekly = NOW + 3 * 24 * 3_600_000;
    const { deps, notes } = setup({ send: { ok: false, reason: "limited", resetsAt: weekly } });
    expect(await fire(r.scheduleId, deps)).toBe("notified");
    expect(store.get(r.scheduleId)).toMatchObject({
      status: "needs_attention",
      dueAt: weekly + 60_000,
    });
    expect(notes[0]).toContain("is limited again until");
  });

  it("says when it couldn't send", async () => {
    const r = resume();
    const { deps, notes } = setup({ send: { ok: false, reason: "closed" } });
    expect(await fire(r.scheduleId, deps)).toBe("failed");
    expect(store.get(r.scheduleId)?.status).toBe("failed");
    expect(notes[0]).toContain("couldn't continue");
  });

  it("never retries a send that was interrupted (no double message)", async () => {
    const started = NOW;
    const r = resume({
      status: "sending",
      attempts: [{ n: 1, idempotencyKey: "k", startedAt: started, outcome: "sending" }],
    });
    // Still within a resume run's time: it may be running.
    const recent = setup({ now: started + 5 * 60_000 });
    expect(await fire(r.scheduleId, recent.deps)).toBe("busy");
    // Cut off (a crash, a reboot): settled and the person told; still never sent again.
    const { deps, sent, notes } = setup({ now: started + SENDING_STALE_MS + 1 });
    expect(await fire(r.scheduleId, deps)).toBe("notified");
    expect(sent).toEqual([]);
    expect(store.get(r.scheduleId)).toMatchObject({
      status: "needs_attention",
      failureReason: "unconfirmed",
    });
    expect(notes[0]).toContain("can't tell whether its message was sent. It won't send it again.");
    expect(await fire(r.scheduleId, deps)).toBe("gone");
  });

  it("settles a cut-off send as sent when the agent's files show the message arrived", async () => {
    const r = resume({
      status: "sending",
      attempts: [{ n: 1, idempotencyKey: "k", startedAt: NOW, outcome: "sending" }],
    });
    const { deps, sent, notes } = setup({ now: NOW + SENDING_STALE_MS + 1 });
    (deps.hosts.get("test") as HostAdapter).delivered = () => true;
    expect(await fire(r.scheduleId, deps)).toBe("sent");
    expect(sent).toEqual([]);
    expect(notes).toEqual([]);
    expect(store.get(r.scheduleId)?.status).toBe("sent");
  });

  it("re-arms under a new timer name and retires its own (a timer can't replace itself)", async () => {
    const r = resume();
    const { deps, calls } = setup({ send: { ok: false, reason: "limited" } });
    expect(await fire(r.scheduleId, { ...deps, fromTimer: true, timerGen: 0 })).toBe("waiting");
    const run = calls.find((c) => c[0] === "systemd-run");
    expect(run).toContain(`--unit=codizelabs-agent-rewake-${r.scheduleId}-r1`);
    expect(calls.at(-1)).toEqual([
      "systemctl",
      "--user",
      "stop",
      `codizelabs-agent-rewake-${r.scheduleId}.timer`,
    ]);
  });

  it("reports a resume run stopped after 30 minutes in plain words", () => {
    expect(
      notice("failed", "Copilot", NOW, { noun: "session", agentName: "Copilot", cause: "timeout" }),
    ).toBe(
      "Copilot: Rewake continued the session, but the agent was still working half an hour later (it may have been waiting for your approval), so Rewake stopped the run. Open the session to see where it got to and continue.",
    );
  });

  it("leaves Zed's own schedules and unknown ids alone", async () => {
    const zed = store.create({
      sessionId: "s",
      cwd: "/p",
      text: "hi",
      dueAt: NOW,
      createdBy: "command",
      now: NOW,
    });
    const { deps, sent } = setup();
    expect(await fire(zed.scheduleId, deps)).toBe("not-ours");
    expect(await fire("00000000-0000-0000-0000-000000000000", deps)).toBe("gone");
    expect(sent).toEqual([]);
  });

  it("removes the timer of a resume the person cancelled", async () => {
    const r = resume({ status: "cancelled" });
    const { deps, sent, calls } = setup();
    expect(await fire(r.scheduleId, deps)).toBe("skipped");
    expect(sent).toEqual([]);
    expect(calls.at(-1)?.[2]).toBe("stop");
  });

  it("sends when the host can't check anything (no facts means nothing stands in the way)", async () => {
    const r = resume();
    const { deps, sent } = setup({ throws: true });
    expect(await fire(r.scheduleId, deps)).toBe("sent");
    expect(sent).toHaveLength(1);
  });
});

describe("notice", () => {
  const f = { noun: "thread", agentName: "Codex" };
  it("says what happened and what to do, with times and the cause when known", () => {
    expect(notice("late", "Codex in shop", NOW, { ...f, dueAt: NOW - 3_600_000 })).toMatch(
      /^Codex in shop: Rewake was due to continue the thread at .+ today, but couldn't run then \(the computer may have been off or asleep\)\. Open the thread to continue\.$/,
    );
    expect(notice("far-reset", "Codex", NOW, { ...f, resetsAt: NOW + 3 * 86_400_000 })).toMatch(
      /^Codex is limited again until \w+ at .+, so Rewake didn't continue\. Open the thread after that to continue\.$/,
    );
    expect(notice("expired", "Codex in shop", NOW, { ...f, resetsAt: NOW + 3_600_000 })).toMatch(
      /^Codex in shop is still at its usage limit, so Rewake didn't continue\. Open the thread after .+ today to continue\.$/,
    );
    expect(notice("failed", "Codex in shop", NOW, { ...f, cause: "signed-out" })).toBe(
      "Codex in shop: Rewake couldn't continue the thread because you're signed out of Codex. Sign in, then open the thread to continue.",
    );
    expect(notice("failed", "Codex in shop", NOW, { ...f, cause: "archived" })).toBe(
      "Codex in shop: Rewake couldn't continue the thread because it's archived. Unarchive it, then open the thread to continue.",
    );
    expect(notice("failed", "Grok Build", NOW, { noun: "session", agentName: "Grok Build" })).toBe(
      "Grok Build: Rewake couldn't continue the session. Open the session to continue.",
    );
  });
});

describe("fire keeps the computer awake while the resumed turn runs", () => {
  it("holds during the send, as the setting says, and lets go after, even on failure", async () => {
    for (const send of [{ ok: true } as const, { ok: false, reason: "failed" } as const]) {
      const r = resume();
      const { deps } = setup({ send });
      const events: string[] = [];
      const host = deps.hosts.get("test") as HostAdapter;
      const realSend = host.send;
      host.send = async (s, key) => {
        events.push("send");
        return realSend(s, key);
      };
      const wake = {
        supported: true,
        set: (want: boolean, mode: string) => {
          events.push(`hold ${want} ${mode}`);
          return true;
        },
        release: () => {
          events.push("release");
        },
      };
      await fire(r.scheduleId, { ...deps, wake });
      expect(events).toEqual(["hold true plugged-in", "send", "release"]);
    }
  });
});

describe("resumeDeadline", () => {
  it("stops a resume run that goes on too long, and says so", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    const timedOut = resumeDeadline(child, 200);
    await new Promise((r) => child.once("exit", r));
    expect(timedOut()).toBe(true);
  });

  it("leaves a run that finishes in time alone", async () => {
    const child = spawn(process.execPath, ["-e", "0"]);
    const timedOut = resumeDeadline(child, 10_000);
    await new Promise((r) => child.once("exit", r));
    expect(timedOut()).toBe(false);
  });
});

describe("agentProcess", () => {
  it("skips the shells an agent starts hooks through, and gives the agent", async () => {
    const { agentProcess, stillRunning } = await import("../src/util/proc.js");
    const tree: Record<number, { ppid: number; name: string }> = {
      300: { ppid: 200, name: "sh" },
      200: { ppid: 100, name: "copilot" },
    };
    const ps = (pid: number) => tree[pid];
    expect(agentProcess(300, "darwin", ps)).toEqual({ pid: 200, name: "copilot" });
    expect(agentProcess(300, "win32", ps)).toBeUndefined();
    expect(stillRunning({ pid: 200, name: "copilot" }, () => true, ps)).toBe(true);
    // The PID now belongs to another program.
    expect(stillRunning({ pid: 200, name: "node" }, () => true, ps)).toBe(false);
    expect(stillRunning({ pid: 200, name: "copilot" }, () => false, ps)).toBe(false);
  });
});

describe("fire from a timer", () => {
  it("uses the state folder the timer names, not the default one", async () => {
    const { main } = await import("../src/cli.js");
    // An id with no resume there: "gone", and nothing is written outside that folder.
    expect(
      await main(["fire", "0f6c3a1e-6b1d-4d7a-9a51-2b8c4f1e9d10", "--state-dir", dir], {}),
    ).toBe(0);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "logs"))).toBe(true);
  });
});

describe("a failed resume keeps the agent's own reason", () => {
  it("stores the agent's last error line with the failed resume", async () => {
    const r = resume();
    const { deps } = setup({
      send: { ok: false, reason: "failed", detail: "exit 1", message: "No session matched 'abc'." },
    });
    await fire(r.scheduleId, deps);
    expect(new ScheduleStore(deps.stateDir).get(r.scheduleId)).toMatchObject({
      status: "failed",
      failureMessage: "No session matched 'abc'.",
    });
  });
});
