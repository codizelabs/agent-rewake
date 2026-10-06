import type { Schedule } from "../../core/store.js";
import type { HostAdapter, HostFacts, SendResult } from "../host.js";
import { codexProgram, type Program, queueMessage, readUsage, type Usage } from "./cli.js";
import { findCodexLimit, readTail } from "./rollout.js";

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
      if (transcript) {
        try {
          // A turn after the limit (the person typed) clears it in the session file.
          facts.userTypedSince = !findCodexLimit(readTail(transcript), now).limited;
        } catch {
          // The session file is gone: send() reports the thread as deleted.
        }
      }
      const codex = programOf(s, deps.node);
      if (codex) {
        const u = await usage(codex, envOf(s, deps.env));
        if (u.ok) {
          if (u.allowed !== undefined) facts.usageAllowed = u.allowed;
          if (u.allowed === false && u.resetsAt && u.resetsAt > now) facts.newResetsAt = u.resetsAt;
        } else if (u.reason === "signed-out") signedOut.add(s.scheduleId);
      }
      return facts;
    },

    async send(s): Promise<SendResult> {
      if (signedOut.has(s.scheduleId)) return { ok: false, reason: "failed", detail: "signed-out" };
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
