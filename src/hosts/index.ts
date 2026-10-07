import { homedir } from "node:os";
import { registerHost } from "../core/store.js";
import { ANTIGRAVITY_ID, antigravityHooks, antigravityHost } from "./antigravity/host.js";
import { type ClosedDeps, type ClosedHost, closedAdapter } from "./closed.js";
import { codexAdapter } from "./codex/adapter.js";
import { type CodexHookDeps, codexHooks } from "./codex/hooks.js";
import { COPILOT_ID, copilotHooks, copilotHost } from "./copilot/host.js";
import { GEMINI_ID, geminiHooks, geminiHost } from "./gemini/host.js";
import { geminiApiKeyAuth } from "./gemini/install.js";
import { GROK_ID, grokHooks, grokHost } from "./grok/host.js";
import type { HookContext, HookHandler } from "./hook.js";
import type { HostAdapter } from "./host.js";

/**
 * The integrations outside Zed that this version ships, by `host` id. Each one is added here when
 * its phase lands (plan §11), with `registerHost` so its records are read.
 */
registerHost("codex");
registerHost(COPILOT_ID);
registerHost(GROK_ID);
registerHost(GEMINI_ID);
registerHost(ANTIGRAVITY_ID);

/** The hosts whose closed sessions Rewake continues (`agent-rewake continue`). */
export const CLOSED_HOSTS: ClosedHost[] = [
  copilotHost,
  grokHost(process.env),
  geminiHost,
  antigravityHost(),
];

/** The adapters `fire` uses, built for this run's environment. */
export function hostAdapters(
  env: NodeJS.ProcessEnv,
  node: string,
  stateDir: string,
): Map<string, HostAdapter> {
  return new Map<string, HostAdapter>([
    ["codex", codexAdapter({ env, node })],
    ...CLOSED_HOSTS.map((h) => [h.id, closedAdapter(h, stateDir, env)] as const),
  ]);
}

export interface HookDeps extends CodexHookDeps {
  /** What the closed-session hosts' hooks need, for this event. */
  closed: (ctx: HookContext) => ClosedDeps;
  /** The agent's program on the session's own PATH. */
  program: (host: string, env: NodeJS.ProcessEnv) => string | undefined;
}

/** The hook handler for `agent-rewake hook <host> <event>`. */
export function hookHandler(host: string, deps: HookDeps): HookHandler | undefined {
  if (host === "codex") return codexHooks(deps);
  if (host === COPILOT_ID)
    return copilotHooks({ closed: deps.closed, program: (env) => deps.program(host, env) });
  if (host === GROK_ID)
    return grokHooks({ closed: deps.closed, program: (env) => deps.program(host, env) });
  if (host === GEMINI_ID)
    return geminiHooks({
      closed: deps.closed,
      program: (env) => deps.program(host, env),
      apiKey: (env) => geminiApiKeyAuth(env, env.HOME || env.USERPROFILE || homedir()),
    });
  if (host === ANTIGRAVITY_ID)
    return antigravityHooks({ closed: deps.closed, program: (env) => deps.program(host, env) });
  return undefined;
}

/**
 * Set in the environment of every agent the Zed add-on starts. A hook Rewake installed for the
 * same agent's own CLI sees it and stands down, so one session never has two owners (plan §3.5).
 */
export const OWNER_ENV = "AGENT_REWAKE_OWNER";

/** The session belongs to the Zed add-on (the agent was started by it). */
export function ownedByZed(env: NodeJS.ProcessEnv): boolean {
  return env[OWNER_ENV] === "acp";
}
