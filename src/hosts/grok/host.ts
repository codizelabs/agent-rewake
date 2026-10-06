import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "../../core/lock.js";
import {
  type ClosedDeps,
  type ClosedHost,
  onLimit,
  onPrompt,
  onSessionEnd,
  onSessionStart,
} from "../closed.js";
import { readTail } from "../codex/rollout.js";
import type { HookContext, HookHandler } from "../hook.js";
import type { SendResult } from "../host.js";
import { type SessionLimit, type SessionRecord, safeSessionId } from "../sessions.js";

/**
 * xAI's Grok Build in a terminal (plan §9.4; Grok 1.0.46, research note §2.2, §3.2):
 *
 *   - Hooks in one file Rewake owns, `$GROK_HOME/hooks/agent-rewake.json` (always trusted).
 *   - A limit arrives as `StopFailure`: HTTP 429/503/529 as `rate_limit`; the weekly limit is
 *     HTTP 402, which Grok files under `invalid_request`. A 402 can also be a spending cap
 *     (billing, never resumed): it counts only when the text says "weekly limit".
 *   - The reset time comes from the billing line Grok logs on every prompt to
 *     `$GROK_HOME/logs/unified.jsonl` ("billing: fetched credits config", `currentPeriod.end`).
 *   - Fire: `grok -p "<message>" -r <session> --cwd <folder> --output-format json` for a closed
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

/** The reset of the current usage period from Grok's newest billing log line, if any. */
export function billingReset(home: string, now: number): { resetsAt?: number; full: boolean } {
  const file = join(home, "logs", "unified.jsonl");
  if (!existsSync(file)) return { full: false };
  let tail: string;
  try {
    tail = readTail(file, 512 * 1024);
  } catch {
    return { full: false };
  }
  for (const line of tail.trim().split("\n").reverse()) {
    if (!line.includes("billing: fetched credits config")) continue;
    try {
      const rec = JSON.parse(line) as {
        ctx?: {
          config?: {
            creditUsagePercent?: number;
            currentPeriod?: { type?: string; end?: string };
          };
        };
      };
      const cfg = rec.ctx?.config;
      const period = cfg?.currentPeriod;
      const usage = /WEEKLY|MONTHLY/.test(period?.type ?? "");
      const end = period?.end ? Date.parse(period.end) : Number.NaN;
      return {
        full: usage && (cfg?.creditUsagePercent ?? 0) >= 100,
        ...(Number.isFinite(end) && end > now && { resetsAt: end }),
      };
    } catch {
      // A torn line: keep looking.
    }
  }
  return { full: false };
}

/** A usage limit in a Grok `StopFailure`, or undefined for any other failure. */
export function classifyGrokFailure(
  input: Record<string, unknown>,
  billing: { resetsAt?: number; full: boolean },
): Omit<SessionLimit, "seenAt"> | undefined {
  const error = str(input.error);
  const text = `${str(input.errorDetails ?? input.error_details)} ${str(input.lastAssistantMessage ?? input.last_assistant_message)}`;
  if (error === "rate_limit")
    return {
      kind: "other",
      billing: false,
      ...(billing.resetsAt !== undefined && { resetsAt: billing.resetsAt }),
    };
  if (error !== "invalid_request" || !/\b402\b|weekly limit|credit|spending cap/i.test(text))
    return undefined;
  // A 402: the weekly pool (wait for the reset) or a spending cap (billing).
  if (/weekly limit/i.test(text) && billing.full)
    return {
      kind: "weekly",
      billing: false,
      ...(billing.resetsAt !== undefined && { resetsAt: billing.resetsAt }),
    };
  return { kind: "billing", billing: true };
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

/** Continue the closed session headless. */
export function resumeGrok(
  r: SessionRecord,
  text: string,
  env: NodeJS.ProcessEnv,
): Promise<SendResult> {
  if (!r.program)
    return Promise.resolve({ ok: false, reason: "unsupported", detail: "no Grok found" });
  const program = r.program;
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(
      program,
      [
        "-p",
        text,
        "-r",
        r.sessionId,
        ...(r.cwd ? ["--cwd", r.cwd] : []),
        "--output-format",
        "json",
      ],
      {
        cwd: r.cwd || undefined,
        env: { ...env, GROK_DISABLE_AUTOUPDATER: "1" },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 1 << 20) out += d.toString("utf8");
    });
    child.on("error", () => resolve({ ok: false, reason: "failed", detail: "spawn" }));
    child.on("exit", (code) => {
      if (code === 0) return resolve({ ok: true });
      // Exit 1 at the limit again (INFERENCE until X-G1): the text says so.
      if (/rate limit|weekly limit|\b429\b|\b402\b/i.test(out))
        return resolve({ ok: false, reason: "limited" });
      resolve({ ok: false, reason: "failed", detail: `exit ${code ?? "signal"}` });
    });
  });
}

export function grokHost(env: NodeJS.ProcessEnv): ClosedHost {
  return {
    id: GROK_ID,
    name: "Grok Build",
    reopen: 'resume the session with "grok -r"',
    resume: (r, text, e) => resumeGrok(r, text, e),
    isOpen: (r) => grokSessionOpen(grokHome(env), r.sessionId),
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
      const host = grokHost(ctx.env);
      switch (ctx.event) {
        case "SessionStart":
          onSessionStart(host, id, cwd, d, deps.program(ctx.env));
          break;
        case "UserPromptSubmit":
          onPrompt(host, id, cwd, d);
          break;
        case "StopFailure": {
          const limit = classifyGrokFailure(ctx.input, billingReset(grokHome(ctx.env), ctx.now));
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
