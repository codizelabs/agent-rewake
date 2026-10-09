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
 * One process on Windows from the line `<parent id> <name>` that the PowerShell query prints, or
 * undefined for no line (the process isn't there).
 */
export function parseWindowsProcess(stdout: string): { ppid: number; name: string } | undefined {
  const m = /^\s*(\d+)\s+(.+?)\s*$/m.exec(stdout);
  return m ? { ppid: Number(m[1]), name: windowsName(m[2] as string) } : undefined;
}

export const psWindows: PsRun = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { '{0} {1}' -f $p.ParentProcessId, $p.Name }`,
    ],
    { encoding: "utf8", timeout: 8000, windowsHide: true },
  );
  return parseWindowsProcess(r.stdout ?? "");
};

export function agentProcess(
  start: number = process.ppid,
  platform: NodeJS.Platform = process.platform,
  run: PsRun = platform === "win32" ? psWindows : ps,
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
