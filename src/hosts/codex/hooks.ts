import { basename } from "node:path";
import { decideArm, RESET_MARGIN_MS } from "../../core/resume.js";
import { loadSettings } from "../../core/settings.js";
import { type Schedule, ScheduleStore, TERMINAL_STATUSES } from "../../core/store.js";
import { DEFAULT_RESUME_PROMPT } from "../../core/threads.js";
import { formatAt, parseWhen } from "../../core/time.js";
import { autoFor } from "../closed.js";
import type { HookContext, HookHandler } from "../hook.js";
import { findCodexLimit, isCodexRollout, readTail, threadIdOf } from "./rollout.js";

/**
 * Codex's hooks (installed as a Codex plugin, src/hosts/codex/plugin.ts). Codex runs no hook when
 * a turn fails at a usage limit, so the hooks read the thread's session file at the moments they
 * do run (research note §3.1.4):
 *
 *   - UserPromptSubmit: the prompt "rewake" (or "rewake 3:30pm") in a thread at a limit arms the
 *     resume and is blocked, so it never reaches the model. Any other prompt cancels a pending
 *     resume for the thread: the person carried on.
 *   - SessionEnd: a limit nobody answered is armed when the person chose automatic resume and the
 *     reset is within a day; otherwise one notification says how to continue.
 *   - SessionStart: nothing beyond the sweep every hook does.
 */

export interface CodexHookDeps {
  /**
   * Arm a resume's timer, or fire it now when due (src/timers/sweep.ts scheduleFire). Returns
   * false when this computer has no timer Rewake can use, or setting it failed.
   */
  arm: (id: string, at: number) => boolean | undefined;
  /** Remove a resume's timer. */
  disarm: (id: string) => void;
  notify: (title: string, body: string) => void;
  /** The Codex program to resume with, found when the resume is armed. */
  codexPath: () => string | undefined;
}

const REWAKE = /^\s*rewake(?:\s+(.+?))?\s*$/i;

function threadOf(input: Record<string, unknown>): { id: string; path: string } | undefined {
  const path = input.transcript_path;
  if (!isCodexRollout(path)) return undefined;
  const id = threadIdOf(path);
  return id ? { id, path } : undefined;
}

function pendingFor(store: ScheduleStore, threadId: string): Schedule[] {
  // Missed resumes and ones needing attention were already reported: a new limit replaces them.
  return store
    .listForSession(threadId, "codex")
    .filter(
      (s) => !TERMINAL_STATUSES.has(s.status) && !["missed", "needs_attention"].includes(s.status),
    );
}

/**
 * What Rewake says once a Codex thread's continue is set. Codex runs the message when the thread is
 * open: if Codex is closed at that time, the thread continues the next time it's opened.
 */
export function armedText(at: number, now: number): string {
  return `Rewake will continue this thread ${formatAt(at, now)}. Keep this computer on and awake until then. If Codex is closed at that time, the thread continues when you next open it. To cancel, send any other message in the thread.`;
}

/** No timer could be set (no scheduler on this computer, or it refused). */
export function noTimerText(at: number, now: number): string {
  return `Rewake couldn't set a timer on this computer, so it can't continue this thread by itself. After the limit resets ${formatAt(at, now)}, send a message in the thread to continue.`;
}

/** Block Codex's prompt with a reason it shows to the person. */
const block = (reason: string) => JSON.stringify({ decision: "block", reason });

export function codexHooks(deps: CodexHookDeps): HookHandler {
  /** Arm a resume; false (and the resume cancelled) when no timer could be set. */
  const arm = (ctx: HookContext, thread: { id: string; path: string }, at: number): boolean => {
    const store = new ScheduleStore(ctx.stateDir);
    const settings = loadSettings(ctx.stateDir);
    const cwd = typeof ctx.input.cwd === "string" ? ctx.input.cwd : "";
    const codex = deps.codexPath();
    const s = store.create({
      sessionId: thread.id,
      cwd,
      text: settings.resumePrompt ?? DEFAULT_RESUME_PROMPT,
      dueAt: at,
      kind: "limit_resume",
      createdBy: "agent",
      now: ctx.now,
    });
    const home = ctx.env.CODEX_HOME;
    const resume: Schedule = {
      ...s,
      host: "codex",
      sessionRef: {
        threadId: thread.id,
        transcript: thread.path,
        ...(codex && { codex }),
        ...(home && { codexHome: home }),
      },
    };
    store.put(resume);
    if (deps.arm(resume.scheduleId, at) !== false) return true;
    store.update(resume.scheduleId, (x) => ({ ...x, status: "cancelled" }), ctx.now);
    return false;
  };

  const cancelPending = (ctx: HookContext, threadId: string) => {
    const store = new ScheduleStore(ctx.stateDir);
    for (const s of pendingFor(store, threadId)) {
      store.update(s.scheduleId, (x) => ({ ...x, status: "cancelled" }), ctx.now);
      deps.disarm(s.scheduleId);
    }
  };

  return {
    isMine: (input, env) => !env.GROK_HOOK_EVENT && isCodexRollout(input.transcript_path),
    sessionId: (input) => threadOf(input)?.id,

    async handle(ctx) {
      const thread = threadOf(ctx.input);
      if (!thread) return undefined;
      loadSettings(ctx.stateDir); // the person's clock, for the times below

      if (ctx.event === "UserPromptSubmit") {
        const prompt = typeof ctx.input.prompt === "string" ? ctx.input.prompt : "";
        const m = REWAKE.exec(prompt);
        if (!m) {
          cancelPending(ctx, thread.id);
          return undefined;
        }
        let limit: ReturnType<typeof findCodexLimit>;
        try {
          limit = findCodexLimit(readTail(thread.path), ctx.now);
        } catch {
          limit = { limited: false };
        }
        if (!limit.limited)
          return block(
            "Rewake: this thread isn't at a usage limit, so there's nothing to continue.",
          );
        if (limit.billing)
          return block(
            "Rewake can't continue after this limit: this limit is about credits or spending, which waiting doesn't fix.",
          );
        let at: number | undefined;
        if (m[1]) {
          const when = parseWhen(m[1], ctx.now);
          if (!when.ok) return block(`Rewake didn't understand "${m[1]}". Try "rewake 3:30pm".`);
          at = when.at;
        } else {
          // The session file's reset, or a later one Codex reported when Rewake last tried.
          const later = new ScheduleStore(ctx.stateDir)
            .listForSession(thread.id, "codex")
            .filter((x) => x.failureReason === "far-reset" || x.failureReason === "expired")
            .map((x) => x.dueAt)
            .filter((t) => t > ctx.now);
          const times = [
            ...(limit.resetsAt ? [limit.resetsAt + RESET_MARGIN_MS] : []),
            ...later,
          ].filter((t) => t > ctx.now);
          if (times.length > 0) at = Math.max(...times);
        }
        if (at === undefined)
          return block(
            'Rewake doesn\'t know when this limit resets. Type "rewake" with a time, for example "rewake 3:30pm".',
          );
        cancelPending(ctx, thread.id);
        if (!arm(ctx, thread, at)) return block(noTimerText(at, ctx.now));
        return block(armedText(at, ctx.now));
      }

      if (ctx.event === "SessionEnd") {
        if (pendingFor(new ScheduleStore(ctx.stateDir), thread.id).length > 0) return undefined;
        let limit: ReturnType<typeof findCodexLimit>;
        try {
          limit = findCodexLimit(readTail(thread.path), ctx.now);
        } catch {
          return undefined;
        }
        if (!limit.limited) return undefined;
        const settings = loadSettings(ctx.stateDir);
        const decision = decideArm({
          now: ctx.now,
          ...(limit.resetsAt !== undefined && { resetsAt: limit.resetsAt }),
          isBilling: limit.billing === true,
          auto: autoFor(settings),
        });
        const cwd = typeof ctx.input.cwd === "string" ? basename(ctx.input.cwd) : "";
        const where = cwd ? `Codex in the "${cwd}" folder` : "Codex";
        if (decision.action === "arm") {
          const ok = arm(ctx, thread, decision.fireAt);
          deps.notify(
            "Agent Rewake",
            `${where}: ${ok ? armedText(decision.fireAt, ctx.now) : noTimerText(decision.fireAt, ctx.now)}`,
          );
          return undefined;
        }
        if (decision.action === "offer") {
          const how = limit.resetsAt
            ? `type "rewake", and Rewake continues it ${formatAt(limit.resetsAt + RESET_MARGIN_MS, ctx.now)}, after the limit resets`
            : 'type "rewake" with a time, for example "rewake 3:30pm"';
          deps.notify(
            "Agent Rewake",
            `${where} hit its usage limit. Resume the thread in Codex and ${how}.`,
          );
        }
        return undefined;
      }
      return undefined;
    },
  };
}
