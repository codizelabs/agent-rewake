import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerHost, ScheduleStore } from "../src/core/store.js";
import type { HostAdapter } from "../src/hosts/host.js";
import { OWNER_ENV, ownedByZed } from "../src/hosts/index.js";
import { ensureLauncher, launcherPath } from "../src/timers/launcher.js";
import { appleString, osNotifier } from "../src/timers/notify.js";
import { FIRE_NOW_MS, type SweepDeps, scheduleFire, sweep } from "../src/timers/sweep.js";
import type { TimerHost } from "../src/timers/timers.js";

registerHost("test");

const NOW = Date.parse("2026-10-07T12:00:00Z");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-sweep-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const host = { id: "test", name: "Test" } as HostAdapter;

function deps(live: Set<string> = new Set()) {
  const fired: string[] = [];
  const armed: string[] = [];
  const timers: TimerHost = {
    platform: "linux",
    stateDir: dir,
    node: "/n",
    cli: "/c.mjs",
    run: (command, args) => {
      if (command === "systemd-run")
        armed.push(args[1]?.replace("--unit=codizelabs-agent-rewake-", "") ?? "");
      const unit = args.at(-1) ?? "";
      return {
        status: 0,
        stdout: args.includes("is-system-running")
          ? "running\n"
          : args.includes("is-active")
            ? [...live].some((id) => unit.includes(id))
              ? "active\n"
              : "inactive\n"
            : "",
        stderr: "",
      };
    },
    detached: () => {},
    exists: () => true,
    uid: () => 1000,
  };
  const d: SweepDeps = {
    stateDir: dir,
    now: NOW,
    hosts: new Map([["test", host]]),
    timers,
    fireDetached: (id) => fired.push(id),
  };
  return { d, fired, armed };
}

function add(dueAt: number, extra: Record<string, unknown> = { host: "test" }) {
  const store = new ScheduleStore(dir);
  const s = store.create({
    sessionId: "t",
    cwd: "/p",
    text: "Continue.",
    dueAt,
    kind: "limit_resume",
    createdBy: "auto",
    now: NOW - 1000,
  });
  store.put({ ...s, ...extra });
  return s.scheduleId;
}

describe("sweep", () => {
  it("fires due resumes, re-arms lost timers, and leaves live ones and Zed's alone", () => {
    const due = add(NOW + FIRE_NOW_MS - 1);
    const lost = add(NOW + 3_600_000);
    const live = add(NOW + 7_200_000);
    add(NOW - 1000, {}); // a Zed schedule: the add-on delivers it
    const { d, fired, armed } = deps(new Set([live]));
    expect(sweep(d)).toEqual({ fired: 1, armed: 1 });
    expect(fired).toEqual([due]);
    expect(armed).toEqual([lost]);
  });

  it("does nothing when no integration outside Zed is installed", () => {
    add(NOW - 1000);
    const { d, fired } = deps();
    expect(sweep({ ...d, hosts: new Map() })).toEqual({ fired: 0, armed: 0 });
    expect(fired).toEqual([]);
  });
});

describe("scheduleFire", () => {
  it("fires at once instead of arming a time that's close or past", () => {
    const { d, fired } = deps();
    const { timers: _t, ...withoutTimers } = d;
    expect(scheduleFire("abc", NOW + 10_000, d)).toBe("fired");
    expect(fired).toEqual(["abc"]);
    expect(scheduleFire("abc", NOW + 3_600_000, d)).toEqual({ ok: true, via: "systemd" });
    expect(scheduleFire("abc", NOW + 3_600_000, withoutTimers)).toEqual({
      ok: false,
      reason: "no-scheduler",
    });
  });
});

describe("stable launcher", () => {
  it("copies the bundle to a fixed path in a private folder, and only when it changed", () => {
    const bundle = join(dir, "agent-rewake.js");
    writeFileSync(bundle, "console.log(1);\n");
    const state = join(dir, "state");
    expect(ensureLauncher(state, bundle)).toBe(launcherPath(state));
    expect(readFileSync(launcherPath(state), "utf8")).toBe("console.log(1);\n");
    if (process.platform !== "win32") expect(statSync(join(state, "bin")).mode & 0o777).toBe(0o700);
    const first = statSync(launcherPath(state)).mtimeMs;
    ensureLauncher(state, bundle);
    expect(statSync(launcherPath(state)).mtimeMs).toBe(first);
    writeFileSync(bundle, "console.log(2);\n");
    ensureLauncher(state, bundle);
    expect(readFileSync(launcherPath(state), "utf8")).toBe("console.log(2);\n");
  });

  it("does nothing when running from source", () => {
    expect(ensureLauncher(dir, join(dir, "missing.js"))).toBeUndefined();
    expect(ensureLauncher(dir, join(dir, "main.ts"))).toBeUndefined();
    expect(existsSync(join(dir, "bin"))).toBe(false);
  });
});

describe("notifications", () => {
  it("passes the text to osascript as one escaped AppleScript string, with no shell", () => {
    const calls: string[][] = [];
    const notify = osNotifier("darwin", (c, a) => {
      calls.push([c, ...a]);
      return 0;
    });
    expect(notify("Agent Rewake", 'Say "hi" \\ bye\nnow')).toBe(true);
    expect(calls).toEqual([
      [
        "osascript",
        "-e",
        'display notification "Say \\"hi\\" \\\\ bye now" with title "Agent Rewake"',
      ],
    ]);
    expect(appleString('a"b')).toBe('"a\\"b"');
  });

  it("uses notify-send on Linux, and shows nothing on Windows yet", () => {
    const calls: string[][] = [];
    const run = (c: string, a: string[]) => {
      calls.push([c, ...a]);
      return 0;
    };
    expect(osNotifier("linux", run)("T", "B")).toBe(true);
    expect(calls).toEqual([["notify-send", "--app-name=Agent Rewake", "T", "B"]]);
    expect(osNotifier("win32", run)("T", "B")).toBe(false);
  });
});

describe("one owner per session", () => {
  it("recognises sessions the Zed add-on started", () => {
    expect(ownedByZed({ [OWNER_ENV]: "acp" })).toBe(true);
    expect(ownedByZed({})).toBe(false);
  });
});
