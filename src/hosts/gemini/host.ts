import { spawn } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { classifyGeminiError, durationMs, GEMINI_LIMIT } from "../../core/limits/agents.js";
import { recogniseForHost } from "../../core/limits/recognise.js";
import { nextMidnight } from "../../core/time.js";
import {
  type ClosedDeps,
  type ClosedHost,
  ensureProgram,
  FIRE_ENV,
  onLimit,
  onPrompt,
  onSessionEnd,
  onSessionStart,
} from "../closed.js";
import { codexProgram as nodeAware } from "../codex/cli.js";
import { readTail } from "../codex/rollout.js";
import type { HookContext, HookHandler } from "../hook.js";
import { resumeDeadline, type SendResult } from "../host.js";
import { type SessionLimit, type SessionRecord, safeSessionId } from "../sessions.js";

/**
 * Google's Gemini CLI in a terminal (plan §9.5; Gemini CLI v0.62.0 sources, research note §B):
 *
 *   - A linked Gemini CLI extension with hooks: SessionStart / SessionEnd (open or closed),
 *     BeforeAgent (the person sent a prompt), AfterAgent (a turn ended; it carries no error, so the
 *     hook reads the newest `{type: "error"}` record at the end of the session file).
 *   - The reset time comes from the error text ("reset after 1h2m3s", "Resets in …", an ISO time);
 *     Gemini CLI never stores a structured one. Otherwise the person picks a time.
 *   - Fire: `gemini --resume <uuid> -p "<message>" --approval-mode default -o json` in the
 *     session's folder, only when it's closed (Gemini has no session lock). `--approval-mode
 *     default` never widens the person's mode; `--skip-trust` is never passed.
 *   - Gemini's hook env has GEMINI_SESSION_ID (and CLAUDE_PROJECT_DIR "for compatibility", which is
 *     why the guard doesn't look at that).
 */

export const GEMINI_ID = "gemini-cli";

/**
 * The text of the session file's newest message when that message is an error (a later turn means
 * the person carried on). Bookkeeping records Gemini appends after it (`$set`, `$rewindTo`,
 * `$patch`, `info`, `warning`; research DG-S2) are passed over.
 */
export function lastErrorText(transcript: string): string | undefined {
  let tail: string;
  try {
    tail = readTail(transcript, 16 * 1024);
  } catch {
    return undefined;
  }
  for (const line of tail.trim().split("\n").reverse()) {
    let r: { type?: string; content?: unknown };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "user" || r.type === "gemini") return undefined;
    if (r.type !== "error") continue;
    const c = r.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c))
      return c
        .map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? "")))
        .join("");
    if (c && typeof c === "object") return (c as { text?: string }).text;
    return undefined;
  }
  return undefined;
}

/**
 * The session's own id, from the session file's first line (`{sessionId, projectHash, …}`). The
 * hook's `session_id` changes when the person switches to a fallback model (research DG-E8), but
 * the file and the id `gemini --resume` takes stay the same.
 */
export function transcriptSessionId(transcript: unknown): string | undefined {
  if (typeof transcript !== "string") return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(transcript, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
    const id = (JSON.parse(first) as { sessionId?: unknown }).sessionId;
    return safeSessionId(id) ? id : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** API-key sign-in with no reset in the error: Gemini API daily quotas reset at midnight Pacific. */
export function withApiKeyReset(
  limit: Omit<SessionLimit, "seenAt">,
  apiKey: boolean,
  now: number,
): Omit<SessionLimit, "seenAt"> {
  if (!apiKey || limit.billing || limit.resetsAt !== undefined) return limit;
  return { ...limit, resetsAt: nextMidnight("America/Los_Angeles", now) };
}

export function resumeGemini(
  r: SessionRecord,
  text: string,
  env: NodeJS.ProcessEnv,
  node: string = process.execPath,
): Promise<SendResult> {
  if (!r.program)
    return Promise.resolve({ ok: false, reason: "unsupported", detail: "no Gemini CLI found" });
  const program = nodeAware(r.program, node);
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(
      program.command,
      [
        ...program.args,
        "--resume",
        r.sessionId,
        "-p",
        text,
        "--approval-mode",
        "default",
        "-o",
        "json",
      ],
      { cwd: r.cwd || undefined, env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 1 << 20) out += d.toString("utf8");
    });
    const timedOut = resumeDeadline(child);
    child.on("error", () => resolve({ ok: false, reason: "failed", detail: "spawn" }));
    child.on("exit", (code) => {
      if (timedOut()) return resolve({ ok: false, reason: "failed", detail: "timeout" });
      if (code === 41) return resolve({ ok: false, reason: "failed", detail: "signed-out" });
      if (GEMINI_LIMIT.test(out)) {
        const resetsAt = classifyGeminiError(out, Date.now())?.resetsAt;
        return resolve({ ok: false, reason: "limited", ...(resetsAt && { resetsAt }) });
      }
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, reason: "failed", detail: `exit ${code ?? "signal"}` });
    });
  });
}

export const geminiHost: ClosedHost = {
  id: GEMINI_ID,
  name: "Gemini CLI",
  resume: (r, text, env) => resumeGemini(r, text, env),
};

const isGeminiTranscript = (p: unknown) =>
  typeof p === "string" && /[\\/]\.gemini[\\/]tmp[\\/]/.test(p);

export interface GeminiHookDeps {
  closed: (ctx: HookContext) => ClosedDeps;
  program: (env: NodeJS.ProcessEnv) => string | undefined;
  /** Whether Gemini CLI signs in with an API key (install.ts reads its settings). */
  apiKey?: (env: NodeJS.ProcessEnv) => boolean;
}

/** The session's id: the session file's own, else the hook's (before the file exists). */
function sessionOf(input: Record<string, unknown>): string | undefined {
  const fromFile = transcriptSessionId(input.transcript_path);
  if (fromFile) return fromFile;
  return safeSessionId(input.session_id) ? input.session_id : undefined;
}

export function geminiHooks(deps: GeminiHookDeps): HookHandler {
  return {
    isMine: (input, env) =>
      !env.GROK_HOOK_EVENT &&
      safeSessionId(input.session_id) &&
      (typeof env.GEMINI_SESSION_ID === "string" || isGeminiTranscript(input.transcript_path)),
    sessionId: (input) => sessionOf(input),
    async handle(ctx) {
      const id = sessionOf(ctx.input);
      if (!id) return undefined;
      const cwd = typeof ctx.input.cwd === "string" ? ctx.input.cwd : (ctx.env.GEMINI_CWD ?? "");
      const d = deps.closed(ctx);
      // Rewake's own resume runs aren't the person's: no program lookup for them.
      if (!ctx.env[FIRE_ENV]) ensureProgram(geminiHost, id, cwd, d, () => deps.program(ctx.env));
      switch (ctx.event) {
        case "SessionStart":
          onSessionStart(geminiHost, id, cwd, d, deps.program(ctx.env));
          break;
        case "BeforeAgent":
          onPrompt(geminiHost, id, cwd, d);
          break;
        case "AfterAgent": {
          if (ctx.input.stop_hook_active) break;
          const t = ctx.input.transcript_path;
          const text = typeof t === "string" ? lastErrorText(t) : undefined;
          const limit = text
            ? recogniseForHost({ agent: "gemini", source: "session-file", text }, ctx.now)
            : undefined;
          if (limit)
            onLimit(
              geminiHost,
              id,
              cwd,
              withApiKeyReset(limit, deps.apiKey?.(ctx.env) === true, ctx.now),
              d,
            );
          break;
        }
        case "SessionEnd":
          onSessionEnd(geminiHost, id, cwd, d);
          break;
      }
      return undefined;
    },
  };
}

// Moved to the core (plan §3.4); kept here for existing imports.
export { classifyGeminiError, durationMs };
