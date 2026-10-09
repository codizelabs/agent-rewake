import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { classifyCopilotError, copilotCode } from "../../core/limits/agents.js";
import { recogniseForHost } from "../../core/limits/recognise.js";
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
import type { HookContext, HookHandler } from "../hook.js";
import {
  FOLDER_GONE,
  folderGone,
  resumeDeadline,
  type SendResult,
  sendPromptOnStdin,
  withMessage,
} from "../host.js";
import { SESSION_GONE, type SessionRecord, safeSessionId } from "../sessions.js";

/**
 * GitHub Copilot CLI in a terminal (plan §9.3): hooks record the session and its limit; when the
 * person agrees, `fire` continues the closed session headless:
 *
 *   copilot --resume=<sessionId> --no-ask-user --output-format json --no-auto-update
 *
 * in the session's folder, with the message on its stdin, never as an argument
 * (sendPromptOnStdin). No --allow-* or --yolo: a turn that needs approval stops there
 * (product rule 5; what it does exactly is experiment E-C3). The JSONL output says whether the run
 * hit the limit again (`session.error` with `errorType: "rate_limit"`), and its message says
 * when the limit resets.
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

/** Run `copilot --resume …` with the message on stdin, and read its JSONL output for a limit. */
export function resumeCopilot(
  r: SessionRecord,
  text: string,
  env: NodeJS.ProcessEnv,
  node: string = process.execPath,
): Promise<SendResult> {
  if (!r.program)
    return Promise.resolve({ ok: false, reason: "unsupported", detail: "no Copilot found" });
  if (folderGone(r.cwd)) return Promise.resolve(FOLDER_GONE);
  const program = nodeAware(r.program, node);
  return new Promise((resolve) => {
    let limited = false;
    let resetsAt: number | undefined;
    /** A quota error that waiting won't lift (money): the run's message, "" when it gave none. */
    let quotaStop: string | undefined;
    // The message goes in on stdin, never as `-p <text>`: an argument is readable from `ps` by
    // anything else on the machine. Copilot CLI runs non-interactively on piped stdin with no
    // prompt argument ("combine with -i, -p, or piped stdin", `copilot --help`, 1.0.92; checked
    // against the pinned CLI with --resume).
    const child = spawn(
      program.command,
      [
        ...program.args,
        `--resume=${r.sessionId}`,
        "--no-ask-user",
        "--output-format",
        "json",
        "--no-auto-update",
      ],
      {
        cwd: r.cwd || undefined,
        env: { ...env, COPILOT_AUTO_UPDATE: "false" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    sendPromptOnStdin(child, text);
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 1 << 16) err += d.toString("utf8");
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const e = JSON.parse(line) as {
          type?: string;
          data?: {
            errorType?: string;
            errorCode?: unknown;
            message?: unknown;
            retryAfterSeconds?: unknown;
          };
        } | null;
        const d = e?.data;
        const now = Date.now();
        // "Seconds until the rate limit resets, when known": the SDK's `auto_mode_switch.requested`
        // event, which follows a rate-limit error (github/copilot-sdk @503bc70,
        // `nodejs/src/generated/session-events.ts:11922`). Whether `-p` prints it is not checked
        // against a real CLI. It beats any date parsed from the message.
        const retry =
          typeof d?.retryAfterSeconds === "number" &&
          Number.isFinite(d.retryAfterSeconds) &&
          d.retryAfterSeconds > 0
            ? now + d.retryAfterSeconds * 1000
            : undefined;
        if (e?.type === "auto_mode_switch.requested" && retry !== undefined) {
          limited = true;
          resetsAt = retry;
        } else if (e?.type === "session.error" && d?.errorType === "rate_limit") {
          limited = true;
          resetsAt = retry ?? resetsAt ?? classifyCopilotError(d.message, now)?.resetsAt;
        } else if (e?.type === "session.error" && d?.errorType === "quota") {
          // The quota codes (`quota_exceeded`, `session_quota_exceeded`, `billing_not_configured`,
          // SDK `session-events.ts:2014`): a limit that resets is waited out; money is not.
          const code = typeof d.errorCode === "string" ? d.errorCode : "";
          const v = copilotCode(JSON.stringify({ code })) ?? classifyCopilotError(d.message, now);
          if (v && !v.billing) {
            limited = true;
            resetsAt = retry ?? v.resetsAt;
          } else {
            quotaStop = typeof d.message === "string" ? d.message : "";
          }
        }
      } catch {
        // Not JSON: progress text.
      }
    });
    const timedOut = resumeDeadline(child);
    child.on("error", () => resolve({ ok: false, reason: "failed", detail: "spawn" }));
    child.on("exit", (code) => {
      if (timedOut()) return resolve({ ok: false, reason: "failed", detail: "timeout" });
      if (limited) resolve({ ok: false, reason: "limited", ...(resetsAt && { resetsAt }) });
      else if (quotaStop !== undefined)
        resolve({ ok: false, reason: "failed", detail: "quota", ...withMessage(quotaStop) });
      else if (code === 0) resolve({ ok: true });
      else if (SESSION_GONE.test(err)) resolve({ ok: false, reason: "closed", detail: "deleted" });
      else
        resolve({
          ok: false,
          reason: "failed",
          detail: `exit ${code ?? "signal"}`,
          ...withMessage(err),
        });
    });
  });
}

export const copilotHost: ClosedHost = {
  id: COPILOT_ID,
  name: "GitHub Copilot CLI",
  reopen: 'resume the session with "copilot --resume"',
  resume: (r, text, env) => resumeCopilot(r, text, env),
  settingsVars: [
    "COPILOT_HOME",
    "COPILOT_CACHE_HOME",
    "COPILOT_OFFLINE",
    "COPILOT_PROVIDER_BASE_URL",
    "COPILOT_PROVIDER_TYPE",
    "COPILOT_PROVIDER_WIRE_API",
    "COPILOT_MODEL",
  ],
  keyVars: ["COPILOT_PROVIDER_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"],
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
      // Rewake's own resume runs aren't the person's: no program lookup for them.
      if (!ctx.env[FIRE_ENV]) ensureProgram(copilotHost, id, cwd, d, () => deps.program(ctx.env));
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
          const limit = recogniseForHost(
            {
              agent: "copilot",
              source: "hook",
              ...(typeof text === "string" && { text }),
              recovered: recoverable,
            },
            ctx.now,
          );
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
