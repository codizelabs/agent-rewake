import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { grokText } from "../../adapters/profiles.js";
import { normalize } from "../../adapters/text.js";
import { isProcessAlive } from "../../core/lock.js";
import {
  type ClosedDeps,
  type ClosedHost,
  onLimit,
  onPrompt,
  onSessionEnd,
  onSessionStart,
} from "../closed.js";
import { codexProgram as nodeAware } from "../codex/cli.js";
import { readTail } from "../codex/rollout.js";
import type { HookContext, HookHandler } from "../hook.js";
import { resumeDeadline, type SendResult } from "../host.js";
import { SESSION_GONE, type SessionLimit, type SessionRecord, safeSessionId } from "../sessions.js";

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

/** A usage limit in a Grok `StopFailure`, or undefined for any other failure. */
export function classifyGrokFailure(
  input: Record<string, unknown>,
  billing: { resetsAt?: number; full: boolean; seen?: boolean },
): Omit<SessionLimit, "seenAt"> | undefined {
  const error = str(input.error);
  const text = normalize(
    `${str(input.errorDetails ?? input.error_details)} ${str(input.lastAssistantMessage ?? input.last_assistant_message)}`,
  );
  // The weekly period's end is the reset only when the weekly pool is what ran out.
  const weekly =
    billing.full && billing.resetsAt !== undefined ? { resetsAt: billing.resetsAt } : {};
  if (error === "rate_limit") {
    // Grok's own sentences: team or plan rate limits and overloads are short-term, the free
    // usage limit isn't (shared rules, src/adapters/profiles.ts).
    const c = grokText(text.trim());
    if (c?.kind === "transient") return undefined;
    if (c?.kind === "not_recoverable") return { kind: "billing", billing: true };
    if (c?.kind === "usage_limit") return { kind: "other", billing: false, ...weekly };
    return billing.full ? { kind: "weekly", billing: false, ...weekly } : undefined;
  }
  if (error !== "invalid_request" || !/\b402\b|weekly limit|credit|spending cap/i.test(text))
    return undefined;
  // A 402: the weekly pool (wait for the reset) or a spending cap or credit limit (billing).
  const cap = /spending (?:cap|limit)|credit limit|out of credits/i.test(text);
  if (!cap && billing.full && (/weekly limit/i.test(text) || /\b402\b/.test(text)))
    return { kind: "weekly", billing: false, ...weekly };
  // Grok says "weekly limit" and its log has no recent billing line to say otherwise: still a
  // limit that resets, so the person is asked for a time rather than told nothing. (A recent line
  // whose pool isn't used up means the 402 was about money.)
  if (!cap && !billing.seen && /weekly limit/i.test(text))
    return { kind: "weekly", billing: false };
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
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(
      program.command,
      [
        ...program.args,
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
    child.on("error", () => resolve({ ok: false, reason: "failed", detail: "spawn" }));
    child.on("exit", (code) => {
      if (timedOut()) return resolve({ ok: false, reason: "failed", detail: "timeout" });
      if (code === 0) {
        // The JSON result names the session it ran in: anything else isn't this session.
        const ran = resultSession(out);
        if (ran !== undefined && ran !== r.sessionId)
          return resolve({ ok: false, reason: "failed", detail: "other-session" });
        return resolve({ ok: true });
      }
      // Exit 1 at the limit again (INFERENCE until X-G1): the text says so, on either stream.
      if (/rate limit|weekly limit|\b429\b|\b402\b/i.test(`${out}\n${err}`))
        return resolve({ ok: false, reason: "limited" });
      if (SESSION_GONE.test(`${out}\n${err}`))
        return resolve({ ok: false, reason: "closed", detail: "deleted" });
      resolve({ ok: false, reason: "failed", detail: `exit ${code ?? "signal"}` });
    });
  });
}

export function grokHost(env: NodeJS.ProcessEnv): ClosedHost {
  return {
    id: GROK_ID,
    name: "Grok Build",
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
          const limit = classifyGrokFailure(
            ctx.input,
            billingReset(grokHome(ctx.env), ctx.now, id),
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
