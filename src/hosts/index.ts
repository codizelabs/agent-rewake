import { registerHost } from "../core/store.js";
import { codexAdapter } from "./codex/adapter.js";
import { type CodexHookDeps, codexHooks } from "./codex/hooks.js";
import type { HookHandler } from "./hook.js";
import type { HostAdapter } from "./host.js";

/**
 * The integrations outside Zed that this version ships, by `host` id. Each one is added here when
 * its phase lands (plan §11), with `registerHost` so its records are read.
 */
registerHost("codex");

/** The adapters `fire` uses, built for this run's environment. */
export function hostAdapters(env: NodeJS.ProcessEnv, node: string): Map<string, HostAdapter> {
  return new Map([["codex", codexAdapter({ env, node })]]);
}

/** The hook handler for `agent-rewake hook <host> <event>`. */
export function hookHandler(host: string, deps: CodexHookDeps): HookHandler | undefined {
  if (host === "codex") return codexHooks(deps);
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
