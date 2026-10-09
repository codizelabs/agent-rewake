import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { isProcessAlive } from "../core/lock.js";

/**
 * The agent process that ran a hook, so Rewake can later tell whether the session is still open
 * when the agent never ran its session-end hook (a crash, a killed terminal). Agents start hooks
 * directly or through a shell; the first ancestor that isn't a shell is the agent. POSIX uses `ps`,
 * Windows one PowerShell call per step (`Get-CimInstance Win32_Process`); where neither answers,
 * Rewake relies on the session-end hook alone, as before.
 */

export interface AgentProcess {
  pid: number;
  /** The program's name as `ps` reports it ("node", "copilot"), to tell a reused PID apart. */
  name: string;
}

const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "env",
  "timeout",
  // Windows: the shells and wrappers an agent's hooks run through.
  "cmd",
  "powershell",
  "pwsh",
  "conhost",
  "wsl",
]);

export type PsRun = (pid: number) => { ppid: number; name: string } | undefined;

const ps: PsRun = (pid) => {
  const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000,
  });
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(r.stdout ?? "");
  return m ? { ppid: Number(m[1]), name: basename(m[2] as string).replace(/^-/, "") } : undefined;
};

/** "node.exe" and "Node.EXE" are both "node": the name a recorded process is compared by. */
const windowsName = (file: string): string =>
  basename(file.trim())
    .replace(/\.exe$/i, "")
    .toLowerCase();

/**
 * The processes on Windows from the lines `<id> <parent id> <name>` that the PowerShell query
 * prints, by id. A line that isn't one is ignored.
 */
export function parseWindowsChain(stdout: string): Map<number, { ppid: number; name: string }> {
  const out = new Map<number, { ppid: number; name: string }>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), name: windowsName(m[3] as string) });
  }
  return out;
}

/** How long a hook may spend asking Windows about processes: hooks have only a few seconds. */
const WINDOWS_QUERY_MS = 2500;

/** The process and up to four of its ancestors, in ONE PowerShell start (each costs about a second). */
function queryWindowsChain(
  pid: number,
  timeoutMs: number,
): Map<number, { ppid: number; name: string }> {
  if (!Number.isInteger(pid) || pid <= 0) return new Map();
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$id = ${pid}; for ($i = 0; $i -lt 5 -and $id -gt 4; $i++) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); if (-not $p) { break }; '{0} {1} {2}' -f $p.ProcessId, $p.ParentProcessId, $p.Name; $id = $p.ParentProcessId }`,
    ],
    { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
  );
  return parseWindowsChain(r.stdout ?? "");
}

/**
 * A process lookup for one walk up the tree: the first question fetches the process and its
 * ancestors together, so the walk costs one PowerShell start, not one per step.
 */
export function windowsChainRunner(timeoutMs: number = WINDOWS_QUERY_MS): PsRun {
  const known = new Map<number, { ppid: number; name: string }>();
  return (pid) => {
    if (!known.has(pid)) for (const [k, v] of queryWindowsChain(pid, timeoutMs)) known.set(k, v);
    return known.get(pid);
  };
}

/** One lookup, for a single process (is it still the same program?). */
export const psWindows: PsRun = (pid) => windowsChainRunner()(pid);

export function agentProcess(
  start: number = process.ppid,
  platform: NodeJS.Platform = process.platform,
  run: PsRun = platform === "win32" ? windowsChainRunner() : ps,
): AgentProcess | undefined {
  let pid = start;
  for (let i = 0; i < 4 && pid > 1; i++) {
    const p = run(pid);
    if (!p) return undefined;
    if (!SHELLS.has(p.name)) return { pid, name: p.name };
    pid = p.ppid;
  }
  return undefined;
}

/** Whether `p` still runs: the PID is alive and, where `ps` can say, still the same program. */
export function stillRunning(
  p: AgentProcess,
  alive: (pid: number) => boolean = isProcessAlive,
  run: PsRun = process.platform === "win32" ? psWindows : ps,
): boolean {
  if (!alive(p.pid)) return false;
  const now = run(p.pid);
  return now === undefined || now.name === p.name;
}
