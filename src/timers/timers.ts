import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../util/paths.js";

/**
 * One-shot OS timers: at a resume's time, the operating system runs `<node> <cli> fire <id>` once.
 * No Rewake process waits in the background. Each timer removes itself (or is removed by `fire`),
 * and `fire` re-checks everything, so a timer that runs early, late or twice does no harm.
 *
 * Every timer names Rewake's state folder (`fire <id> --state-dir <dir>`): a timer runs without
 * Rewake's environment, so AGENT_REWAKE_STATE_DIR wouldn't reach `fire` otherwise.
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
 *     WSL without systemd, containers): `at` if atd runs, else Rewake's own waiter (waiter.ts): one
 *     background process that runs `fire` at each time and ends when nothing is left to wait for.
 *   - A timer can't safely replace itself (launchd kills a job booted out from inside it; systemd
 *     refuses a unit name whose service is still running), so a resume re-armed from inside its own
 *     `fire` gets a new name, `<id>-r<n>`, and the older names are removed. Each armed name leaves a
 *     file in `<stateDir>/timers`, which is how every name of a resume is found again.
 *   - Windows (Task Scheduler): from Microsoft's documentation; the CI timer job runs it. Node runs
 *     under `conhost.exe --headless`, so a timer opens no console window (research X-T4). `schtasks /Create /XML`
 *     (an ISO time, not the locale-dependent /SD date), StartWhenAvailable for missed starts,
 *     an EndBoundary with DeleteExpiredTaskAfter so Windows removes a task that never ran.
 */

/** Schedule ids (UUIDs) and test ids: the only text ever placed in a timer's name or command. */
const ID = /^[a-z0-9-]{1,64}$/;

export type TimerKind = "launchd" | "systemd" | "at" | "schtasks" | "waiter";

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
  /** Whether Rewake's waiter (waiter.ts) runs, under process id `pid`. */
  waiterRunning?: (pid: number) => boolean;
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
    waiterRunning: (pid) => isWaiter(pid, cli),
  };
}

export const label = (id: string) => `codizelabs.agent-rewake.${id}`;

/** A timer's name: the resume's id, then `-r<n>` for the n-th re-arm from inside a timer. */
export function timerName(id: string, gen = 0): string {
  return gen > 0 ? `${id}-r${gen}` : id;
}

/** The resume id and generation in a timer's name (UUIDs never contain "-r<digits>" at the end). */
export function parseTimerName(name: string): { id: string; gen: number } {
  const m = /^(.+)-r(\d{1,3})$/.exec(name);
  return m?.[1] ? { id: m[1], gen: Number(m[2]) } : { id: name, gen: 0 };
}
export const unit = (id: string) => `codizelabs-agent-rewake-${id}`;
export const taskName = (id: string) => `\\AgentRewake\\${id}`;

function timersDir(h: TimerHost): string {
  return ensurePrivateDir(join(h.stateDir, "timers"));
}

function checkId(id: string): void {
  if (!ID.test(id)) throw new Error(`invalid timer id: ${id}`);
}

/** Marker files for timers that leave no file of their own (systemd units, scheduled tasks). */
const MARK: Partial<Record<TimerKind, string>> = { systemd: ".systemd", schtasks: ".task" };

function mark(name: string, kind: TimerKind, h: TimerHost): void {
  const ext = MARK[kind];
  if (ext) writeFileSync(join(timersDir(h), `${name}${ext}`), "", { mode: 0o600 });
}

/** Every timer name armed for `id` (the bare id always included, for timers armed before names). */
export function timerNames(id: string, h: TimerHost): string[] {
  const names = new Set([id]);
  let files: string[] = [];
  try {
    files = readdirSync(join(h.stateDir, "timers"));
  } catch {
    // No timers yet.
  }
  for (const f of files) {
    const name = f
      .replace(/^codizelabs\.agent-rewake\./, "")
      .replace(/\.(plist|systemd|task|at|at-time|wait)$/, "");
    if (name !== f && ID.test(name) && parseTimerName(name).id === id) names.add(name);
  }
  return [...names];
}

// ---- macOS: launchd ------------------------------------------------------------------------------

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The plist for one timer. Local wall-clock fields, rounded up to the next whole minute. */
export function launchdPlist(
  id: string,
  at: number,
  node: string,
  cli: string,
  stateDir?: string,
): string {
  const d = new Date(Math.ceil(at / 60_000) * 60_000);
  const int = (k: string, v: number) => `<key>${k}</key><integer>${v}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(id)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>fire</string><string>${id}</string>${stateDir ? `<string>--state-dir</string><string>${xml(stateDir)}</string>` : ""}</array>
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
  // A loaded label can't be bootstrapped again: armTimer has already taken out the resume's
  // timers (generation 0), and a higher generation's name is new.
  writeFileSync(plist, launchdPlist(id, at, h.node, h.cli, h.stateDir), { mode: 0o600 });
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
  // A finished one-shot unit can linger as "failed" and block its name.
  h.run("systemctl", ["--user", "reset-failed", `${unit(id)}.timer`, `${unit(id)}.service`]);
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
    "--state-dir",
    h.stateDir,
  ]);
  if (r.status !== 0) return { ok: false, reason: "failed", detail: r.stderr.trim() };
  mark(id, "systemd", h);
  return { ok: true, via: "systemd" };
}

/** `at -t` time: [[CC]YY]MMDDhhmm, local time, rounded up to the next minute. */
export function atTime(at: number): string {
  const d = new Date(Math.ceil(at / 60_000) * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

/** A path quoted for sh: `at` runs its job through the shell (the id is checked against ID). */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `at` only helps when its daemon runs: `atq` answers without it, and jobs would never start. */
function atAvailable(h: TimerHost): boolean {
  if (h.run("atq", []).status !== 0) return false;
  const pg = h.run("pgrep", ["-x", "atd"]);
  // No pgrep (status null, or 127 from a shell): trust atq, as before.
  return pg.status === 0 || pg.status === null || pg.status === 127;
}

function atArm(id: string, at: number, h: TimerHost): ArmResult {
  atCancel(id, h);
  const job = `${shQuote(h.node)} ${shQuote(h.cli)} fire ${id} --state-dir ${shQuote(h.stateDir)}\n`;
  const r = h.run("at", ["-t", atTime(at)], job);
  const n = /job (\d+)/.exec(`${r.stderr}\n${r.stdout}`)?.[1];
  if (r.status !== 0 || !n) return { ok: false, reason: "failed", detail: r.stderr.trim() };
  writeFileSync(join(timersDir(h), `${id}.at`), n, { mode: 0o600 });
  // What it was armed with, for timerStale (`at` takes local time).
  writeFileSync(join(timersDir(h), `${id}.at-time`), `${atTime(at)} ${h.node} ${h.cli}`, {
    mode: 0o600,
  });
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
  rmSync(join(h.stateDir, "timers", `${id}.at-time`), { force: true });
}

// ---- Linux without systemd or at: Rewake's waiter -------------------------------------------------

/** Each resume the waiter runs leaves `<name>.wait` holding its time; the waiter, `waiter.pid`. */
const waiterPid = (h: TimerHost) => join(h.stateDir, "timers", "waiter.pid");

/** The waiter's process id, when it's running. */
export function waiterAlive(h: TimerHost): number | undefined {
  try {
    const pid = Number(readFileSync(waiterPid(h), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && (h.waiterRunning?.(pid) ?? false) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `pid` is Rewake's waiter: a check of its command line, so a reused id doesn't count. */
function isWaiter(pid: number, cli: string): boolean {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return args.includes(cli) && args.includes("wait");
  } catch {
    return false;
  }
}

function waiterArm(id: string, at: number, h: TimerHost): ArmResult {
  writeFileSync(join(timersDir(h), `${id}.wait`), String(at), { mode: 0o600 });
  // One waiter for every resume: started when none runs; a running one reads the new file.
  if (waiterAlive(h) === undefined) h.detached(h.node, [h.cli, "wait", "--state-dir", h.stateDir]);
  return { ok: true, via: "waiter" };
}

function waiterHas(name: string, h: TimerHost): boolean {
  return existsSync(join(h.stateDir, "timers", `${name}.wait`)) && waiterAlive(h) !== undefined;
}

// ---- Windows: Task Scheduler (documented, untested) ---------------------------------------------

/** An ISO time with the local offset, which Task Scheduler reads regardless of locale. */
export function localIso(at: number): string {
  const d = new Date(Math.ceil(at / 1000) * 1000);
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

export function taskXml(
  id: string,
  at: number,
  node: string,
  cli: string,
  stateDir?: string,
): string {
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
    <Exec><Command>conhost.exe</Command><Arguments>--headless "${xml(node)}" "${xml(cli)}" fire ${id}${stateDir ? ` --state-dir "${xml(stateDir)}"` : ""}</Arguments></Exec>
  </Actions>
</Task>
`;
}

function schtasksArm(id: string, at: number, h: TimerHost): ArmResult {
  h.run("schtasks", ["/Delete", "/TN", taskName(id), "/F"]);
  const file = join(timersDir(h), `${id}.xml`);
  // UTF-16LE with a byte-order mark, as the XML declaration says.
  writeFileSync(file, Buffer.from(`﻿${taskXml(id, at, h.node, h.cli, h.stateDir)}`, "utf16le"));
  const r = h.run("schtasks", ["/Create", "/TN", taskName(id), "/XML", file]);
  rmSync(file, { force: true });
  if (r.status !== 0) return { ok: false, reason: "failed", detail: r.stderr.trim() };
  mark(id, "schtasks", h);
  return { ok: true, via: "schtasks" };
}

// ---- The three operations --------------------------------------------------------------------------

/** Which timer this computer offers, checked now (Linux depends on the session). */
export function timerKind(h: TimerHost): TimerKind | undefined {
  if (h.platform === "darwin") return launchdTarget(h) ? "launchd" : undefined;
  if (h.platform === "win32") return "schtasks";
  if (h.platform === "linux") {
    if (systemdAvailable(h)) return "systemd";
    if (atAvailable(h)) return "at";
    return "waiter";
  }
  return undefined;
}

/**
 * Arm the timer for `id` at `at`. Generation 0 (any caller outside a timer) first removes every
 * timer the resume has; a higher generation (`fire` re-arming from inside its own timer) arms a new
 * name and leaves the running one alone, for `fire` to remove. Callers fire directly instead of
 * arming a time that has passed or is under 30 s away (systemd never fires a past time).
 */
export function armTimer(id: string, at: number, h: TimerHost, gen = 0): ArmResult {
  checkId(id);
  const name = timerName(id, gen);
  checkId(name);
  const kind = timerKind(h);
  if (!kind) return { ok: false, reason: "no-scheduler" };
  if (gen === 0) cancelTimer(id, h);
  if (kind === "launchd") return launchdArm(name, at, h);
  if (kind === "systemd") return systemdArm(name, at, h);
  if (kind === "at") return atArm(name, at, h);
  if (kind === "waiter") return waiterArm(name, at, h);
  return schtasksArm(name, at, h);
}

/** The next free generation for a re-arm from inside a timer running generation `current`. */
export function nextGen(id: string, current: number, h: TimerHost): number {
  const used = timerNames(id, h).map((n) => parseTimerName(n).gen);
  return Math.max(current, ...used) + 1;
}

function nameArmed(name: string, kind: TimerKind, h: TimerHost): boolean {
  if (kind === "launchd") {
    const domain = launchdTarget(h);
    return (
      domain !== undefined && h.run("launchctl", ["print", `${domain}/${label(name)}`]).status === 0
    );
  }
  if (kind === "systemd")
    return (
      h.run("systemctl", ["--user", "is-active", `${unit(name)}.timer`]).stdout.trim() === "active"
    );
  if (kind === "at") {
    const n = atJob(name, h);
    return n !== undefined && new RegExp(`^${n}\\s`, "m").test(h.run("atq", []).stdout);
  }
  if (kind === "waiter") return waiterHas(name, h);
  return h.run("schtasks", ["/Query", "/TN", taskName(name)]).status === 0;
}

/**
 * Whether `id`'s timer would fire at the wrong moment or run the wrong program: launchd and `at`
 * take local wall-clock times, so a change of time zone moves them, and a timer keeps the Node.js
 * path it was armed with. True when the timer on file no longer matches what arming it for `at`
 * now would write (systemd and Task Scheduler take absolute times and are checked by name only).
 */
export function timerStale(id: string, at: number, h: TimerHost): boolean {
  checkId(id);
  const kind = timerKind(h);
  const dir = join(h.stateDir, "timers");
  if (kind === "launchd") {
    const names = timerNames(id, h).filter((n) => existsSync(join(dir, `${label(n)}.plist`)));
    if (names.length === 0) return false;
    return !names.some(
      (n) =>
        readFileSync(join(dir, `${label(n)}.plist`), "utf8") ===
        launchdPlist(n, at, h.node, h.cli, h.stateDir),
    );
  }
  if (kind === "at") {
    const marks = timerNames(id, h).filter((n) => existsSync(join(dir, `${n}.at-time`)));
    if (marks.length === 0) return false;
    const want = `${atTime(at)} ${h.node} ${h.cli}`;
    return !marks.some((n) => readFileSync(join(dir, `${n}.at-time`), "utf8") === want);
  }
  return false;
}

/** Whether `id` has a live timer, under any of its names. */
export function timerArmed(id: string, h: TimerHost): boolean {
  checkId(id);
  const kind = timerKind(h);
  if (!kind) return false;
  return timerNames(id, h).some((name) => nameArmed(name, kind, h));
}

/**
 * Remove `id`'s timers, every name but `keep`. `fromInsideTimer`: called by a timer's own `fire` on
 * macOS, where a job can't boot itself out without being killed, so a detached child does it after
 * two seconds, once `fire` has exited.
 */
export function cancelTimer(
  id: string,
  h: TimerHost,
  fromInsideTimer = false,
  keep?: string,
): void {
  checkId(id);
  const kind = timerKind(h);
  for (const name of timerNames(id, h)) {
    if (name === keep) continue;
    const dir = join(h.stateDir, "timers");
    if (kind === "launchd") {
      const plist = join(dir, `${label(name)}.plist`);
      const had = existsSync(plist);
      rmSync(plist, { force: true });
      const domain = launchdTarget(h);
      if (!domain || (!had && name !== id)) continue;
      if (fromInsideTimer)
        h.detached("/bin/sh", ["-c", `sleep 2; launchctl bootout ${domain}/${label(name)}`]);
      else h.run("launchctl", ["bootout", `${domain}/${label(name)}`]);
    } else if (kind === "systemd") {
      h.run("systemctl", ["--user", "stop", `${unit(name)}.timer`]);
      rmSync(join(dir, `${name}.systemd`), { force: true });
    } else if (kind === "at") atCancel(name, h);
    else if (kind === "waiter") rmSync(join(dir, `${name}.wait`), { force: true });
    else if (kind === "schtasks") {
      h.run("schtasks", ["/Delete", "/TN", taskName(name), "/F"]);
      rmSync(join(dir, `${name}.task`), { force: true });
    }
  }
}
