import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ANTIGRAVITY_QUOTA, classifyAntigravityStop } from "../../core/limits/agents.js";
import { recogniseForHost } from "../../core/limits/recognise.js";
import type { LimitSignal } from "../../core/limits/types.js";
import { formatAt } from "../../core/time.js";
import { ensurePrivateDir } from "../../util/paths.js";
import {
  type ClosedDeps,
  type ClosedHost,
  onLimit,
  onPrompt,
  onSessionEnd,
  onSessionStart,
} from "../closed.js";
import { codexProgram as nodeAware } from "../codex/cli.js";
import type { HookContext, HookHandler } from "../hook.js";
import { resumeDeadline, type SendResult } from "../host.js";
import { type SessionRecord, safeSessionId } from "../sessions.js";

/**
 * Google's Antigravity CLI (`agy`) (plan §9.5; Antigravity docs `hooks`, `plugins`, `cli`, read
 * 2026-10-06; no Antigravity program was run). Antigravity has no wait-for-the-reset feature.
 *
 *   - One global plugin folder, `~/.gemini/config/plugins/agent-rewake/`, with a Stop hook. Its
 *     input: `conversationId`, `workspacePaths[]`, `transcriptPath`, `terminationReason`,
 *     `error?`. A quota stop ("Individual quota reached … Resets in 16h39m20s") records the limit;
 *     the conversation counts as left (there are no session start or end hooks). A later turn
 *     that ends normally means the person carried on.
 *   - Only the CLI surface is continued: the transcript path says which (`antigravity-cli`,
 *     `antigravity` for 2.0, `antigravity-ide`, `antigravity-acp` for Zed, which Rewake's Zed
 *     add-on owns).
 *   - Fire: `agy --conversation <id> -p "<message>" --output-format json` in the workspace, with
 *     the updater off. While an `agy` runs in that workspace (or where the system won't say),
 *     only a notification: Antigravity has no session lock. The message is still an argument
 *     (so readable from `ps`): no `agy` has ever been run to check for a stdin or prompt-file
 *     route. See resumeAgy.
 */

export const ANTIGRAVITY_ID = "antigravity";

export function geminiHome(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return env.GEMINI_HOME || join(home, ".gemini");
}

/** Which Antigravity surface wrote a transcript, from its folder. */
export function surfaceOf(transcriptPath: string, env: NodeJS.ProcessEnv, home?: string): string {
  const g = geminiHome(env, home);
  for (const s of ["antigravity-cli", "antigravity-ide", "antigravity-acp", "antigravity"])
    if (transcriptPath.startsWith(join(g, s) + sep)) return s;
  return "unknown";
}

/** A running Antigravity CLI and the folder it runs in, when the system says. */
export interface AgyProcess {
  pid: number;
  cwd?: string;
}

/** `agy` as a program, or as a Node script (`node …/agy …`): its command line, from `ps`. */
const AGY = /(^|[\\/\s])agy(\.exe)?(\s|$)/i;
/** Remote Control's background service isn't a conversation (research X12). */
const NOT_A_CONVERSATION = /\bagy(\.exe)?\s+remote-control\b/i;

export type Run = (command: string, args: string[]) => string;

const run: Run = (command, args) =>
  spawnSync(command, args, { encoding: "utf8", timeout: 5000, windowsHide: true }).stdout ?? "";

/** The Antigravity CLI processes running now, with their folders where the system tells them. */
export function agyProcesses(
  platform: NodeJS.Platform = process.platform,
  exec: Run = run,
): AgyProcess[] {
  if (platform === "win32") {
    // tasklist gives no folder: every agy.exe counts as open anywhere.
    return exec("tasklist", ["/FI", "IMAGENAME eq agy.exe", "/NH", "/FO", "CSV"])
      .split("\n")
      .map((l) => /^"agy\.exe","(\d+)"/i.exec(l.trim())?.[1])
      .filter((p): p is string => p !== undefined)
      .map((p) => ({ pid: Number(p) }));
  }
  const out: AgyProcess[] = [];
  for (const line of exec("ps", ["-A", "-o", "pid=,args="]).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m?.[2] || !AGY.test(m[2]) || NOT_A_CONVERSATION.test(m[2])) continue;
    const pid = Number(m[1]);
    const cwd =
      platform === "linux"
        ? exec("readlink", [`/proc/${pid}/cwd`]).trim()
        : /^n(.+)$/m.exec(exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]))?.[1];
    out.push({ pid, ...(cwd && { cwd }) });
  }
  return out;
}

/**
 * Whether a conversation in `folder` may be open in the Antigravity CLI (no second writer):
 * an `agy` runs there, or runs somewhere the system won't say. An `agy` in another project, or
 * Remote Control's service, doesn't hold a resume back. Antigravity has no session lock.
 */
export function agyOpenIn(folder: string, procs: AgyProcess[] = agyProcesses()): boolean {
  const want = resolve(folder);
  return procs.some((p) => p.cwd === undefined || !folder || resolve(p.cwd) === want);
}

export function resumeAgy(
  r: SessionRecord,
  text: string,
  env: NodeJS.ProcessEnv,
): Promise<SendResult> {
  if (!r.program)
    return Promise.resolve({
      ok: false,
      reason: "unsupported",
      detail: "no Antigravity CLI found",
    });
  const program = nodeAware(r.program, process.execPath);
  // KNOWN GAP: the message is still an argument here, so another process on this machine can read
  // it from `ps`. Every other host now avoids that (stdin for Copilot CLI and Gemini CLI, a 0600
  // file for Grok Build). The Antigravity CLI (`agy`) is the one Rewake has never run: there is no
  // pinned version, no contract test and no help output to read, and its documented flags give
  // neither a prompt on stdin nor a prompt-file flag. Rewake will not guess a flag that may not
  // exist. Fix this the moment `agy` can be run and its `--help` read (plan §9.5, experiments
  // AG-E1..AG-E7); until then the Antigravity preview leaks the scheduled message locally.
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(
      program.command,
      [...program.args, "--conversation", r.sessionId, "-p", text, "--output-format", "json"],
      {
        cwd: r.cwd || undefined,
        env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 1 << 20) out += d.toString("utf8");
    });
    const timedOut = resumeDeadline(child);
    child.on("error", () => resolve({ ok: false, reason: "failed", detail: "spawn" }));
    child.on("exit", () => {
      if (timedOut()) return resolve({ ok: false, reason: "failed", detail: "timeout" });
      // Judged by the response, not the exit status: Antigravity has reported a resumed
      // conversation's old quota error after a successful turn, and exited 0 on a new one.
      let json: { response?: unknown; error?: unknown } | undefined;
      try {
        json = JSON.parse(out);
      } catch {
        json = undefined;
      }
      const response = typeof json?.response === "string" ? json.response : "";
      const error = response || String(json?.error ?? out);
      if (ANTIGRAVITY_QUOTA.test(error)) {
        const stop = { terminationReason: "error", error };
        const resetsAt = classifyAntigravityStop(stop, Date.now())?.resetsAt;
        return resolve({ ok: false, reason: "limited", ...(resetsAt && { resetsAt }) });
      }
      if (response.trim()) return resolve({ ok: true });
      resolve({ ok: false, reason: "failed", detail: "no response" });
    });
  });
}

/** What Rewake says at a limit in the Antigravity app or IDE, which it can't continue. */
export function appNotice(surface: string, resetsAt: number | undefined, now: number): string {
  const where = surface === "antigravity-ide" ? "the Antigravity IDE" : "the Antigravity app";
  const when = resetsAt ? ` It resets ${formatAt(resetsAt, now)}.` : "";
  return `Antigravity hit its usage limit in ${where}.${when} Rewake can't continue conversations there, so continue yours after the reset.`;
}

/** One notice per conversation and reset: a person retrying in the app isn't told again. */
function firstNotice(stateDir: string, id: string, resetsAt: number | undefined): boolean {
  const dir = ensurePrivateDir(join(stateDir, "hosts", ANTIGRAVITY_ID, "notified"));
  const file = join(dir, `${id}.json`);
  const key = String(resetsAt ?? "unknown");
  try {
    if (readFileSync(file, "utf8") === key) return false;
  } catch {
    // Not told yet.
  }
  writeFileSync(file, key, { mode: 0o600 });
  return true;
}

/** The Stop hook's input as a limit signal (`terminationReason` is the code). */
function stopSignal(input: Record<string, unknown>): LimitSignal {
  return {
    agent: "antigravity",
    source: "hook",
    ...(typeof input.terminationReason === "string" && { code: input.terminationReason }),
    ...(typeof input.error === "string" && { text: input.error }),
  };
}

export function antigravityHost(
  isOpen: (r: SessionRecord) => boolean = (r) => agyOpenIn(r.cwd),
): ClosedHost {
  return {
    id: ANTIGRAVITY_ID,
    name: "Antigravity CLI",
    reopen: "open the conversation in Antigravity CLI",
    resume: (r, text, env) => resumeAgy(r, text, env),
    isOpen: (r) => isOpen(r),
  };
}

export interface AntigravityHookDeps {
  closed: (ctx: HookContext) => ClosedDeps;
  program: (env: NodeJS.ProcessEnv) => string | undefined;
}

export function antigravityHooks(deps: AntigravityHookDeps): HookHandler {
  const host = antigravityHost();
  return {
    isMine: (input, env) =>
      !env.GROK_HOOK_EVENT &&
      safeSessionId(input.conversationId) &&
      typeof input.transcriptPath === "string",
    sessionId: (input) => (safeSessionId(input.conversationId) ? input.conversationId : undefined),
    async handle(ctx) {
      if (ctx.event !== "Stop") return undefined;
      // The Stop output needs a decision; anything but "continue" lets the turn stop as it would.
      const allow = JSON.stringify({ decision: "allow" });
      const id = ctx.input.conversationId as string;
      // Only the CLI's conversations are continued; Zed's are its add-on's. The app's and the
      // IDE's can't be sent to, so at a limit there Rewake only says when it resets (R2, R4).
      const surface = surfaceOf(ctx.input.transcriptPath as string, ctx.env);
      if (surface === "antigravity-acp") return allow;
      if (surface !== "antigravity-cli") {
        const limit = recogniseForHost(stopSignal(ctx.input), ctx.now);
        if (limit && !limit.billing && firstNotice(ctx.stateDir, id, limit.resetsAt))
          deps.closed(ctx).notify("Agent Rewake", appNotice(surface, limit.resetsAt, ctx.now));
        return allow;
      }
      const paths = ctx.input.workspacePaths;
      const cwd = Array.isArray(paths) && typeof paths[0] === "string" ? paths[0] : "";
      const d = deps.closed(ctx);
      const limit = recogniseForHost(stopSignal(ctx.input), ctx.now);
      if (limit) {
        onSessionStart(host, id, cwd, d, deps.program(ctx.env));
        onLimit(host, id, cwd, limit, d);
        onSessionEnd(host, id, cwd, d);
      } else onPrompt(host, id, cwd, d);
      return allow;
    },
  };
}

// Moved to the core (plan §3.4); kept here for existing imports.
export { classifyAntigravityStop };
