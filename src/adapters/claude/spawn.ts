import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const CLAUDE_ADAPTER_PACKAGE = "@agentclientprotocol/claude-agent-acp";

export interface AgentCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface ResolvedAdapter {
  binPath: string;
  version: string;
}

/**
 * Locate the pinned Claude adapter installed as an npm dependency. It is never bundled into Agent Rewake.
 */
export function resolveClaudeAdapter(): ResolvedAdapter {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve(`${CLAUDE_ADAPTER_PACKAGE}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    version: string;
    bin: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["claude-agent-acp"];
  if (!bin) throw new Error(`${CLAUDE_ADAPTER_PACKAGE} has no claude-agent-acp bin`);
  return { binPath: join(dirname(pkgJsonPath), bin), version: pkg.version };
}

/**
 * Environment for the Claude adapter: inherit everything, but blank ANTHROPIC_API_KEY the way Zed
 * does for its own registry Claude agent, so a stray key in the
 * shell doesn't silently switch billing. AGENT_REWAKE_KEEP_API_KEY=1 keeps it.
 */
export function claudeAdapterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.AGENT_REWAKE_KEEP_API_KEY === "1") return { ...env };
  return { ...env, ANTHROPIC_API_KEY: "" };
}

/** The command that runs the adapter with the same Node binary that runs Agent Rewake. */
export function claudeAdapterCommand(extraArgs: string[], env: NodeJS.ProcessEnv): AgentCommand {
  const { binPath } = resolveClaudeAdapter();
  return { command: process.execPath, args: [binPath, ...extraArgs], env: claudeAdapterEnv(env) };
}
