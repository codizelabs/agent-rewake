import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { classifyText } from "../../adapters/profiles.js";
import {
  type ClosedDeps,
  type ClosedHost,
  onLimit,
  onPrompt,
  onSessionEnd,
  onSessionStart,
} from "../closed.js";
import { codexProgram as nodeAware } from "../codex/cli.js";
import { durationMs } from "../gemini/host.js";
import type { HookContext, HookHandler } from "../hook.js";
import { resumeDeadline, type SendResult } from "../host.js";
import { type SessionLimit, type SessionRecord, safeSessionId } from "../sessions.js";

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
 *     the updater off. While an `agy` runs in that workspace (or where the system won't say), only
 *     a notification: Antigravity has no session lock.
 */

export const ANTIGRAVITY_ID = "antigravity";

const QUOTA = /Individual quota reached|RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/;

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

export function classifyAntigravityStop(
  input: Record<string, unknown>,
  now: number,
): Omit<SessionLimit, "seenAt"> | undefined {
  const error = typeof input.error === "string" ? input.error : "";
  if (input.terminationReason !== "error" || !QUOTA.test(error)) return undefined;
  // Shared rules: a reset time wins over money words ("… enable overages. Resets in 16h39m20s"),
  // a reset only seconds away is a wait Antigravity rides out itself.
  const c = classifyText(error, now);
  if (c.kind === "transient") return undefined;
  if (c.kind === "not_recoverable" && c.reason === "billing")
    return { kind: "billing", billing: true };
  const d = /Resets in ((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/.exec(error)?.[1];
  const ms = d ? durationMs(d) : undefined;
  const resetsAt =
    c.kind === "usage_limit" && c.resetAt !== undefined
      ? c.resetAt
      : ms !== undefined
        ? now + ms
        : undefined;
  return { kind: "other", billing: false, ...(resetsAt !== undefined && { resetsAt }) };
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
      if (QUOTA.test(response) || (!response && QUOTA.test(String(json?.error ?? out))))
        return resolve({ ok: false, reason: "limited" });
      if (response.trim()) return resolve({ ok: true });
      resolve({ ok: false, reason: "failed", detail: "no response" });
    });
  });
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
      // Only the CLI's conversations; Zed's are its add-on's, the app's and IDE's can't be sent to.
      if (surfaceOf(ctx.input.transcriptPath as string, ctx.env) !== "antigravity-cli")
        return allow;
      const paths = ctx.input.workspacePaths;
      const cwd = Array.isArray(paths) && typeof paths[0] === "string" ? paths[0] : "";
      const d = deps.closed(ctx);
      const limit = classifyAntigravityStop(ctx.input, ctx.now);
      if (limit) {
        onSessionStart(host, id, cwd, d, deps.program(ctx.env));
        onLimit(host, id, cwd, limit, d);
        onSessionEnd(host, id, cwd, d);
      } else onPrompt(host, id, cwd, d);
      return allow;
    },
  };
}
