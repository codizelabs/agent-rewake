import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { npmShimTarget } from "../../util/spawn.js";
import { VERSION } from "../../version.js";

/**
 * Talking to Codex through its own commands (observed on 0.160.1, research note §3.1.3–3.1.5):
 *
 *   - `codex app-server --listen stdio://` + `account/rateLimits/read`: whether ordinary usage is
 *     allowed again. A short-lived server that loads no thread. Signed out it answers -32600.
 *   - `codex queue --thread <uuid> --message <text>`: a durable per-thread queue; whichever Codex
 *     has the thread loaded starts it as a normal turn (it polls every 10 s), or Codex does when
 *     the thread is next opened. Running it twice queues twice, so Rewake's lock and record guard it.
 *   - `codex plugin marketplace add|remove`, `codex plugin add|remove`: Codex writes its own
 *     config.toml entries. Rewake never edits config.toml and never writes hook trust.
 *
 * Never passed: --dangerously-bypass-approvals-and-sandbox, --dangerously-bypass-hook-trust,
 * -s, -a. A queued turn that needs approval waits for the person.
 */

export interface Program {
  command: string;
  args: string[];
}

/**
 * How to run a Codex program found on disk. An npm install's `codex` is a Node script run through
 * `#!/usr/bin/env node`, which fails under a timer's minimal PATH, so it runs with this Node.
 */
export function codexProgram(path: string, node: string = process.execPath): Program {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Used as given.
  }
  if (/\.(cmd|bat)$/i.test(real)) {
    const js = npmShimTarget(real);
    if (js) return { command: node, args: [js] };
  }
  if (/\.(c|m)?js$/.test(real)) return { command: node, args: [real] };
  return { command: path, args: [] };
}

export type Usage =
  | { ok: true; allowed?: boolean; resetsAt?: number }
  | { ok: false; reason: "signed-out" | "timeout" | "spawn" | "error" };

/** A window in `account/rateLimits/read` (app-server v2, camelCase). */
interface UsageWindow {
  usedPercent?: number;
  resetsAt?: number | null;
}

/**
 * When the limit that's blocking ends (ms): the latest of the full windows, which all have to
 * clear; with none full, the window closest to full, not the weekly one that resets last.
 */
export function blockingReset(windows: (UsageWindow | null | undefined)[]): number | undefined {
  const known = windows.filter(
    (w): w is UsageWindow & { resetsAt: number } =>
      !!w && typeof w.resetsAt === "number" && w.resetsAt > 0,
  );
  if (known.length === 0) return undefined;
  const full = known.filter((w) => (w.usedPercent ?? 0) >= 100);
  const w =
    full.length > 0
      ? full.reduce((a, b) => (b.resetsAt > a.resetsAt ? b : a))
      : known.reduce((a, b) => {
          const d = (b.usedPercent ?? 0) - (a.usedPercent ?? 0);
          return d > 0 || (d === 0 && b.resetsAt < a.resetsAt) ? b : a;
        });
  return w.resetsAt * 1000;
}

/** Ask Codex whether ordinary usage is allowed again. Never throws. */
export function readUsage(
  codex: Program,
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): Promise<Usage> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(codex.command, [...codex.args, "app-server", "--listen", "stdio://"], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const done = (u: Usage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(u);
    };
    const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), timeoutMs);
    child.on("error", () => done({ ok: false, reason: "spawn" }));
    child.on("exit", () => done({ ok: false, reason: "error" }));
    const send = (m: unknown) => {
      try {
        child.stdin.write(`${JSON.stringify(m)}\n`);
      } catch {
        done({ ok: false, reason: "error" });
      }
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      let m: { id?: number; error?: { message?: string }; result?: Record<string, unknown> };
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id === 1) {
        if (m.error) return done({ ok: false, reason: "error" });
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read" });
      } else if (m.id === 2) {
        if (m.error)
          return done({
            ok: false,
            reason: /authentication required/i.test(m.error.message ?? "") ? "signed-out" : "error",
          });
        const r = (m.result ?? {}) as {
          ordinaryUsageAllowed?: boolean | null;
          rateLimits?: { primary?: UsageWindow | null; secondary?: UsageWindow | null };
        };
        const resetsAt = blockingReset([r.rateLimits?.primary, r.rateLimits?.secondary]);
        done({
          ok: true,
          ...(typeof r.ordinaryUsageAllowed === "boolean" && { allowed: r.ordinaryUsageAllowed }),
          ...(resetsAt !== undefined && { resetsAt }),
        });
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "agent_rewake", title: "Agent Rewake", version: VERSION } },
    });
  });
}

export type QueueResult =
  | { ok: true; queuedId: string }
  | { ok: false; reason: "archived" | "deleted" | "daemon" | "failed"; detail: string };

/** Queue one message into an existing thread, by its UUID (never by name). */
export function queueMessage(
  codex: Program,
  threadId: string,
  text: string,
  env: NodeJS.ProcessEnv,
  remote?: string,
  timeoutMs = 60_000,
): Promise<QueueResult> {
  return new Promise((resolve) => {
    execFile(
      codex.command,
      [
        ...codex.args,
        "queue",
        ...(remote ? ["--remote", remote] : []),
        "--thread",
        threadId,
        "--message",
        text,
      ],
      { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const m = /Queued message (\S+) for thread (\S+)\./.exec(String(stdout));
        if (!err && m?.[1]) return resolve({ ok: true, queuedId: m[1] });
        const detail = String(stderr).trim().slice(0, 300);
        const reason = /is archived/i.test(detail)
          ? "archived"
          : /no rollout found|thread not found/i.test(detail)
            ? "deleted"
            : /embedded app server while .*daemon is running/i.test(detail)
              ? "daemon"
              : "failed";
        resolve({ ok: false, reason, detail });
      },
    );
  });
}

/** Run a `codex plugin …` command; resolves with its exit status and output. */
export function codexCommand(
  codex: Program,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      codex.command,
      [...codex.args, ...args],
      { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        resolve({
          status: err ? (typeof code === "number" ? code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}
