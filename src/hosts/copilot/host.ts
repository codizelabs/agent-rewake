import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
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
import { SESSION_GONE, type SessionRecord, safeSessionId } from "../sessions.js";
import { classifyCopilotError } from "./recognise.js";

/**
 * GitHub Copilot CLI in a terminal (plan §9.3): hooks record the session and its limit; when the
 * person agrees, `fire` continues the closed session headless:
 *
 *   copilot --resume=<sessionId> -p "<message>" --no-ask-user --output-format json --no-auto-update
 *
 * in the session's folder. No --allow-* or --yolo: a turn that needs approval stops there
 * (product rule 5; what it does exactly is experiment E-C3). The JSONL output says whether the run
 * hit the limit again (`session.error` with `errorType: "rate_limit"`).
 */

export const COPILOT_ID = "copilot-cli";

/** Copilot's hook input: camelCase `sessionId` and a numeric `timestamp` (1.0.92 docs). */
function isCopilot(input: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean {
  return (
    !env.GROK_HOOK_EVENT &&
    !("hookEventName" in input) &&
    safeSessionId(input.sessionId) &&
    typeof input.timestamp === "number"
  );
}

/** Run `copilot --resume … -p …` and read its JSONL output for a usage limit. */
export function resumeCopilot(
  r: SessionRecord,
  text: string,
  env: NodeJS.ProcessEnv,
  node: string = process.execPath,
): Promise<SendResult> {
  if (!r.program)
    return Promise.resolve({ ok: false, reason: "unsupported", detail: "no Copilot found" });
  const program = nodeAware(r.program, node);
  return new Promise((resolve) => {
    let limited = false;
    const child = spawn(
      program.command,
      [
        ...program.args,
        `--resume=${r.sessionId}`,
        "-p",
        text,
        "--no-ask-user",
        "--output-format",
        "json",
        "--no-auto-update",
      ],
      {
        cwd: r.cwd || undefined,
        env: { ...env, COPILOT_AUTO_UPDATE: "false" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 1 << 16) err += d.toString("utf8");
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const e = JSON.parse(line) as { type?: string; data?: { errorType?: string } };
        if (e.type === "session.error" && e.data?.errorType === "rate_limit") limited = true;
      } catch {
        // Not JSON: progress text.
      }
    });
    const timedOut = resumeDeadline(child);
    child.on("error", () => resolve({ ok: false, reason: "failed", detail: "spawn" }));
    child.on("exit", (code) => {
      if (timedOut()) return resolve({ ok: false, reason: "failed", detail: "timeout" });
      if (limited) resolve({ ok: false, reason: "limited" });
      else if (code === 0) resolve({ ok: true });
      else if (SESSION_GONE.test(err)) resolve({ ok: false, reason: "closed", detail: "deleted" });
      else resolve({ ok: false, reason: "failed", detail: `exit ${code ?? "signal"}` });
    });
  });
}

export const copilotHost: ClosedHost = {
  id: COPILOT_ID,
  name: "GitHub Copilot CLI",
  reopen: 'resume the session with "copilot --resume"',
  resume: (r, text, env) => resumeCopilot(r, text, env),
};

export interface CopilotHookDeps {
  closed: (ctx: HookContext) => ClosedDeps;
  /** The copilot program on this session's PATH. */
  program: (env: NodeJS.ProcessEnv) => string | undefined;
}

export function copilotHooks(deps: CopilotHookDeps): HookHandler {
  return {
    isMine: isCopilot,
    sessionId: (input) => (safeSessionId(input.sessionId) ? input.sessionId : undefined),
    async handle(ctx) {
      const id = ctx.input.sessionId as string;
      const cwd = typeof ctx.input.cwd === "string" ? ctx.input.cwd : "";
      const d = deps.closed(ctx);
      switch (ctx.event) {
        case "sessionStart":
          onSessionStart(copilotHost, id, cwd, d, deps.program(ctx.env));
          break;
        case "userPromptSubmitted":
          onPrompt(copilotHost, id, cwd, d);
          break;
        case "errorOccurred": {
          const e = ctx.input.error;
          const text =
            typeof e === "string" ? e : (e as { message?: unknown } | undefined)?.message;
          // Copilot retries some errors itself; one it recovered from isn't a stop.
          const recoverable =
            ctx.input.recoverable === true ||
            (typeof e === "object" && (e as { recoverable?: unknown })?.recoverable === true);
          const limit = classifyCopilotError(text, ctx.now, recoverable);
          if (limit) onLimit(copilotHost, id, cwd, limit, d);
          break;
        }
        case "sessionEnd":
          onSessionEnd(copilotHost, id, cwd, d);
          break;
      }
      return undefined;
    },
  };
}
