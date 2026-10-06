import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentCommand,
  claudeAdapterCommand,
  resolveClaudeAdapter,
} from "./adapters/claude/spawn.js";
import { SchedulingAddon } from "./addon.js";
import { applySettings } from "./core/settings.js";
import { TEXT_LOCALE } from "./core/time.js";
import {
  keyChord,
  launchCommand,
  missingLaunchFiles,
  quitZed,
  runInstall,
  selfCommand,
  TASK_LABEL,
  taskEntry,
  wrappedAgentIds,
  wrappedEntry,
  zedConfigDir,
} from "./install.js";
import { runMcp } from "./mcp.js";
import { runProxy } from "./proxy.js";
import { overview, overviewText } from "./ui/overview.js";
import { runTui } from "./ui/tui.js";
import { Logger } from "./util/log.js";
import { ensurePrivateDir, stateDir, zedDataDir } from "./util/paths.js";
import { resolveCommand } from "./util/spawn.js";
import { VERSION } from "./version.js";
import {
  CLAUDE_REGISTRY_ID,
  parseWrapArgs,
  registryAgent,
  type WrapTarget,
  wrappedAgentCommand,
} from "./wrap.js";

/** Zed's id and the display name of the wrapped agent, for the schedules page. */
function agentIdentity(
  target: WrapTarget | undefined,
  env: NodeJS.ProcessEnv,
): { agentId?: string; agentName?: string } {
  if (!target) return {};
  const id = target.kind === "registry" ? target.id : target.id;
  if (!id) return {};
  const name = registryAgent(id, env)?.name;
  return { agentId: id, ...(name && { agentName: name }) };
}

const USAGE = `agent-rewake ${VERSION}

Usage:
  agent-rewake --wrap-registry <id>   Run in front of a registry agent, e.g. claude-acp, codex-acp (Zed launches this)
  agent-rewake --wrap-command <json> Run in front of a custom agent: {"command": "...", "args": [...]}
  agent-rewake                     Run in front of the Claude adapter
  agent-rewake -- <cmd> [args...]  Run in front of another ACP agent command
  agent-rewake doctor              Check the installation (no network access)
  agent-rewake ui [--inline] [--thread <id>]
                                   Schedules page: a table you can click, for every thread
                                   (Zed's terminal panel; --inline draws it inside a thread)
  agent-rewake schedules [--all] [--json]   List scheduled messages
  agent-rewake install [--yes] [--keybinding] [--dry-run] [--agent <id>]...
                                   Add Rewake to the agents you already use in Zed, keeping
                                   their threads (shows the changes and asks first)
  agent-rewake uninstall [--yes] [--dry-run]
                                   Take Rewake out of your agents and remove its Zed entries
  agent-rewake setup zed           Print the Zed settings, task and keybinding (to add by hand)
  agent-rewake --version
  agent-rewake --help

In add-on mode, stdout carries the Agent Client Protocol: nothing else is printed there.`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const wrap = parseWrapArgs(argv);
  if (wrap && "error" in wrap) {
    process.stderr.write(`agent-rewake: ${wrap.error}\n`);
    return 2;
  }

  // Terminal-auth relaunch: the client re-runs our command with the adapter's
  // `--cli …` args. Hand straight to the adapter with inherited stdio; Rewake never sees the login.
  // (In wrap mode the same happens further down, for whichever agent is wrapped.)
  if (!wrap && argv.includes("--cli")) {
    return runInTerminal(claudeAdapterCommand(argv, env));
  }

  // The clock (and later settings) apply to everything this process prints.
  applySettings(stateDir(env));

  const [first] = argv;
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (first === "--help" || first === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (first === "mcp")
    // The agent's tool server, started by the agent. stdout carries MCP.
    return runMcp({ stateDir: stateDir(env), link: env.AGENT_REWAKE_LINK });
  if (first === "doctor") return doctor(env);
  if (first === "ui") {
    const t = argv.indexOf("--thread");
    const threadId = t !== -1 ? argv[t + 1] : undefined;
    return runTui(stateDir(env), {
      inline: argv.includes("--inline"),
      ...(threadId && { threadId }),
      env,
    });
  }
  if (first === "schedules") {
    const groups = overview(stateDir(env), argv.includes("--all"));
    process.stdout.write(
      argv.includes("--json")
        ? `${JSON.stringify(groups, null, 2)}\n`
        : `${overviewText(groups, Date.now())}\n`,
    );
    return 0;
  }
  if (first === "install" || first === "uninstall") {
    const known = new Set(["--yes", "-y", "--dry-run", "--keybinding"]);
    const only: string[] = [];
    const unknown: string[] = [];
    const rest = argv.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] ?? "";
      if (a === "--agent" && first === "install" && rest[i + 1]) only.push(rest[++i] ?? "");
      else if (!known.has(a) || (first === "uninstall" && a === "--keybinding")) unknown.push(a);
    }
    if (unknown.length > 0) {
      process.stderr.write(`agent-rewake: unknown option for ${first}: ${unknown.join(" ")}\n`);
      return 2;
    }
    return runInstall({
      uninstall: first === "uninstall",
      ...(only.length > 0 && { only }),
      yes: argv.includes("--yes") || argv.includes("-y"),
      dryRun: argv.includes("--dry-run"),
      keybinding: argv.includes("--keybinding"),
      env,
    });
  }
  if (first === "setup") {
    if (argv[1] !== "zed") {
      process.stderr.write("agent-rewake: usage: agent-rewake setup zed\n");
      return 2;
    }
    process.stdout.write(setupZedText());
    return 0;
  }

  const log = new Logger(env);
  let agent: AgentCommand;
  const sep = argv.indexOf("--");
  if (wrap) {
    try {
      const npmLog = join(ensurePrivateDir(join(stateDir(env), "logs")), "npm-install.log");
      agent = await wrappedAgentCommand(wrap.target, wrap.extra, env, stateDir(env), npmLog);
    } catch (err) {
      log.error("agent.resolve_failed", { message: (err as Error).message });
      process.stderr.write(`agent-rewake: ${(err as Error).message}\n`);
      return 1;
    }
    if (wrap.extra.length > 0) {
      // Zed appended arguments: hand the terminal to
      // the agent; Rewake never sees the login.
      return runInTerminal(agent);
    }
  } else if (sep !== -1) {
    const [command, ...args] = argv.slice(sep + 1);
    if (!command) {
      process.stderr.write("agent-rewake: missing agent command after --\n");
      return 2;
    }
    agent = { command, args, env: { ...env } };
  } else if (argv.length === 0) {
    agent = claudeAdapterCommand([], env);
  } else {
    process.stderr.write(`agent-rewake: unknown arguments: ${argv.join(" ")}\n${USAGE}\n`);
    return 2;
  }

  log.info("proxy.start", {
    version: VERSION,
    node: process.versions.node,
    agent: wrap?.target.kind === "registry" ? wrap.target.id : (wrap?.target.id ?? "default"),
  });
  const addon = new SchedulingAddon({
    stateDir: stateDir(env),
    log,
    titleMarkers: env.AGENT_REWAKE_TITLE_MARKERS === "1",
    selfCommand: selfCommand(),
    agentTools: env.AGENT_REWAKE_AGENT_TOOLS !== "0",
    ...agentIdentity(wrap?.target, env),
    env,
    allowAutomaticResume: env.AGENT_REWAKE_ALLOW_AUTO !== "0",
  });
  const code = await runProxy({
    agent,
    clientIn: process.stdin,
    clientOut: process.stdout,
    log,
    hooks: addon.hooks(),
    setup: (router) => addon.attach(router),
    onAgentRestarted: (inFlight) => void addon.onAgentRestarted(inFlight),
    handleSignals: true,
  });
  addon.stop();
  return code;
}

function doctor(env: NodeJS.ProcessEnv): number {
  const lines: string[] = [`agent-rewake ${VERSION}`];
  let ok = true;
  const major = Number(process.versions.node.split(".")[0]);
  lines.push(
    `Node.js ${process.versions.node} ${major >= 22 ? "ok" : "too old: Node 22 or newer is required"}`,
  );
  if (major < 22) ok = false;
  try {
    const a = resolveClaudeAdapter();
    lines.push(`Claude adapter @agentclientprotocol/claude-agent-acp ${a.version} at ${a.binPath}`);
  } catch (err) {
    ok = false;
    lines.push(`Claude adapter not found: ${(err as Error).message}`);
  }
  lines.push(`System: ${process.platform} ${process.arch}`);
  lines.push(`State directory: ${stateDir(env)}`);
  lines.push(`Zed settings directory: ${zedConfigDir(env)}`);
  lines.push(`Zed data directory: ${zedDataDir(env)}`);
  const wrapped = wrappedAgentIds(zedConfigDir(env));
  for (const m of missingLaunchFiles(zedConfigDir(env))) {
    ok = false;
    lines.push(
      `${m.id}: Zed would start Rewake with ${m.path}, which no longer exists (Node was upgraded or moved?). Run \`agent-rewake install\` again to update it.`,
    );
  }
  lines.push(
    wrapped.length > 0
      ? `Zed agents with Rewake: ${wrapped.join(", ")}`
      : "Zed agents with Rewake: none yet. Run `agent-rewake install`.",
  );
  const started = lastStart(stateDir(env));
  if (started)
    lines.push(
      `Zed last started Rewake: ${new Date(started.at).toLocaleString(TEXT_LOCALE)} (${started.agent})`,
    );
  else if (wrapped.length > 0)
    lines.push(
      `Zed hasn't started Rewake yet. To start it, ${quitZed()}, open it again, then open a thread.`,
    );
  for (const id of toolsRefused(stateDir(env))) {
    const name = registryAgent(id, env)?.name ?? id;
    lines.push(
      `${name} didn't accept Rewake's tools, so it can't suggest schedules. The Rewake menu and /schedule still work; there's nothing to fix.`,
    );
  }
  lines.push(
    env.AGENT_REWAKE_KEEP_API_KEY === "1"
      ? "ANTHROPIC_API_KEY: passed through to the adapter (AGENT_REWAKE_KEEP_API_KEY=1)"
      : "ANTHROPIC_API_KEY: blanked for the adapter, so Claude uses your signed-in account",
  );
  process.stdout.write(
    `${lines.join("\n")}\n${ok ? "All checks passed." : "Some checks failed."}\n`,
  );
  return ok ? 0 : 1;
}

/** Agents that refused Rewake's tool server, from the logs. */
function toolsRefused(state: string): string[] {
  const dir = join(state, "logs");
  const agents = new Set<string>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^rewake-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.includes("agent_tools.refused")) continue;
      try {
        const r = JSON.parse(line) as { event?: string; agent?: string };
        if (r.event === "agent_tools.refused") agents.add(r.agent ?? "an agent");
      } catch {
        // a partial line: skip it
      }
    }
  }
  return [...agents].sort();
}

/** The most recent time a Zed agent connection started Rewake, from the metadata-only logs. */
function lastStart(state: string): { at: number; agent: string } | undefined {
  const dir = join(state, "logs");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => /^rewake-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse();
  } catch {
    return undefined;
  }
  for (const f of files) {
    const lines = readFileSync(join(dir, f), "utf8").trim().split("\n").reverse();
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as { t?: string; event?: string; agent?: string };
        if (r.event === "proxy.start" && r.t)
          return { at: Date.parse(r.t), agent: r.agent ?? "agent" };
      } catch {
        // A torn or foreign line: skipped.
      }
    }
  }
  return undefined;
}

/**
 * The exact Zed configuration for this installation, for people who prefer to
 * edit Zed's files by hand. `agent-rewake install` writes the same entries.
 */
function setupZedText(): string {
  const launch = launchCommand();
  const agent = {
    agent_servers: {
      [CLAUDE_REGISTRY_ID]: wrappedEntry({}, { kind: "registry", id: CLAUDE_REGISTRY_ID }, launch),
    },
  };
  const task = [taskEntry(launch)];
  const keymap = [{ bindings: { [keyChord()]: ["task::Spawn", { task_name: TASK_LABEL }] } }];
  const dir = zedConfigDir();
  const file = (name: string) => join(dir, name);
  return [
    "Easiest: run `agent-rewake install`, which adds these for you after asking.",
    "To add them by hand instead:",
    "",
    `1. ${file("settings.json")}: put Rewake in front of an agent you already use, under the`,
    "   agent's own id so its threads stay. For Claude Agent (keep any other keys you have there):",
    JSON.stringify(agent, null, 2),
    "",
    `2. ${file("tasks.json")}: the schedules page as a task (open it with "task: spawn"):`,
    JSON.stringify(task, null, 2),
    "",
    `3. ${file("keymap.json")}: optional keybinding for the schedules page:`,
    JSON.stringify(keymap, null, 2),
    "",
    'For another registry agent use "--wrap-registry", "<its id>"; for a custom agent,',
    '"--wrap-command", "{\\"command\\": …, \\"args\\": […]}" with its original command.',
    'Then open any thread with that agent and use the "Rewake" menu under the message box.',
    "",
  ].join("\n");
}

/** Run a command with this terminal, on any OS (Windows .cmd shims included). */
function runInTerminal(cmd: AgentCommand): number {
  const run = resolveCommand(cmd.command, cmd.args, cmd.env);
  const r = spawnSync(run.command, run.args, {
    env: cmd.env,
    stdio: "inherit",
    ...(run.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
  });
  return r.status ?? 1;
}
