import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../util/paths.js";

/**
 * One-shot OS timers: at a resume's time, the operating system runs `<node> <cli> fire <id>` once.
 * No Rewake process waits in the background. Each timer removes itself (or is removed by `fire`),
 * and `fire` re-checks everything, so a timer that runs early, late or twice does no harm.
 *
 * Facts this relies on (tested 2026-10-06 unless marked; research/impl-codex-grok-2026-10-06.md §5):
 *   - macOS (launchd, macOS 26.5): a plist loaded with `launchctl bootstrap gui/<uid>` from outside
 *     ~/Library/LaunchAgents runs at its StartCalendarInterval (local time, minute precision) and,
 *     with RunAtLoad, once at load. Plists there aren't recorded as background items, so no
 *     "Background Items Added" notice. A job can't boot itself out synchronously (that kills it),
 *     so `fire` boots it out from a detached child after it exits.
 *   - Linux (systemd 255): `systemd-run --user --on-calendar=<UTC time>` fires on the second and
 *     removes both transient units afterwards; a duplicate unit name is refused; a time in the past
 *     never fires, so such a resume is fired directly. Without a user manager ("No medium found",
 *     WSL without systemd, containers): `at` if atd runs, else no timer.
 *   - Windows (Task Scheduler): from Microsoft's documentation, untested. `schtasks /Create /XML`
 *     (an ISO time, not the locale-dependent /SD date), StartWhenAvailable for missed starts,
 *     an EndBoundary with DeleteExpiredTaskAfter so Windows removes a task that never ran.
 */

/** Schedule ids (UUIDs) and test ids: the only text ever placed in a timer's name or command. */
const ID = /^[a-z0-9-]{1,64}$/;

export type TimerKind = "launchd" | "systemd" | "at" | "schtasks";

export type ArmResult =
  | { ok: true; via: TimerKind }
  | { ok: false; reason: "no-scheduler" | "failed"; detail?: string };

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface TimerHost {
  platform: NodeJS.Platform;
  /** Rewake's state folder; timer files live in `<stateDir>/timers`. */
  stateDir: string;
  /** The program the timer runs: absolute Node and the stable CLI file, then `fire <id>`. */
  node: string;
  cli: string;
  /** Run a command without a shell and wait for it (5 s timeout). */
  run: (command: string, args: string[], input?: string) => RunResult;
  /** Start a command that outlives this process. */
  detached: (command: string, args: string[]) => void;
  exists: (path: string) => boolean;
  uid: () => number | undefined;
}

export function defaultTimerHost(stateDir: string, node: string, cli: string): TimerHost {
  return {
    platform: process.platform,
    stateDir,
    node,
    cli,
    run: (command, args, input) => {
      const r = spawnSync(command, args, {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        ...(input !== undefined && { input }),
      });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    detached: (command, args) => {
      try {
        spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } catch {
        // Best effort: the next sweep tidies up.
      }
    },
    exists: existsSync,
    uid: () => process.getuid?.(),
  };
}

export const label = (id: string) => `codizelabs.agent-rewake.${id}`;
export const unit = (id: string) => `codizelabs-agent-rewake-${id}`;
export const taskName = (id: string) => `\\AgentRewake\\${id}`;

function timersDir(h: TimerHost): string {
  return ensurePrivateDir(join(h.stateDir, "timers"));
}

function checkId(id: string): void {
  if (!ID.test(id)) throw new Error(`invalid timer id: ${id}`);
}

// ---- macOS: launchd ------------------------------------------------------------------------------

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The plist for one timer. Local wall-clock fields, rounded up to the next whole minute. */
export function launchdPlist(id: string, at: number, node: string, cli: string): string {
  const d = new Date(Math.ceil(at / 60_000) * 60_000);
  const int = (k: string, v: number) => `<key>${k}</key><integer>${v}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(id)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>fire</string><string>${id}</string></array>
  <key>StartCalendarInterval</key>
  <dict>${int("Month", d.getMonth() + 1)}${int("Day", d.getDate())}${int("Hour", d.getHours())}${int("Minute", d.getMinutes())}</dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

function launchdTarget(h: TimerHost): string | undefined {
  const uid = h.uid();
  return uid === undefined ? undefined : `gui/${uid}`;
}

function launchdArm(id: string, at: number, h: TimerHost): ArmResult {
  const domain = launchdTarget(h);
  if (!domain) return { ok: false, reason: "no-scheduler" };
  const plist = join(timersDir(h), `${label(id)}.plist`);
  // Re-arming: take the old one out first (a loaded label can't be bootstrapped again).
  h.run("launchctl", ["bootout", `${domain}/${label(id)}`]);
  writeFileSync(plist, launchdPlist(id, at, h.node, h.cli), { mode: 0o600 });
  const r = h.run("launchctl", ["bootstrap", domain, plist]);
  if (r.status === 0) return { ok: true, via: "launchd" };
  rmSync(plist, { force: true });
  return { ok: false, reason: "failed", detail: r.stderr.trim() };
}

// ---- Linux: systemd user timers, then at ----------------------------------------------------------

function systemdAvailable(h: TimerHost): boolean {
  if (!h.exists("/run/systemd/system")) return false;
  const r = h.run("systemctl", ["--user", "is-system-running"]);
  return /^(running|degraded)\b/.test(r.stdout.trim());
}

/** "2026-10-06 18:43:00 UTC", the calendar form systemd-run takes. */
export function utcCalendar(at: number): string {
  return `${new Date(Math.ceil(at / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function systemdArm(id: string, at: number, h: TimerHost): ArmResult {
  h.run("systemctl", ["--user", "stop", `${unit(id)}.timer`]);
  const r = h.run("systemd-run", [
    "--user",
    `--unit=${unit(id)}`,
    `--on-calendar=${utcCalendar(at)}`,
    "--timer-property=AccuracySec=1s",
    "--timer-property=Persistent=true",
    `--description=Agent Rewake: ${id}`,
    h.node,
    h.cli,
    "fire",
    id,
  ]);
  return r.status === 0
    ? { ok: true, via: "systemd" }
    : { ok: false, reason: "failed", detail: r.stderr.trim() };
}

/** `at -t` time: [[CC]YY]MMDDhhmm, local time, rounded up to the next minute. */
export function atTime(at: number): string {
  const d = new Date(Math.ceil(at / 60_000) * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

/** A path quoted for sh: `at` runs its job through the shell (the id is checked against ID). */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function atAvailable(h: TimerHost): boolean {
  return h.run("atq", []).status === 0;
}

function atArm(id: string, at: number, h: TimerHost): ArmResult {
  atCancel(id, h);
  const job = `${shQuote(h.node)} ${shQuote(h.cli)} fire ${id}\n`;
  const r = h.run("at", ["-t", atTime(at)], job);
  const n = /job (\d+)/.exec(`${r.stderr}\n${r.stdout}`)?.[1];
  if (r.status !== 0 || !n) return { ok: false, reason: "failed", detail: r.stderr.trim() };
  writeFileSync(join(timersDir(h), `${id}.at`), n, { mode: 0o600 });
  return { ok: true, via: "at" };
}

function atJob(id: string, h: TimerHost): string | undefined {
  try {
    const n = readFileSync(join(h.stateDir, "timers", `${id}.at`), "utf8").trim();
    return /^\d+$/.test(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function atCancel(id: string, h: TimerHost): void {
  const n = atJob(id, h);
  if (n) h.run("atrm", [n]);
  rmSync(join(h.stateDir, "timers", `${id}.at`), { force: true });
}

// ---- Windows: Task Scheduler (documented, untested) ---------------------------------------------

/** An ISO time with the local offset, which Task Scheduler reads regardless of locale. */
export function localIso(at: number): string {
  const d = new Date(Math.ceil(at / 1000) * 1000);
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

export function taskXml(id: string, at: number, node: string, cli: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Agent Rewake: ${id}</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${localIso(at)}</StartBoundary>
      <EndBoundary>${localIso(at + 7 * 24 * 3_600_000)}</EndBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DeleteExpiredTaskAfter>PT1H</DeleteExpiredTaskAfter>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${xml(node)}</Command><Arguments>"${xml(cli)}" fire ${id}</Arguments></Exec>
  </Actions>
</Task>
`;
}

function schtasksArm(id: string, at: number, h: TimerHost): ArmResult {
  h.run("schtasks", ["/Delete", "/TN", taskName(id), "/F"]);
  const file = join(timersDir(h), `${id}.xml`);
  // UTF-16LE with a byte-order mark, as the XML declaration says.
  writeFileSync(file, Buffer.from(`﻿${taskXml(id, at, h.node, h.cli)}`, "utf16le"));
  const r = h.run("schtasks", ["/Create", "/TN", taskName(id), "/XML", file]);
  rmSync(file, { force: true });
  return r.status === 0
    ? { ok: true, via: "schtasks" }
    : { ok: false, reason: "failed", detail: r.stderr.trim() };
}

// ---- The three operations --------------------------------------------------------------------------

/** Which timer this computer offers, checked now (Linux depends on the session). */
export function timerKind(h: TimerHost): TimerKind | undefined {
  if (h.platform === "darwin") return launchdTarget(h) ? "launchd" : undefined;
  if (h.platform === "win32") return "schtasks";
  if (h.platform === "linux") {
    if (systemdAvailable(h)) return "systemd";
    if (atAvailable(h)) return "at";
  }
  return undefined;
}

/** Arm (or re-arm) the timer for `id` at `at`. Callers fire directly instead of arming a time
 * that has passed or is under 30 s away (systemd never fires a past time). */
export function armTimer(id: string, at: number, h: TimerHost): ArmResult {
  checkId(id);
  const kind = timerKind(h);
  if (kind === "launchd") return launchdArm(id, at, h);
  if (kind === "systemd") return systemdArm(id, at, h);
  if (kind === "at") return atArm(id, at, h);
  if (kind === "schtasks") return schtasksArm(id, at, h);
  return { ok: false, reason: "no-scheduler" };
}

/** Whether `id` has a live timer. */
export function timerArmed(id: string, h: TimerHost): boolean {
  checkId(id);
  const kind = timerKind(h);
  if (kind === "launchd") {
    const domain = launchdTarget(h);
    return (
      domain !== undefined && h.run("launchctl", ["print", `${domain}/${label(id)}`]).status === 0
    );
  }
  if (kind === "systemd")
    return (
      h.run("systemctl", ["--user", "is-active", `${unit(id)}.timer`]).stdout.trim() === "active"
    );
  if (kind === "at") {
    const n = atJob(id, h);
    return n !== undefined && new RegExp(`^${n}\\s`, "m").test(h.run("atq", []).stdout);
  }
  if (kind === "schtasks") return h.run("schtasks", ["/Query", "/TN", taskName(id)]).status === 0;
  return false;
}

/**
 * Remove `id`'s timer. `fromInsideTimer`: called by the timer's own `fire` on macOS, where a job
 * can't boot itself out without being killed, so a detached child does it after a second.
 */
export function cancelTimer(id: string, h: TimerHost, fromInsideTimer = false): void {
  checkId(id);
  const kind = timerKind(h);
  if (kind === "launchd") {
    rmSync(join(h.stateDir, "timers", `${label(id)}.plist`), { force: true });
    const domain = launchdTarget(h);
    if (!domain) return;
    if (fromInsideTimer)
      h.detached("/bin/sh", ["-c", `sleep 1; launchctl bootout ${domain}/${label(id)}`]);
    else h.run("launchctl", ["bootout", `${domain}/${label(id)}`]);
  } else if (kind === "systemd") h.run("systemctl", ["--user", "stop", `${unit(id)}.timer`]);
  else if (kind === "at") atCancel(id, h);
  else if (kind === "schtasks") h.run("schtasks", ["/Delete", "/TN", taskName(id), "/F"]);
}
