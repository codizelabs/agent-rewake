import { spawn } from "node:child_process";
import { continueOnly, type RewakePlace } from "../../core/command.js";
import { classifyQwenFailure } from "../../core/limits/agents.js";
import { recogniseForHost } from "../../core/limits/recognise.js";
import { RESET_MARGIN_MS } from "../../core/resume.js";
import { ScheduleStore } from "../../core/store.js";
import { formatAt } from "../../core/time.js";
import {
  armClosed,
  type ClosedDeps,
  type ClosedHost,
  ensureProgram,
  FIRE_ENV,
  onLimit,
  onPrompt,
  onSessionEnd,
  onSessionStart,
  pendingFor,
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
import { type SessionRecord, SessionRecords, safeSessionId } from "../sessions.js";

/**
 * Alibaba's Qwen Code in a terminal (a preview, never tried against a real Qwen Code limit; hooks.md,
 * headless.md and settings.md of QwenLM/qwen-code at 6788c03, v0.25.0, read 2026-10-10):
 *
 *   - Claude-style hooks in the person's user `settings.json` (src/hosts/qwen/install.ts):
 *     SessionStart / SessionEnd, `Stop` (a turn ended well: the person carried on) and
 *     `StopFailure`, whose `error` is `rate_limit` for a 429 and `billing_error` for money. Qwen
 *     doesn't fire `StopFailure` for an API error in a headless (`-p`) run.
 *   - The reset time is in the error text ("The quota will reset at 07-27 09:25:00 UTC."), without
 *     a year: classifyQwenFailure reads it as the next such time.
 *   - Fire: `qwen --resume <uuid> --approval-mode default` in the session's folder (sessions are
 *     kept per project folder). Never `--yolo` or any other way past a question. What a headless
 *     run does with a tool that needs approval is not documented; it is not tried, and Rewake
 *     can't tell (the run may skip such a tool and still exit 0).
 *   - Qwen sets QWEN_PROJECT_DIR in a command hook's environment (hooks.md), which is how a hook
 *     knows the run is Qwen's (Qwen also sets CLAUDE_PROJECT_DIR and GEMINI_PROJECT_DIR).
 *   - Windows: unknown. Nothing here was run on it.
 */

export const QWEN_ID = "qwen-code";

/** What a headless `qwen --resume` says when the session isn't there (config.ts at 6788c03). */
const NO_SESSION = /No saved session found with ID/i;

export function resumeQwen(
  r: SessionRecord,
  text: string,
  env: NodeJS.ProcessEnv,
  node: string = process.execPath,
): Promise<SendResult> {
  if (!r.program)
    return Promise.resolve({ ok: false, reason: "unsupported", detail: "no Qwen Code found" });
  if (folderGone(r.cwd)) return Promise.resolve(FOLDER_GONE);
  const program = nodeAware(r.program, node);
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    // The message goes in on stdin, never as `-p <text>`: an argument is readable from `ps` by
    // anything else on the machine. With no `-p`, no query and a stdin that isn't a terminal, Qwen
    // Code runs headless and takes what it reads there as the prompt (packages/cli/src/config/
    // config.ts "No query or prompt means interactive only if TTY" and packages/cli/src/llm.tsx, which reads
    // stdin and uses it as the prompt, at 6788c03; headless.md shows `echo … | qwen`). That is read
    // from the source, not run: no `qwen` was ever run to check it. One case Rewake can't close: if
    // the person turns Qwen's sandbox on (settings, QWEN_SANDBOX), the CLI re-launches itself inside
    // it and passes what it read on stdin to that child as `--prompt <text>`.
    const child = spawn(
      program.command,
      [...program.args, "--resume", r.sessionId, "--approval-mode", "default"],
      { cwd: r.cwd || undefined, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    sendPromptOnStdin(child, text);
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 1 << 20) out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 1 << 16) err += d.toString("utf8");
    });
    const timedOut = resumeDeadline(child);
    child.on("error", () => resolve({ ok: false, reason: "failed", detail: "spawn" }));
    child.on("exit", (code) => {
      if (timedOut()) return resolve({ ok: false, reason: "failed", detail: "timeout" });
      if (code === 0) return resolve({ ok: true });
      // The limit again (INFERENCE: how a headless run words and exits on it is not established):
      // the error text says so, on either stream.
      const said = `${err}\n${out}`;
      const again = classifyQwenFailure({ error: "rate_limit", errorDetails: said }, Date.now());
      if (again)
        return resolve({
          ok: false,
          reason: "limited",
          ...(again.resetsAt !== undefined && { resetsAt: again.resetsAt }),
        });
      if (NO_SESSION.test(said)) return resolve({ ok: false, reason: "closed", detail: "deleted" });
      resolve({
        ok: false,
        reason: "failed",
        detail: `exit ${code ?? "signal"}`,
        ...withMessage(err || out),
      });
    });
  });
}

export const qwenHost: ClosedHost = {
  id: QWEN_ID,
  name: "Qwen Code",
  resume: (r, text, env) => resumeQwen(r, text, env),
  // QWEN_HOME and QWEN_RUNTIME_DIR move Qwen's folders (settings.md); OPENAI_API_KEY is the
  // auth variable its settings page names. Only whether the key was set is recorded.
  settingsVars: ["QWEN_HOME", "QWEN_RUNTIME_DIR"],
  keyVars: ["OPENAI_API_KEY"],
};

export interface QwenHookDeps {
  closed: (ctx: HookContext) => ClosedDeps;
  program: (env: NodeJS.ProcessEnv) => string | undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * `/rewake` typed into a Qwen Code session: continue after a limit, at the reset or a chosen
 * time, list or cancel. Qwen Code's `UserPromptSubmit` hook can block a prompt with
 * `{"decision":"block","reason":…}` (hooks.md of QwenLM/qwen-code at 6788c03, checked 2026-10-10)
 * — the reason is shown to the person and the prompt never reaches the model. Delivery of the
 * actual resume is unchanged: it's armed the same way `agent-rewake continue` already arms one
 * (armClosed, src/hosts/closed.ts), and fires through the normal closed-session path once Qwen
 * Code exits.
 */
const QWEN_PLACE: RewakePlace = { name: "Qwen Code", typed: "/rewake", features: new Set() };
/** The slash is optional, as in Codex's bare `rewake` and Cursor's `/rewake`. */
const REWAKE = /^\s*\/?rewake(?:\s+([\s\S]*?))?\s*$/i;

/** Qwen Code's own hook response: shown to the person instead of sending the text to the model. */
function block(reason: string): string {
  return JSON.stringify({ decision: "block", reason });
}

function handleRewake(id: string, args: string, ctx: HookContext, d: ClosedDeps): string {
  const records = new SessionRecords(ctx.stateDir, QWEN_ID);
  const c = continueOnly(QWEN_PLACE, args, ctx.now);
  if (c.kind === "reply") return block(c.text);
  if (c.kind === "list") {
    const next = pendingFor(ctx.stateDir, QWEN_ID, id).sort((a, b) => a.dueAt - b.dueAt)[0];
    return block(
      next
        ? `Rewake will continue this session ${formatAt(next.dueAt, ctx.now)}, once it's closed. To cancel: /rewake cancel`
        : "Rewake: Nothing is set to continue this session. At a usage limit, close it and type /rewake to continue after the reset.",
    );
  }
  if (c.kind === "cancel") {
    const pending = pendingFor(ctx.stateDir, QWEN_ID, id);
    const store = new ScheduleStore(ctx.stateDir);
    for (const s of pending) if (store.cancel(s.scheduleId, ctx.now)) d.disarm(s.scheduleId);
    return block(
      pending.length > 0
        ? "Rewake: Cancelled. This session won't be continued on its own."
        : "Rewake: Nothing is set to continue this session.",
    );
  }
  const r = records.get(id);
  const limit = r?.limit;
  if (!r || !limit)
    return block("Rewake: this session isn't at a usage limit, so there's nothing to continue.");
  if (limit.billing)
    return block(
      "Rewake can't continue after this limit: this limit is about credits or spending, which waiting doesn't fix.",
    );
  const at = c.at ?? (limit.resetsAt !== undefined ? limit.resetsAt + RESET_MARGIN_MS : undefined);
  if (at === undefined)
    return block("Rewake doesn't know when this resets yet. Try /rewake 3:30pm.");
  armClosed(qwenHost, r, at, d);
  return block(
    `Rewake will continue this session ${formatAt(at, ctx.now)}, once it's closed. Keep this computer on and awake until then. Typing again before then cancels it.`,
  );
}

/** A session file Qwen keeps: `<base>/projects/<folder>/chats/<id>.jsonl`. */
const isQwenTranscript = (p: unknown) =>
  typeof p === "string" && /[\\/]projects[\\/][^\\/]+[\\/]chats[\\/][^\\/]+\.jsonl$/.test(p);

export function qwenHooks(deps: QwenHookDeps): HookHandler {
  return {
    isMine: (input, env) =>
      safeSessionId(input.session_id) &&
      (typeof env.QWEN_PROJECT_DIR === "string" || isQwenTranscript(input.transcript_path)),
    sessionId: (input) => (safeSessionId(input.session_id) ? input.session_id : undefined),
    async handle(ctx) {
      const id = ctx.input.session_id;
      if (!safeSessionId(id)) return undefined;
      // A sub-agent's own events belong to its parent session.
      if (ctx.input.agent_id) return undefined;
      const cwd = str(ctx.input.cwd);
      const d = deps.closed(ctx);
      // Rewake's own resume runs aren't the person's: no program lookup for them.
      if (!ctx.env[FIRE_ENV]) ensureProgram(qwenHost, id, cwd, d, () => deps.program(ctx.env));
      switch (ctx.event) {
        case "SessionStart":
          onSessionStart(qwenHost, id, cwd, d, deps.program(ctx.env));
          break;
        case "UserPromptSubmit": {
          const prompt = str(ctx.input.submitted_prompt) || str(ctx.input.prompt);
          const m = REWAKE.exec(prompt);
          if (m) return handleRewake(id, m[1] ?? "", ctx, d);
          break;
        }
        case "Stop":
          // A turn ended without an error: the person carried on after any limit.
          onPrompt(qwenHost, id, cwd, d);
          break;
        case "StopFailure": {
          const limit = recogniseForHost(
            {
              agent: "qwen",
              source: "hook",
              code: str(ctx.input.error),
              text: str(ctx.input.error_details) || str(ctx.input.last_assistant_message),
            },
            ctx.now,
          );
          if (limit) onLimit(qwenHost, id, cwd, limit, d, ctx.input.transcript_path);
          break;
        }
        case "SessionEnd":
          onSessionEnd(qwenHost, id, cwd, d);
          break;
      }
      return undefined;
    },
  };
}
