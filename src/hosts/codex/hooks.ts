import { basename } from "node:path";
import { decideArm, RESET_MARGIN_MS } from "../../core/resume.js";
import { loadSettings } from "../../core/settings.js";
import { type Schedule, ScheduleStore, TERMINAL_STATUSES } from "../../core/store.js";
import { DEFAULT_RESUME_PROMPT } from "../../core/threads.js";
import { formatAt, parseWhen } from "../../core/time.js";
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
  /** Arm a resume's timer, or fire it now when due (src/timers/sweep.ts scheduleFire). */
  arm: (id: string, at: number) => void;
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
  return store.listForSession(threadId, "codex").filter((s) => !TERMINAL_STATUSES.has(s.status));
}

/** Block Codex's prompt with a reason it shows to the person. */
const block = (reason: string) => JSON.stringify({ decision: "block", reason });

export function codexHooks(deps: CodexHookDeps): HookHandler {
  const arm = (ctx: HookContext, thread: { id: string; path: string }, at: number): Schedule => {
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
    deps.arm(resume.scheduleId, at);
    return resume;
  };

  const cancelPending = (ctx: HookContext, threadId: string) => {
    const store = new ScheduleStore(ctx.stateDir);
    for (const s of pendingFor(store, threadId)) {
      store.update(s.scheduleId, (x) => ({ ...x, status: "cancelled" }), ctx.now);
      deps.disarm(s.scheduleId);
    }
  };

  return {
    isMine: (input) => isCodexRollout(input.transcript_path),
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
        arm(ctx, thread, at);
        return block(
          `Rewake will continue this thread ${formatAt(at, ctx.now)}. Keep this computer on and awake until then. Sending any other message here cancels that.`,
        );
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
          auto:
            settings.newThreads === "on" && settings.autoWhenPromptsSkipped
              ? "always"
              : settings.newThreads === "off"
                ? "never"
                : "ask",
        });
        const cwd = typeof ctx.input.cwd === "string" ? basename(ctx.input.cwd) : "";
        const where = cwd ? `Codex in ${cwd}` : "Codex";
        if (decision.action === "arm") {
          arm(ctx, thread, decision.fireAt);
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
