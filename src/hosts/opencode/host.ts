import { spawn } from "node:child_process";
import { recogniseForHost } from "../../core/limits/recognise.js";
import type { LimitSignal } from "../../core/limits/types.js";
import {
  type ClosedDeps,
  type ClosedHost,
  ensureProgram,
  FIRE_ENV,
  onLimit,
  onPrompt,
  onSessionEnd,
  onSessionStart,
  placeOf,
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
 * OpenCode (anomalyco/opencode) in a terminal: a preview, never run against a real OpenCode or a
 * real limit. Read on 2026-10-10 from opencode.ai/docs/{plugins,cli,permissions} and the source at
 * 055d95bb, identical for the files below at the v1.18.35 release (packages/opencode/src/
 * session/{retry,processor,status}.ts, cli/cmd/run.ts, id/id.ts, plugin/index.ts, config/plugin.ts).
 *
 *   - OpenCode has no hook that runs a command. It loads a JavaScript plugin from
 *     `<config>/plugins/` and calls its `event` and `chat.message` functions in its own process
 *     (src/hosts/opencode/install.ts). Rewake's plugin is a few lines: it hands the events below
 *     to `agent-rewake hook opencode <event>` on stdin, so all decisions stay in Rewake.
 *   - A usage limit is a retry first: `session.status` with `status.type` "retry" carries the
 *     message, and OpenCode itself waits and tries again. `session.error` comes only after five
 *     tries, so a limit with a long wait shows up as a retry long before any error. Both are
 *     read (classifyOpenCodeLimit). A session that carried on afterwards ends its turn with an
 *     idle status, which cancels the plan.
 *   - No event says that OpenCode closed. The plugin's `dispose` function (packages/plugin/src/
 *     index.ts, called when the instance shuts down) sends `session.ended` for sessions that met a
 *     limit; whether it runs when a terminal is closed is not known, so a session whose OpenCode
 *     process has gone is also noticed by the next hook or `continue` (reapClosed).
 *   - Sessions are `ses_…`. Fire: `opencode run --session <id> --dir <folder>`, the message on
 *     standard input (run.ts joins what it reads on stdin to the message). Never `--auto`,
 *     `--yolo` or `--dangerously-skip-permissions`; see the permission note on resumeOpenCode.
 *   - Windows: unknown. Nothing here was run on it.
 */

export const OPENCODE_ID = "opencode";

/** What `opencode run --session` says when the session isn't there (run.ts). */
const NO_SESSION = /\bSession not found\b/;

/**
 * Continue the session headless. What a headless run does with a tool that needs approval: run.ts
 * answers every permission request "reject" unless one of its three auto flags is set, and Rewake
 * sets none. But OpenCode's defaults allow most tools without asking (permissions docs: "Most
 * permissions default to allow"; `doom_loop` and `external_directory` ask), so a resumed session
 * can edit files and run commands as it would in a normal session. Only what the person's own
 * permission settings mark "ask" is refused. Rewake can't make that stricter.
 */
export function resumeOpenCode(
  r: SessionRecord,
  text: string,
  env: NodeJS.ProcessEnv,
  node: string = process.execPath,
): Promise<SendResult> {
  if (!r.program)
    return Promise.resolve({ ok: false, reason: "unsupported", detail: "no OpenCode found" });
  if (folderGone(r.cwd)) return Promise.resolve(FOLDER_GONE);
  const program = nodeAware(r.program, node);
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    // The message goes in on stdin, never as arguments: an argument is readable from `ps`.
    // run.ts reads stdin when it isn't a terminal and, with no message argument, uses it as the
    // message. Read from the source, not run.
    const child = spawn(
      program.command,
      [...program.args, "run", "--session", r.sessionId, ...(r.cwd ? ["--dir", r.cwd] : [])],
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
      // run.ts writes its errors to stderr (ui.ts); stdout is the model's reply.
      if (NO_SESSION.test(err)) return resolve({ ok: false, reason: "closed", detail: "deleted" });
      // A limit that still holds is retried inside the run (OpenCode waits), until the run's
      // time is up: that is the "timeout" above, and no output says "limited".
      resolve({
        ok: false,
        reason: "failed",
        detail: `exit ${code ?? "signal"}`,
        ...withMessage(err),
      });
    });
  });
}

export const opencodeHost: ClosedHost = {
  id: OPENCODE_ID,
  name: "OpenCode",
  resume: (r, text, env) => resumeOpenCode(r, text, env),
  // OpenCode's own folders (cli docs: OPENCODE_CONFIG_DIR; the XDG folders are in COMMON_VARS).
  settingsVars: ["OPENCODE_CONFIG_DIR"],
};

export interface OpenCodeHookDeps {
  closed: (ctx: HookContext) => ClosedDeps;
  program: (env: NodeJS.ProcessEnv) => string | undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** The session an event is about: `sessionID`, or the new session's `info.id`. */
function sessionOf(input: Record<string, unknown>): string | undefined {
  const p = rec(input.properties);
  const id = str(p?.sessionID) || str(rec(p?.info)?.id);
  return /^ses_[A-Za-z0-9]+$/.test(id) && safeSessionId(id) ? id : undefined;
}

/**
 * How soon after a turn's error the idle status that always follows it comes (processor.ts sets
 * idle straight after publishing the error, and the plugin hands its events over in order): that
 * idle is the turn failing, not the person carrying on.
 */
const ERROR_IDLE_MS = 10_000;

/** OpenCode retries up to five times, each with the same message: tell the person once. */
const NOTICE_MS = 10 * 60_000;

/** The limit a `session.status` of type retry carries, as a signal. */
function retrySignal(status: Record<string, unknown>): LimitSignal {
  return {
    agent: "opencode",
    source: "hook",
    code: str(rec(status.action)?.reason),
    text: str(status.message),
  };
}

/**
 * The limit in a `session.error`: an API error whose body names the plan's limit, the way retry.ts
 * tests it. Its `retry-after` header is the wait in seconds.
 */
function errorSignal(error: unknown, now: number): LimitSignal | undefined {
  const e = rec(error);
  const data = rec(e?.data);
  if (e?.name !== "APIError" || !data) return undefined;
  const body = str(data.responseBody);
  const code = body.includes("FreeUsageLimitError")
    ? "FreeUsageLimitError"
    : body.includes("GoUsageLimitError")
      ? "GoUsageLimitError"
      : undefined;
  if (!code) return undefined;
  const seconds = Number.parseFloat(str(rec(data.responseHeaders)?.["retry-after"]));
  return {
    agent: "opencode",
    source: "hook",
    code,
    text: str(data.message),
    ...(Number.isFinite(seconds) && seconds >= 0 && { resetsAt: now + Math.ceil(seconds * 1000) }),
  };
}

export function opencodeHooks(deps: OpenCodeHookDeps): HookHandler {
  return {
    isMine: (input) => sessionOf(input) !== undefined,
    sessionId: (input) => sessionOf(input),
    async handle(ctx) {
      // Rewake's own resume run loads the plugin too; what it does isn't the person's.
      if (ctx.env[FIRE_ENV]) return undefined;
      const id = sessionOf(ctx.input);
      if (!id) return undefined;
      const cwd = str(ctx.input.directory);
      const d = deps.closed(ctx);
      const records = new SessionRecords(d.stateDir, OPENCODE_ID);
      const props = rec(ctx.input.properties);
      if (ctx.event === "session.created") {
        // A sub-agent's session belongs to its parent: never resumed by itself.
        if (rec(props?.info)?.parentID !== undefined) {
          records.update(id, cwd, ctx.now, (r) => ({ ...r, child: true }));
          return undefined;
        }
      } else if (records.get(id)?.child) {
        return undefined;
      }
      if (ctx.event === "session.ended") {
        onSessionEnd(opencodeHost, id, cwd, d);
        return undefined;
      }
      // Any event shows the session is open in this OpenCode: record it with the program and the
      // process that has it, so a closed OpenCode is noticed later.
      ensureProgram(opencodeHost, id, cwd, d, () => deps.program(ctx.env));
      const had = records.get(id);
      if (ctx.event === "session.created" || !had?.open || !had.agents?.length)
        onSessionStart(opencodeHost, id, cwd, d, deps.program(ctx.env));
      switch (ctx.event) {
        case "chat.message":
          // The person (or a tool) sent a message: they carried on after any limit.
          onPrompt(opencodeHost, id, cwd, d);
          break;
        case "session.status": {
          const status = rec(props?.status);
          if (status?.type === "idle") {
            if (had?.errorAt === undefined || ctx.now - had.errorAt > ERROR_IDLE_MS)
              onPrompt(opencodeHost, id, cwd, d);
          } else if (status?.type === "retry") limited(id, cwd, retrySignal(status), had, ctx, d);
          break;
        }
        case "session.error": {
          records.update(id, cwd, ctx.now, (r) => ({ ...r, errorAt: ctx.now }));
          const signal = errorSignal(props?.error, ctx.now);
          if (signal) limited(id, cwd, signal, had, ctx, d);
          break;
        }
      }
      return undefined;
    },
  };
}

/** Record a limit, and tell the person once when it is about money, which no wait fixes. */
function limited(
  id: string,
  cwd: string,
  signal: LimitSignal,
  had: SessionRecord | undefined,
  ctx: HookContext,
  d: ClosedDeps,
): void {
  const limit = recogniseForHost(signal, ctx.now);
  if (!limit) return;
  onLimit(opencodeHost, id, cwd, limit, d);
  if (limit.billing && !(had?.limit?.billing && ctx.now - had.limit.seenAt < NOTICE_MS))
    d.notify(
      "Agent Rewake",
      `${placeOf(opencodeHost, cwd)} stopped at a limit that waiting won't lift (its free usage ran out), so Rewake won't continue it. Continue it yourself when you can.`,
    );
}
