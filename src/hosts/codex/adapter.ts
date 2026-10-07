import { MAX_REARMS } from "../../core/resume.js";
import type { Schedule } from "../../core/store.js";
import type { HostAdapter, HostFacts, SendResult } from "../host.js";
import { codexProgram, type Program, queueMessage, readUsage, type Usage } from "./cli.js";
import { findCodexLimit, readTail, userMessages } from "./rollout.js";

/**
 * Resuming a Codex thread at `fire` time (plan §9.2.3): the thread's session file says whether the
 * person carried on; Codex's own usage check says whether the limit is over; `codex queue` delivers
 * the message into the same thread, live where a Codex has it open, otherwise when it's next
 * opened. Codex writes the turn, so there is never a second writer: no "session open" check.
 */
export interface CodexAdapterDeps {
  /** The environment to run Codex in (CODEX_HOME from the resume is added). */
  env: NodeJS.ProcessEnv;
  node: string;
  /** Overridable for tests. */
  readUsage?: (codex: Program, env: NodeJS.ProcessEnv) => Promise<Usage>;
  queue?: typeof queueMessage;
}

function programOf(s: Schedule, node: string): Program | undefined {
  const path = s.sessionRef?.codex;
  return path ? codexProgram(path, node) : undefined;
}

function envOf(s: Schedule, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = s.sessionRef?.codexHome;
  return home ? { ...base, CODEX_HOME: home } : base;
}

export function codexAdapter(deps: CodexAdapterDeps): HostAdapter {
  const usage = deps.readUsage ?? ((codex, env) => readUsage(codex, env));
  const queue = deps.queue ?? queueMessage;
  /** Sign-in problems found by `check`, reported by `send`. */
  const signedOut = new Set<string>();
  /** Resumes whose usage check never answered (offline, Codex stuck), reported by `send`. */
  const unanswered = new Set<string>();

  return {
    id: "codex",
    name: "Codex",
    noun: "thread",
    reopen: "resume the thread in Codex",
    again: (at) =>
      at
        ? `Resume the thread in Codex and type "rewake", and Rewake continues it ${at}.`
        : 'Resume the thread in Codex and type "rewake" with a time, for example "rewake 3:30pm".',

    async check(s, now) {
      const facts: HostFacts = {};
      const transcript = s.sessionRef?.transcript;
      let limit: ReturnType<typeof findCodexLimit> | undefined;
      if (transcript) {
        try {
          // A turn after the limit (the person typed) clears it in the session file.
          limit = findCodexLimit(readTail(transcript), now);
          facts.userTypedSince = !limit.limited;
        } catch {
          // The session file is gone: send() reports the thread as deleted.
        }
      }
      const codex = programOf(s, deps.node);
      let noAnswer = false;
      if (codex) {
        const u = await usage(codex, envOf(s, deps.env));
        if (u.ok) {
          if (u.allowed !== undefined) facts.usageAllowed = u.allowed;
          if (u.allowed === false && u.resetsAt && u.resetsAt > now) facts.newResetsAt = u.resetsAt;
        } else if (u.reason === "signed-out") signedOut.add(s.scheduleId);
        else if (u.reason === "timeout" || u.reason === "error") noAnswer = true;
      }
      // Codex couldn't say (no answer, no figure): don't send before the reset the session file
      // recorded (research §4.4), so a time chosen before the reset waits for it.
      if (
        facts.usageAllowed === undefined &&
        limit?.limited &&
        limit.resetsAt !== undefined &&
        limit.resetsAt > now
      ) {
        facts.usageAllowed = false;
        facts.newResetsAt = limit.resetsAt;
      }
      // No answer at all (offline, or Codex stuck): `codex queue` would still succeed and the turn
      // then fail, spending the resume. Check again later; after the last re-check, tell the person.
      unanswered.delete(s.scheduleId);
      if (facts.usageAllowed === undefined && noAnswer) {
        if ((s.rearms ?? 0) < MAX_REARMS) facts.usageAllowed = false;
        else unanswered.add(s.scheduleId);
      }
      return facts;
    },

    delivered(s) {
      const transcript = s.sessionRef?.transcript;
      if (!transcript) return undefined;
      try {
        return userMessages(readTail(transcript, 512 * 1024)).includes(s.text) || undefined;
      } catch {
        return undefined;
      }
    },

    async send(s): Promise<SendResult> {
      if (signedOut.has(s.scheduleId)) return { ok: false, reason: "failed", detail: "signed-out" };
      if (unanswered.has(s.scheduleId)) return { ok: false, reason: "failed", detail: "no-usage" };
      const codex = programOf(s, deps.node);
      const thread = s.sessionRef?.threadId;
      if (!codex || !thread) return { ok: false, reason: "unsupported", detail: "no Codex found" };
      const env = envOf(s, deps.env);
      let r = await queue(codex, thread, s.text, env);
      // Codex's shared app-server daemon is running: queue through it instead.
      if (!r.ok && r.reason === "daemon") r = await queue(codex, thread, s.text, env, "unix://");
      if (r.ok) return { ok: true };
      return {
        ok: false,
        reason: r.reason === "archived" || r.reason === "deleted" ? "closed" : "failed",
        detail: r.reason,
      };
    },
  };
}
