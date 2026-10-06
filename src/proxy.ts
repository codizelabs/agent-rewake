import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcMessage } from "./acp/ndjson.js";
import { type InFlightRequest, Router, type RouterHooks } from "./acp/router.js";
import type { AgentCommand } from "./adapters/claude/spawn.js";
import type { Logger } from "./util/log.js";
import { killTree, resolveCommand } from "./util/spawn.js";
import { VERSION } from "./version.js";

/** Namespaced `_meta` key for Rewake data. */
export const META_WRAPPED = "agent-rewake/wrapped";

/**
 * Pass-through hooks: everything passes through except `initialize`, where Rewake
 * reports its own identity and keeps the wrapped agent's identity under a namespaced key.
 * authMethods and capabilities are never changed.
 */
export function phase1Hooks(): RouterHooks {
  return {
    onAgentResponse(method, _params, response) {
      if (method !== "initialize" || !isObject(response.result)) return undefined;
      const result = response.result;
      const wrapped = result.agentInfo;
      const meta = isObject(result._meta) ? result._meta : {};
      return {
        ...response,
        result: {
          ...result,
          agentInfo: { name: "agent-rewake", title: "Agent Rewake", version: VERSION },
          _meta: { ...meta, [META_WRAPPED]: wrapped ?? null },
        },
      } satisfies JsonRpcMessage;
    },
  };
}

export interface ProxyOptions {
  agent: AgentCommand;
  clientIn: Readable;
  clientOut: Writable;
  log: Logger;
  hooks?: RouterHooks;
  /** Called once with the router, before traffic flows (used by the scheduling add-on). */
  setup?: (router: Router) => void;
  /**
   * Called after the agent process died and a new one replaced it, with the client
   * requests that were waiting. Without it, the add-on exits with the agent like a plain adapter.
   */
  onAgentRestarted?: (inFlight: InFlightRequest[]) => void;
  /** Shut down cleanly on SIGTERM, SIGINT and SIGHUP (the real process; tests leave it off). */
  handleSignals?: boolean;
}

/** At most 3 agent restarts in 10 minutes; after that, exit so Zed shows its normal error. */
const RESTART_LIMIT = 3;
const RESTART_WINDOW_MS = 10 * 60_000;

/**
 * Start the add-on layer: spawn the agent, relay ACP between the client and the agent, and exit
 * when either side goes away. Resolves with the process exit code to use.
 */
export function runProxy(opts: ProxyOptions): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    let clientGone = false;
    const restarts: number[] = [];
    const finish = (code: number, reason: string) => {
      if (settled) return;
      settled = true;
      opts.log.info("proxy.exit", { code, reason });
      resolve(code);
    };

    const spawnAgent = () => {
      const run = resolveCommand(opts.agent.command, opts.agent.args, opts.agent.env);
      const child = spawn(run.command, run.args, {
        env: opts.agent.env,
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
        ...(run.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
      });
      opts.log.info("agent.spawned", { pid: child.pid, command: opts.agent.command });
      child.on("error", (err) => {
        opts.log.error("agent.spawn_failed", { message: err.message });
        finish(1, "spawn_failed");
      });
      child.on("exit", (code, signal) => {
        opts.log.info("agent.exited", { code: code ?? -1, signal: signal ?? "" });
        if (clientGone || settled || child !== current) return finish(code ?? 1, "agent_exited");
        const now = Date.now();
        while (restarts.length > 0 && now - (restarts[0] ?? 0) > RESTART_WINDOW_MS)
          restarts.shift();
        if (!opts.onAgentRestarted || restarts.length >= RESTART_LIMIT) {
          return finish(code ?? 1, "agent_exited");
        }
        restarts.push(now);
        current = spawnAgent();
        const inFlight = router.replaceAgent(current.stdout, current.stdin);
        opts.log.warn("agent.restarted", { attempt: restarts.length, inFlight: inFlight.length });
        opts.onAgentRestarted(inFlight);
      });
      return child;
    };

    let current = spawnAgent();
    const router = new Router({
      clientIn: opts.clientIn,
      clientOut: opts.clientOut,
      agentIn: current.stdout,
      agentOut: current.stdin,
      ...(opts.hooks && { hooks: opts.hooks }),
      onTraffic: (e) => {
        if (e.kind === "invalid") opts.log.warn("acp.invalid_line", { direction: e.direction });
      },
      onClientEnd: () => shutDown(),
    });
    // The client closed stdin, or this process was asked to stop: end the agent's stdin (agents
    // exit on EOF), and stop it and anything it started if it's still running 2 s later. Zed itself
    // stops agent servers with SIGKILL or a Windows job, so this
    // covers terminals and other clients; state is written crash-safe either way.
    function shutDown() {
      if (clientGone) return;
      clientGone = true;
      current.stdin.end();
      setTimeout(() => {
        if (current.exitCode === null) killTree(current);
      }, 2000).unref();
    }
    if (opts.handleSignals)
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
        process.once(signal, () => {
          opts.log.info("proxy.signal", { signal });
          shutDown();
        });
    opts.setup?.(router);
    router.start();
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
