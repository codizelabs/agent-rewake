import { ThreadStore } from "../core/threads.js";
import { ownedByZed } from "./index.js";

/**
 * `agent-rewake hook <host> <event>`: what an agent's hook runs. It reads the event (JSON on
 * stdin), does the little it must within the hook's few seconds, and exits 0, printing a reply
 * only when the host expects one (Codex: blocking the prompt "rewake"). It never sends a message
 * itself: due resumes go to a detached `fire` (src/timers/sweep.ts).
 *
 * It stands down, doing nothing, when:
 *   - the agent was started by Rewake's Zed add-on (AGENT_REWAKE_OWNER=acp), or Zed's add-on has
 *     a record of the same session: one owner per session (plan §3.5);
 *   - the event didn't come from the host it was installed for. Grok also runs Claude Code's
 *     hooks, so each host checks the shape of its own input.
 */

export interface HookContext {
  event: string;
  input: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  now: number;
}

export interface HookHandler {
  /** The input came from this host (the cross-talk guard). */
  isMine(input: Record<string, unknown>): boolean;
  /** The session id Zed's add-on would know it by, when it can be the same. */
  sessionId(input: Record<string, unknown>): string | undefined;
  /** Handle the event; return what to print on stdout, if anything. */
  handle(ctx: HookContext): Promise<string | undefined>;
}

/** The most a hook reads from stdin (a prompt can be long; anything bigger is ignored). */
const MAX_INPUT = 4 * 1024 * 1024;

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > MAX_INPUT) return "";
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(
  handler: HookHandler | undefined,
  event: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
  stateDir: string,
  now: number,
): Promise<string | undefined> {
  if (!handler || ownedByZed(env)) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(stdin || "{}");
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (!handler.isMine(record)) return undefined;
  const id = handler.sessionId(record);
  if (id && new ThreadStore(stateDir).get(id)) return undefined;
  return handler.handle({ event, input: record, env, stateDir, now });
}
