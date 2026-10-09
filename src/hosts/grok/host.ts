import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { grokText } from "../../adapters/profiles.js";
import { normalize } from "../../adapters/text.js";
import { classifyGrokFailure } from "../../core/limits/agents.js";
import { recogniseForHost } from "../../core/limits/recognise.js";
import { isProcessAlive } from "../../core/lock.js";
import { privateTempFile } from "../../util/fs.js";
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
import { resumeDeadline, type SendResult, withMessage } from "../host.js";
import { SESSION_GONE, type SessionRecord, safeSessionId } from "../sessions.js";

/**
 * xAI's Grok Build in a terminal (plan §9.4; Grok 1.0.46, research note §2.2, §3.2):
 *
 *   - Hooks in one file Rewake owns, `$GROK_HOME/hooks/agent-rewake.json` (always trusted).
 *   - A limit arrives as `StopFailure`: HTTP 429/503/529 as `rate_limit`; the weekly limit is
 *     HTTP 402, which Grok files under `invalid_request`. A 402 can also be a spending cap
 *     (billing, never resumed): it counts only when the text says "weekly limit".
 *   - The reset time comes from the billing line Grok logs on every prompt to
 *     `$GROK_HOME/logs/unified.jsonl` ("billing: fetched credits config", `currentPeriod.end`).
 *   - Fire: `grok --prompt-file <file> -r <session> --cwd <folder> --output-format json` for a closed
 *     session (none of its PIDs alive in `active_sessions.json`). No --always-approve, --yolo,
 *     bypassPermissions or --trust.
 *   - Grok also runs Claude Code's hooks, so every Rewake hook checks who called it: Grok sets
 *     GROK_HOOK_EVENT and sends `hookEventName`.
 */

export const GROK_ID = "grok";

export function grokHome(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return env.GROK_HOME || join(home, ".grok");
}

/** Grok marks its hook runs: the env variable, and `hookEventName` in the input. */
export function isGrok(input: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean {
  return typeof env.GROK_HOOK_EVENT === "string" || typeof input.hookEventName === "string";
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** How old a billing line may be and still describe the limit just hit (one is logged per prompt). */
const BILLING_FRESH_MS = 30 * 60_000;

/** A log line's time: RFC 3339, or epoch seconds or milliseconds. */
function lineTime(ts: unknown): number | undefined {
  if (typeof ts === "number") return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts === "string") {
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/**
 * The reset of the current usage period from Grok's newest billing log line for this session, if
 * any. A line from another session, or older than half an hour, says nothing about this limit.
 */
export function billingReset(
  home: string,
  now: number,
  sessionId?: string,
): { resetsAt?: number; full: boolean; seen?: boolean } {
  const file = join(home, "logs", "unified.jsonl");
  if (!existsSync(file)) return { full: false };
  let tail: string;
  try {
    tail = readTail(file, 512 * 1024);
  } catch {
    return { full: false };
  }
  // The newest fresh line of this session, else the newest fresh line (the session id Grok logs
  // may not be the one its hooks give: unverified, X-G2).
  let fallback: { resetsAt?: number; full: boolean; seen: boolean } | undefined;
  for (const line of tail.trim().split("\n").reverse()) {
    if (!line.includes("billing: fetched credits config")) continue;
    let rec: {
      ts?: unknown;
      sid?: unknown;
      ctx?: {
        config?: {
          creditUsagePercent?: number;
          currentPeriod?: { type?: string; end?: string };
        };
      };
    };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // A torn line: keep looking.
    }
    const at = lineTime(rec.ts);
    if (at !== undefined && now - at > BILLING_FRESH_MS) break;
    const cfg = rec.ctx?.config;
    const period = cfg?.currentPeriod;
    const usage = /WEEKLY|MONTHLY/.test(period?.type ?? "");
    const end = period?.end ? Date.parse(period.end) : Number.NaN;
    const found = {
      seen: true,
      full: usage && (cfg?.creditUsagePercent ?? 0) >= 100,
      ...(Number.isFinite(end) && end > now && { resetsAt: end }),
    };
    if (!sessionId || typeof rec.sid !== "string" || rec.sid === sessionId) return found;
    fallback ??= found;
  }
  return fallback ?? { full: false };
}

/** The session is open in a Grok window: listed in active_sessions.json with a live PID. */
export function grokSessionOpen(home: string, sessionId: string): boolean {
  try {
    const list = JSON.parse(readFileSync(join(home, "active_sessions.json"), "utf8")) as unknown;
    const entries = Array.isArray(list) ? list : Object.values(list as Record<string, unknown>);
    return entries.some((e) => {
      const s = e as { session_id?: unknown; pid?: unknown };
      return s.session_id === sessionId && typeof s.pid === "number" && isProcessAlive(s.pid);
    });
  } catch {
    return false;
  }
}

/** The session id in `grok --output-format json`'s result, when it gives one. */
export function resultSession(out: string): string | undefined {
  for (const line of out.trim().split("\n").reverse()) {
    try {
      const j = JSON.parse(line) as { sessionId?: unknown; session_id?: unknown };
      const id = j.sessionId ?? j.session_id;
      if (typeof id === "string") return id;
    } catch {
      // Not JSON: progress text.
    }
  }
  return undefined;
}

/**
 * Whether a failed headless run printed that the limit is still on. Grok's own texts: "rate limit",
 * "weekly limit" or a 429 or 402 status, and what a free account's run prints, which has none of
 * those: "You've reached your free Grok Build usage limit for now …" (what Grok shows for the 429
 * code `subscription:free-usage-exhausted`) and the 402 "Grok Build usage balance exhausted".
 * Source: xai-org/grok-build @2bdd1d6, `xai-grok-shell/src/sampling/error.rs:29-50`,
 * `xai-grok-pager/src/headless.rs:355,1415` (the `{"type":"error","message":…}` line under
 * `--output-format json`) and `dispatch/tests/billing.rs:569`.
 */
export function grokLimitAgain(out: string, err: string): boolean {
  const all = `${out}\n${err}`;
  if (/rate limit|weekly limit|\b429\b|\b402\b/i.test(all)) return true;
  // The error line's own message, on a line of its own: Grok's sentences are matched at line start.
  const messages: string[] = [];
  for (const line of out.split("\n")) {
    try {
      const m = (JSON.parse(line) as { message?: unknown } | null)?.message;
      if (typeof m === "string") messages.push(m);
    } catch {
      // Not JSON: progress text.
    }
  }
  const text = normalize(`${messages.join("\n")}\n${all}`);
  return (
    /usage balance exhausted|subscription:free-usage-exhausted/i.test(text) ||
    grokText(text)?.kind === "usage_limit"
  );
}

/** Continue the closed session headless. */
export function resumeGrok(
  r: SessionRecord,
  text: string,
  env: NodeJS.ProcessEnv,
): Promise<SendResult> {
  if (!r.program)
    return Promise.resolve({ ok: false, reason: "unsupported", detail: "no Grok found" });
  // npm's .cmd shim on Windows can't be spawned without a shell: run its script with Node.
  const program = nodeAware(r.program, process.execPath);
  // The message goes in a file, never as `-p <text>`: an argument is readable from `ps` by
  // anything else on the machine. Grok Build takes a single-turn prompt from a file
  // (`--prompt-file <PATH>`, `grok --help`, 1.0.46; checked against the pinned CLI), and reads
  // no prompt from stdin. The file is 0600 in a private directory of its own, and is deleted as
  // soon as the run ends; only its path is public.
  const prompt = privateTempFile("agent-rewake-grok-", "message.txt", text);
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(
      program.command,
      [
        ...program.args,
        "--prompt-file",
        prompt.path,
        "-r",
        r.sessionId,
        ...(r.cwd ? ["--cwd", r.cwd] : []),
        "--output-format",
        "json",
      ],
      {
        cwd: r.cwd || undefined,
        env: { ...env, GROK_DISABLE_AUTOUPDATER: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 1 << 16) err += d.toString("utf8");
    });
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 1 << 20) out += d.toString("utf8");
    });
    const timedOut = resumeDeadline(child);
    child.on("error", () => {
      prompt.remove();
      resolve({ ok: false, reason: "failed", detail: "spawn" });
    });
    child.on("exit", (code) => {
      prompt.remove();
      if (timedOut()) return resolve({ ok: false, reason: "failed", detail: "timeout" });
      if (code === 0) {
        // The JSON result names the session it ran in: anything else isn't this session.
        const ran = resultSession(out);
        if (ran !== undefined && ran !== r.sessionId)
          return resolve({ ok: false, reason: "failed", detail: "other-session" });
        return resolve({ ok: true });
      }
      // Exit 1 at the limit again (INFERENCE until X-G1): the text says so, on either stream.
      if (grokLimitAgain(out, err)) {
        // The run logged a billing line: its period's end, when the pool is what ran out.
        const b = billingReset(grokHome(env), Date.now(), r.sessionId);
        const resetsAt = b.full ? b.resetsAt : undefined;
        return resolve({ ok: false, reason: "limited", ...(resetsAt && { resetsAt }) });
      }
      if (SESSION_GONE.test(`${out}\n${err}`))
        return resolve({ ok: false, reason: "closed", detail: "deleted" });
      resolve({
        ok: false,
        reason: "failed",
        detail: `exit ${code ?? "signal"}`,
        ...withMessage(err || out),
      });
    });
  });
}

export function grokHost(env: NodeJS.ProcessEnv): ClosedHost {
  return {
    id: GROK_ID,
    name: "Grok Build",
    resume: (r, text, e) => resumeGrok(r, text, e),
    isOpen: (r) => grokSessionOpen(grokHome({ ...env, ...r.env }), r.sessionId),
    settingsVars: [
      "GROK_HOME",
      "GROK_CLI_CHAT_PROXY_BASE_URL",
      "GROK_XAI_API_BASE_URL",
      "GROK_MODELS_BASE_URL",
    ],
    keyVars: ["XAI_API_KEY"],
  };
}

export interface GrokHookDeps {
  closed: (ctx: HookContext) => ClosedDeps;
  program: (env: NodeJS.ProcessEnv) => string | undefined;
}

export function grokHooks(deps: GrokHookDeps): HookHandler {
  return {
    isMine: isGrok,
    sessionId: (input) => {
      const id = input.sessionId ?? input.session_id;
      return safeSessionId(id) ? id : undefined;
    },
    async handle(ctx) {
      const id = ctx.input.sessionId ?? ctx.input.session_id;
      if (!safeSessionId(id)) return undefined;
      // A sub-agent's own events belong to its parent session.
      if (ctx.input.subagentType) return undefined;
      const cwd = str(ctx.input.cwd) || str(ctx.input.workspaceRoot);
      const d = deps.closed(ctx);
      // Rewake's own resume runs aren't the person's: no program lookup for them.
      if (!ctx.env[FIRE_ENV])
        ensureProgram(grokHost(ctx.env), id, cwd, d, () => deps.program(ctx.env));
      const host = grokHost(ctx.env);
      switch (ctx.event) {
        case "SessionStart":
          onSessionStart(host, id, cwd, d, deps.program(ctx.env));
          break;
        case "UserPromptSubmit":
          onPrompt(host, id, cwd, d);
          break;
        case "StopFailure": {
          const limit = recogniseForHost(
            {
              agent: "grok",
              source: "hook",
              ...(typeof ctx.input.error === "string" && { code: ctx.input.error }),
              text: `${str(ctx.input.errorDetails ?? ctx.input.error_details)} ${str(ctx.input.lastAssistantMessage ?? ctx.input.last_assistant_message)}`,
              period: billingReset(grokHome(ctx.env), ctx.now, id),
            },
            ctx.now,
          );
          if (limit) onLimit(host, id, cwd, limit, d);
          break;
        }
        case "SessionEnd":
          onSessionEnd(host, id, cwd, d);
          break;
      }
      return undefined;
    },
  };
}

// Moved to the core (plan §3.4); kept here for existing imports.
export { classifyGrokFailure };
