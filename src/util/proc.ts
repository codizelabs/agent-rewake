import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { isProcessAlive } from "../core/lock.js";

/**
 * The agent process that ran a hook, so Rewake can later tell whether the session is still open
 * when the agent never ran its session-end hook (a crash, a killed terminal). Agents start hooks
 * directly or through a shell; the first ancestor that isn't a shell is the agent. POSIX only (`ps`);
 * elsewhere unknown, and then Rewake relies on the session-end hook alone, as before.
 */

export interface AgentProcess {
  pid: number;
  /** The program's name as `ps` reports it ("node", "copilot"), to tell a reused PID apart. */
  name: string;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "env", "timeout"]);

export type PsRun = (pid: number) => { ppid: number; name: string } | undefined;

const ps: PsRun = (pid) => {
  const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000,
  });
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(r.stdout ?? "");
  return m ? { ppid: Number(m[1]), name: basename(m[2] as string).replace(/^-/, "") } : undefined;
};

export function agentProcess(
  start: number = process.ppid,
  platform: NodeJS.Platform = process.platform,
  run: PsRun = ps,
): AgentProcess | undefined {
  if (platform === "win32") return undefined;
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
  run: PsRun = ps,
): boolean {
  if (!alive(p.pid)) return false;
  const now = run(p.pid);
  return now === undefined || now.name === p.name;
}
