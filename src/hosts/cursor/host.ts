import { readFileSync } from "node:fs";
import { continueOnly, type RewakePlace } from "../../core/command.js";
import { recogniseForHost } from "../../core/limits/recognise.js";
import { RESET_MARGIN_MS } from "../../core/resume.js";
import { ScheduleStore } from "../../core/store.js";
import { formatAt } from "../../core/time.js";
import {
  armClosed,
  type ClosedDeps,
  type ClosedHost,
  onLimit,
  onPrompt,
  onSessionEnd,
  pendingFor,
  placeOf,
} from "../closed.js";
import type { HookContext, HookHandler } from "../hook.js";
import { SessionRecords, safeSessionId } from "../sessions.js";
import { WAIT_SECONDS } from "./install.js";

/**
 * Cursor's own agent (preview). Its hooks (install.ts) tell Rewake when the person types and when
 * a chat stops at a usage limit. Cursor gives no way to send into a chat from outside, so delivery
 * is by the `stop` hook itself: at a limit it waits for the time the person picks, then answers
 * with `followup_message`, which Cursor submits into the same chat (research cursor-agent-2026-10-08,
 * E-C3). It stays silent when the person has typed since (E-C4: Cursor would otherwise submit it
 * after their turn). If the window closes, the waiting hook goes with it: the system timer, a few
 * minutes after the time, tells the person to continue the chat themselves.
 *
 * `/rewake` (the slash is optional, same as Codex's bare `rewake`) is typed into the chat like any
 * other message: `beforeSubmitPrompt` recognises it, arms the resume with the shared command
 * grammar (src/core/command.ts), and answers with `{"continue":false,"user_message":…}`, which
 * Cursor shows instead of sending the text to the model. Cursor's own docs confirm `continue:
 * false` blocks the submission (cursor.com/docs/hooks, checked 2026-10-10); it isn't a registered
 * slash command the way Zed's ACP menu is — Cursor's hooks have no way to add one — just recognised
 * text, the same shape as Codex's. Only continuing after a limit, listing and cancelling: Cursor
 * can't schedule an arbitrary message or repeat one, so its RewakePlace has no extra features.
 *
 * Cursor's payload carries the person's email address: nothing from it is stored but the chat id,
 * its folder and the limit.
 */
export const CURSOR_ID = "cursor";

const CURSOR_PLACE: RewakePlace = { name: "Cursor", typed: "/rewake", features: new Set() };
/** The slash is optional: `/rewake 3pm` and `rewake 3pm` both work, matching Codex's bare form. */
const REWAKE = /^\s*\/?rewake(?:\s+([\s\S]*?))?\s*$/i;

/** Cursor's own hook response: shown to the person instead of sending the text to the model. */
function block(userMessage: string): string {
  return JSON.stringify({ continue: false, user_message: userMessage });
}

/** After the chosen time, how long the timer waits before telling the person (the hook goes first). */
const FALLBACK_MS = 3 * 60_000;
/** How often the waiting hook looks for the person's choice. */
const POLL_MS = 5_000;

export const cursorHost: ClosedHost = {
  id: CURSOR_ID,
  name: "Cursor",
  noun: "chat",
  reopen: "open the chat in Cursor",
  fallbackDelayMs: FALLBACK_MS,
  maxWaitAfterLimitMs: WAIT_SECONDS * 1000 - 60_000,
  keepOpen: "Keep that Cursor window open until then: reloading or quitting Cursor cancels it.",
  // Reached only when the waiting hook didn't deliver (the window was closed): nothing to run.
  resume: async () => ({ ok: false, reason: "failed", detail: "window-closed" }),
};

/** The error the transcript's last line records, when the turn ended in one. */
export function transcriptError(path: unknown): string | undefined {
  if (typeof path !== "string" || path === "") return undefined;
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1) ?? "{}") as {
      type?: unknown;
      status?: unknown;
      error?: unknown;
    };
    if (last.type === "turn_ended" && last.status === "error" && typeof last.error === "string")
      return last.error;
  } catch {
    // No transcript, or not Cursor's format.
  }
  return undefined;
}

export interface CursorHookDeps {
  closed: (ctx: HookContext) => ClosedDeps;
  /** Tests: the clock and the wait (the real hook sleeps). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The most the hook waits, in ms (tests: short). */
  waitMs?: number;
}

const isCursor = (input: Record<string, unknown>) =>
  typeof input.cursor_version === "string" && typeof input.hook_event_name === "string";

export function cursorHooks(deps: CursorHookDeps): HookHandler {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    isMine: isCursor,
    sessionId: (input) =>
      safeSessionId(input.conversation_id) ? input.conversation_id : undefined,
    async handle(ctx) {
      const id = ctx.input.conversation_id;
      if (!safeSessionId(id)) return undefined;
      const roots = ctx.input.workspace_roots;
      const cwd = Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : "";
      const d = deps.closed(ctx);
      if (ctx.event === "beforeSubmitPrompt") {
        const prompt = typeof ctx.input.prompt === "string" ? ctx.input.prompt : "";
        const m = REWAKE.exec(prompt);
        if (!m) {
          onPrompt(cursorHost, id, cwd, d);
          return undefined;
        }
        return handleRewake(id, m[1] ?? "", ctx, d);
      }
      if (ctx.event !== "stop") return undefined;
      if (ctx.input.status !== "error") return "{}";
      const limit = recogniseForHost(
        { agent: "cursor", source: "hook", text: transcriptError(ctx.input.transcript_path) ?? "" },
        ctx.now,
      );
      if (!limit) return "{}";
      onLimit(cursorHost, id, cwd, limit, d, ctx.input.transcript_path);
      // The chat is "closed" for Rewake now: it's offered by `agent-rewake continue`, or armed.
      onSessionEnd(cursorHost, id, cwd, d);
      if (limit.billing) {
        d.notify(
          "Agent Rewake",
          `${placeOf(cursorHost, cwd)} hit a usage limit that waiting won't lift (it needs a paid plan, more usage or a new month), so Rewake can't continue it. Continue the chat in Cursor when you can.`,
        );
        return "{}";
      }
      return waitAndDeliver(id, ctx, d, now, sleep, deps.waitMs ?? WAIT_SECONDS * 1000 - 60_000);
    },
  };
}

/**
 * `/rewake …` typed into the chat: continue after the limit, at the reset or a chosen time, list
 * or cancel what's planned. Arms the same kind of resume `agent-rewake continue` would (armClosed,
 * src/hosts/closed.ts): the `stop` hook that's already waiting (waitAndDeliver) polls the same
 * store and delivers it — nothing about delivery changes, only how the time gets chosen.
 */
function handleRewake(id: string, args: string, ctx: HookContext, d: ClosedDeps): string {
  const records = new SessionRecords(ctx.stateDir, CURSOR_ID);
  const c = continueOnly(CURSOR_PLACE, args, ctx.now);
  if (c.kind === "reply") return block(c.text);
  if (c.kind === "list") {
    const next = pendingFor(ctx.stateDir, CURSOR_ID, id).sort((a, b) => a.dueAt - b.dueAt)[0];
    return block(
      next
        ? `Rewake will continue this chat ${formatAt(next.dueAt, ctx.now)}. To cancel: /rewake cancel`
        : "Rewake: Nothing is set to continue this chat. At a usage limit, type /rewake to continue after the reset.",
    );
  }
  if (c.kind === "cancel") {
    const pending = pendingFor(ctx.stateDir, CURSOR_ID, id);
    const store = new ScheduleStore(ctx.stateDir);
    for (const s of pending) if (store.cancel(s.scheduleId, ctx.now)) d.disarm(s.scheduleId);
    return block(
      pending.length > 0
        ? "Rewake: Cancelled. This chat won't be continued on its own."
        : "Rewake: Nothing is set to continue this chat.",
    );
  }
  const r = records.get(id);
  const limit = r?.limit;
  if (!r || !limit)
    return block("Rewake: this chat isn't at a usage limit, so there's nothing to continue.");
  if (limit.billing)
    return block(
      "Rewake can't continue after this limit: this limit is about credits or spending, which waiting doesn't fix.",
    );
  const at = c.at ?? (limit.resetsAt !== undefined ? limit.resetsAt + RESET_MARGIN_MS : undefined);
  if (at === undefined)
    return block("Rewake doesn't know when this resets yet. Try /rewake 3:30pm.");
  // Cursor can only continue a chat from inside the stop hook that's already waiting for it
  // (there's no way to send into a chat from outside): the same four-hour bound that hook has.
  const maxAt = ctx.now + (cursorHost.maxWaitAfterLimitMs ?? WAIT_SECONDS * 1000 - 60_000);
  if (at > maxAt)
    return block(
      `Rewake can only continue a Cursor chat within 4 hours of its usage limit. Try a time before ${formatAt(maxAt, ctx.now)}.`,
    );
  armClosed(cursorHost, r, at, d);
  return block(
    `Rewake will continue this chat ${formatAt(at, ctx.now)}. Keep this window open until then. Typing again before then cancels it.`,
  );
}

/** Wait for the chosen time, then answer with the continue, unless the person typed meanwhile. */
async function waitAndDeliver(
  id: string,
  ctx: HookContext,
  d: ClosedDeps,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  waitMs: number,
): Promise<string> {
  const records = new SessionRecords(ctx.stateDir, CURSOR_ID);
  const store = new ScheduleStore(ctx.stateDir);
  const seenAt = records.get(id)?.limit?.seenAt ?? ctx.now;
  const deadline = ctx.now + waitMs;
  while (now() < deadline) {
    if ((records.get(id)?.lastPromptAt ?? 0) > seenAt) return "{}";
    const s = pendingFor(ctx.stateDir, CURSOR_ID, id).sort((a, b) => a.dueAt - b.dueAt)[0];
    if (s && s.dueAt > deadline) {
      // Later than this hook can wait (`continue` doesn't offer that): say so, now, truthfully.
      store.update(
        s.scheduleId,
        (x) => ({ ...x, status: "failed", failureReason: "too-late" }),
        now(),
      );
      d.disarm(s.scheduleId);
      d.notify(
        "Agent Rewake",
        `${placeOf(cursorHost, records.get(id)?.cwd ?? "")}: Rewake can continue a Cursor chat only within 4 hours of its usage limit, so it won't continue this one ${formatAt(s.dueAt, now())}. Open the chat in Cursor then to continue it.`,
      );
      return "{}";
    }
    if (s && s.dueAt <= now()) {
      store.update(
        s.scheduleId,
        (x) => ({ ...x, status: "sent", lastRun: { at: now(), outcome: "sent" } }),
        now(),
      );
      d.disarm(s.scheduleId);
      return JSON.stringify({ followup_message: s.text });
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
  return "{}";
}
