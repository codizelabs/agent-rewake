import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcMessage } from "./acp/ndjson.js";
import { type InFlightRequest, Router, type RouterHooks } from "./acp/router.js";
import type { AgentCommand } from "./adapters/claude/spawn.js";
import { rewake } from "./util/command.js";
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

/**
 * What the person is told, once, if Rewake's own handling fails: their agent isn't affected.
 * No error text: it can hold paths (the log has the error's name only).
 */
export function failOpenNotice(): string {
  return `Rewake hit a problem and switched itself off for now. Your agent is not affected and carries on as normal. Restart Zed to turn it back on; your scheduled messages are kept but won't be sent until then. If this keeps happening: ${rewake("doctor --details")}`;
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
  /**
   * Last resort, for the real process: an uncaught exception or unhandled rejection is treated as a
   * failure of Rewake's own handling (fail open) instead of ending the agent's session. Tests
   * leave it off.
   */
  handleProcessErrors?: boolean;
  /**
   * Fail-safe: Rewake's own handling threw. The router stops calling hooks and only relays, so the
   * agent's session goes on; this is where the add-on stops its timers and releases what it holds.
   */
  onFailOpen?: () => void;
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
      process.off("uncaughtException", onProcessError);
      process.off("unhandledRejection", onProcessError);
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
      // The program's name only: its full path holds the person's user name and folders.
      opts.log.info("agent.spawned", { pid: child.pid, command: basename(opts.agent.command) });
      // A write that reaches an agent that just died fails with EPIPE. Without a listener that
      // error would end Rewake with status 1; the exit handler below reports the agent's own.
      child.stdin.on("error", (err) => {
        opts.log.warn("agent.stdin_error", { code: (err as NodeJS.ErrnoException).code ?? "" });
      });
      child.on("error", (err) => {
        // The code only ("ENOENT"): the message names the agent's path.
        opts.log.error("agent.spawn_failed", {
          code: (err as NodeJS.ErrnoException).code ?? err.name,
        });
        finish(1, "spawn_failed");
      });
      child.on("exit", (code, signal) => {
        opts.log.info("agent.exited", { code: code ?? -1, signal: signal ?? "" });
        if (clientGone || settled || child !== current) return finish(code ?? 1, "agent_exited");
        const now = Date.now();
        while (restarts.length > 0 && now - (restarts[0] ?? 0) > RESTART_WINDOW_MS)
          restarts.shift();
        // Failed open: the add-on is off, so it can't re-attach its sessions to a new agent.
        if (!opts.onAgentRestarted || router.failedOpenNow || restarts.length >= RESTART_LIMIT) {
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
      failOpenNotice: failOpenNotice(),
      onFailOpen: (where, err, first) => {
        // The error's name or code only: its message can hold paths and session ids. Every one is
        // logged, not just the first: once failed open, nothing else would show them.
        opts.log.warn("addon.error", {
          where,
          error: (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? "unknown",
        });
        if (first) opts.onFailOpen?.();
      },
    });
    const onProcessError = (err: unknown) => router.failOpen("process", err);
    if (opts.handleProcessErrors) {
      process.on("uncaughtException", onProcessError);
      process.on("unhandledRejection", onProcessError);
    }
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
      // An agent that ignores SIGTERM (or hangs while cleaning up) must not keep this process,
      // and the thread locks it holds, alive.
      setTimeout(() => {
        if (current.exitCode !== null || current.signalCode !== null) return;
        killTree(current, undefined, "SIGKILL");
        finish(1, "agent_killed");
      }, 5000).unref();
    }
    if (opts.handleSignals)
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
        process.once(signal, () => {
          opts.log.info("proxy.signal", { signal });
          shutDown();
        });
    try {
      opts.setup?.(router);
    } catch (err) {
      router.failOpen("setup", err);
    }
    router.start();
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
