import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  armTimer,
  atTime,
  cancelTimer,
  label,
  launchdPlist,
  localIso,
  nextGen,
  parseTimerName,
  type RunResult,
  type TimerHost,
  taskXml,
  timerArmed,
  timerKind,
  timerName,
  timerNames,
  utcCalendar,
} from "../src/timers/timers.js";

const ID = "0f6c3a1e-6b1d-4d7a-9a51-2b8c4f1e9d10";
const AT = Date.UTC(2026, 9, 6, 18, 43, 20);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-timers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { command: string; args: string[]; input?: string };

function fakeHost(
  platform: NodeJS.Platform,
  answer: (c: Call) => Partial<RunResult> = () => ({}),
  o: { systemd?: boolean; uid?: number } = {},
): { h: TimerHost; calls: Call[]; detached: Call[] } {
  const calls: Call[] = [];
  const detached: Call[] = [];
  const h: TimerHost = {
    platform,
    stateDir: dir,
    node: "/opt/node/bin/node",
    cli: "/home/me/.local/state/agent-rewake/bin/agent-rewake.js",
    run: (command, args, input) => {
      const call = { command, args, ...(input !== undefined && { input }) };
      calls.push(call);
      return { status: 0, stdout: "", stderr: "", ...answer(call) };
    },
    detached: (command, args) => {
      detached.push({ command, args });
    },
    exists: (p) => p === "/run/systemd/system" && (o.systemd ?? true),
    uid: () => o.uid ?? 501,
  };
  return { h, calls, detached };
}

describe("macOS: launchd", () => {
  it("writes a plist in Rewake's own folder and bootstraps it in the person's session", () => {
    const { h, calls } = fakeHost("darwin");
    expect(armTimer(ID, AT, h)).toEqual({ ok: true, via: "launchd" });
    const plist = join(dir, "timers", `${label(ID)}.plist`);
    expect(existsSync(plist)).toBe(true);
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ["launchctl", "bootout", `gui/501/${label(ID)}`],
      ["launchctl", "bootstrap", "gui/501", plist],
    ]);
  });

  it("runs the stable CLI with no shell, at the local minute after the time", () => {
    const xml = launchdPlist(ID, AT, "/opt/node/bin/node", "/x/agent-rewake.js");
    const d = new Date(Math.ceil(AT / 60_000) * 60_000);
    expect(xml).toContain(
      `<array><string>/opt/node/bin/node</string><string>/x/agent-rewake.js</string><string>fire</string><string>${ID}</string></array>`,
    );
    expect(xml).toContain(`<key>Hour</key><integer>${d.getHours()}</integer>`);
    expect(xml).toContain(`<key>Minute</key><integer>${d.getMinutes()}</integer>`);
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
  });

  it("escapes paths for XML", () => {
    expect(launchdPlist(ID, AT, "/a&b/node", "/c<d>/cli.js")).toContain(
      "<string>/a&amp;b/node</string><string>/c&lt;d&gt;/cli.js</string>",
    );
  });

  it("from inside its own job, boots itself out from a detached child", () => {
    const { h, calls, detached } = fakeHost("darwin");
    armTimer(ID, AT, h);
    calls.length = 0;
    cancelTimer(ID, h, true);
    expect(calls).toEqual([]);
    expect(detached).toEqual([
      { command: "/bin/sh", args: ["-c", `sleep 2; launchctl bootout gui/501/${label(ID)}`] },
    ]);
    expect(existsSync(join(dir, "timers", `${label(ID)}.plist`))).toBe(false);
  });

  it("reports a failed bootstrap and leaves no plist", () => {
    const { h } = fakeHost("darwin", (c) =>
      c.args[0] === "bootstrap" ? { status: 5, stderr: "Bootstrap failed: 5" } : {},
    );
    expect(armTimer(ID, AT, h)).toEqual({
      ok: false,
      reason: "failed",
      detail: "Bootstrap failed: 5",
    });
    expect(existsSync(join(dir, "timers", `${label(ID)}.plist`))).toBe(false);
  });
});

describe("re-arming from inside a timer: a new name", () => {
  it("names generations and reads them back", () => {
    expect(timerName(ID)).toBe(ID);
    expect(timerName(ID, 2)).toBe(`${ID}-r2`);
    expect(parseTimerName(`${ID}-r2`)).toEqual({ id: ID, gen: 2 });
    expect(parseTimerName(ID)).toEqual({ id: ID, gen: 0 });
  });

  it("macOS: arms the new name without touching the running job, then retires the old one", () => {
    const { h, calls, detached } = fakeHost("darwin");
    armTimer(ID, AT, h);
    calls.length = 0;
    const gen = nextGen(ID, 0, h);
    expect(gen).toBe(1);
    expect(armTimer(ID, AT + 600_000, h, gen)).toEqual({ ok: true, via: "launchd" });
    // No bootout of the running job's label: that would kill the `fire` doing this.
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ["launchctl", "bootstrap", "gui/501", join(dir, "timers", `${label(`${ID}-r1`)}.plist`)],
    ]);
    expect(timerNames(ID, h).sort()).toEqual([ID, `${ID}-r1`].sort());
    calls.length = 0;
    cancelTimer(ID, h, true, timerName(ID, gen));
    expect(calls).toEqual([]);
    expect(detached).toEqual([
      { command: "/bin/sh", args: ["-c", `sleep 2; launchctl bootout gui/501/${label(ID)}`] },
    ]);
    expect(timerNames(ID, h)).toEqual(expect.arrayContaining([`${ID}-r1`]));
  });

  it("Linux: a new unit name (systemd refuses a name whose service still runs)", () => {
    const { h, calls } = fakeHost("linux", (c) =>
      c.args.includes("is-system-running") ? { stdout: "running\n" } : {},
    );
    armTimer(ID, AT, h);
    armTimer(ID, AT + 600_000, h, nextGen(ID, 0, h));
    expect(calls.filter((c) => c.command === "systemd-run").map((c) => c.args[1])).toEqual([
      `--unit=codizelabs-agent-rewake-${ID}`,
      `--unit=codizelabs-agent-rewake-${ID}-r1`,
    ]);
    calls.length = 0;
    cancelTimer(ID, h);
    const stopped = calls.filter((c) => c.args[1] === "stop").map((c) => c.args[2]);
    expect(stopped.sort()).toEqual(
      [`codizelabs-agent-rewake-${ID}.timer`, `codizelabs-agent-rewake-${ID}-r1.timer`].sort(),
    );
    expect(timerNames(ID, h)).toEqual([ID]);
  });
});

describe("Linux: systemd, then at", () => {
  const running = (c: Call) =>
    c.args.includes("is-system-running") ? { stdout: "running\n" } : {};

  it("uses a transient user timer at the UTC second", () => {
    const { h, calls } = fakeHost("linux", running);
    expect(armTimer(ID, AT, h)).toEqual({ ok: true, via: "systemd" });
    expect(calls.at(-1)).toEqual({
      command: "systemd-run",
      args: [
        "--user",
        `--unit=codizelabs-agent-rewake-${ID}`,
        `--on-calendar=${utcCalendar(AT)}`,
        "--timer-property=AccuracySec=1s",
        "--timer-property=Persistent=true",
        `--description=Agent Rewake: ${ID}`,
        "/opt/node/bin/node",
        "/home/me/.local/state/agent-rewake/bin/agent-rewake.js",
        "fire",
        ID,
      ],
    });
    expect(utcCalendar(AT)).toBe("2026-10-06 18:43:20 UTC");
  });

  it("doesn't use at when its daemon isn't running (jobs would never start)", () => {
    const { h } = fakeHost("linux", (c) => (c.command === "pgrep" ? { status: 1 } : {}), {
      systemd: false,
    });
    expect(timerKind(h)).toBeUndefined();
  });

  it("falls back to at when there's no user manager, quoting the paths for its shell", () => {
    const { h, calls } = fakeHost(
      "linux",
      (c) => (c.command === "at" ? { stderr: "job 17 at Tue Oct  6 23:44:00 2026\n" } : {}),
      { systemd: false },
    );
    h.cli = "/home/o'brien/agent-rewake.js";
    expect(armTimer(ID, AT, h)).toEqual({ ok: true, via: "at" });
    const at = calls.find((c) => c.command === "at");
    expect(at?.args).toEqual(["-t", atTime(AT)]);
    expect(at?.input).toBe(`'/opt/node/bin/node' '/home/o'\\''brien/agent-rewake.js' fire ${ID}\n`);
    expect(readFileSync(join(dir, "timers", `${ID}.at`), "utf8")).toBe("17");
    cancelTimer(ID, h);
    expect(calls.at(-1)).toEqual({ command: "atrm", args: ["17"] });
  });

  it("has no timer without systemd or at", () => {
    const { h } = fakeHost("linux", (c) => (c.command === "atq" ? { status: 1 } : {}), {
      systemd: false,
    });
    expect(timerKind(h)).toBeUndefined();
    expect(armTimer(ID, AT, h)).toEqual({ ok: false, reason: "no-scheduler" });
  });

  it("checks whether a timer is live", () => {
    const { h } = fakeHost("linux", (c) =>
      c.args.includes("is-system-running")
        ? { stdout: "degraded\n" }
        : c.args.includes("is-active")
          ? { stdout: "active\n" }
          : {},
    );
    expect(timerArmed(ID, h)).toBe(true);
  });
});

describe("Windows: Task Scheduler", () => {
  it("creates the task from XML with an ISO time, and deletes the file after", () => {
    const { h, calls } = fakeHost("win32");
    expect(armTimer(ID, AT, h)).toEqual({ ok: true, via: "schtasks" });
    const create = calls.find((c) => c.args[0] === "/Create");
    expect(create?.args.slice(0, 4)).toEqual(["/Create", "/TN", `\\AgentRewake\\${ID}`, "/XML"]);
    expect(existsSync(create?.args[4] ?? "")).toBe(false);
  });

  it("writes the time with the local offset, a week's end boundary and least privilege", () => {
    const xml = taskXml(ID, AT, "C:\\node\\node.exe", "C:\\state\\bin\\agent-rewake.js");
    expect(xml).toContain(`<StartBoundary>${localIso(AT)}</StartBoundary>`);
    expect(localIso(AT)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain(`<Arguments>"C:\\state\\bin\\agent-rewake.js" fire ${ID}</Arguments>`);
  });
});

describe("ids", () => {
  it("refuses anything but a plain id, so nothing else reaches a timer's command", () => {
    const { h } = fakeHost("linux");
    for (const bad of ["a;rm -rf ~", "A", "../x", "", "x y"])
      expect(() => armTimer(bad, AT, h)).toThrow("invalid timer id");
  });
});
