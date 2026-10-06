import type { HostAdapter } from "./host.js";

/**
 * The integrations outside Zed that this version ships, by `host` id. Each one is added here when
 * its phase lands (plan §11), together with `registerHost` so its records are read.
 */
export const HOSTS: ReadonlyMap<string, HostAdapter> = new Map();

/**
 * Set in the environment of every agent the Zed add-on starts. A hook Rewake installed for the
 * same agent's own CLI sees it and stands down, so one session never has two owners (plan §3.5).
 */
export const OWNER_ENV = "AGENT_REWAKE_OWNER";

/** The session belongs to the Zed add-on (the agent was started by it). */
export function ownedByZed(env: NodeJS.ProcessEnv): boolean {
  return env[OWNER_ENV] === "acp";
}
