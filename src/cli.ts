import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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
  agentPanelKey,
  keyChord,
  launchCommand,
  missingLaunchFiles,
  quitZed,
  runInstall,
  selfCommand,
  TASK_LABEL,
  taskEntry,
  wrappedEntry,
  zedConfigDir,
} from "./install.js";
import { runMcp } from "./mcp.js";
import { runProxy } from "./proxy.js";
import { agentName, detectSetup } from "./setup.js";
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
  agent-rewake doctor [--details]  Check whether Rewake can work in your Zed (no network access)
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
  if (first === "doctor") return doctor(env, argv.includes("--details"));
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

/**
 * `agent-rewake doctor`: whether Rewake can work for this person, in plain words. The default output
 * names no files, folders, accounts or keys, so it can be pasted anywhere; `--details` adds versions
 * and folders (home shortened to ~) for bug reports. Exit status 1 only when something is broken.
 */
function doctor(env: NodeJS.ProcessEnv, details: boolean): number {
  const zedDir = zedConfigDir(env);
  const setup = detectSetup(zedDir, stateDir(env));
  const lines: string[] = [`Agent Rewake ${VERSION}`, ""];
  const problems: string[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22)
    problems.push(
      `Node.js ${process.versions.node} is too old: Rewake needs Node.js 22 or newer (nodejs.org).`,
    );
  let adapter: { version: string; binPath: string } | undefined;
  try {
    adapter = resolveClaudeAdapter();
  } catch {
    problems.push(
      "Rewake's copy of the Claude adapter is missing. Run the install command again: npx @codizelabs/agent-rewake install",
    );
  }
  if (setup.settings === "invalid")
    problems.push(
      "Zed's settings file has a mistake in it, so Rewake can't read it. Open it in Zed (command palette: zed: open settings file), fix the highlighted part, then run doctor again.",
    );
  if (missingLaunchFiles(zedDir).length > 0)
    problems.push(
      "Zed would start Rewake from a Node.js that has moved or been upgraded. Run the install command again to update it: npx @codizelabs/agent-rewake install",
    );

  const names = (ids: string[]) => ids.map((id) => agentName(id, env)).join(", ");
  const panel = `Zed's Agent Panel (${agentPanelKey()})`;
  let status: string;
  if (setup.aiOff || setup.agentOff) {
    lines.push(
      setup.aiOff
        ? "Zed's AI features are turned off (disable_ai in Zed's settings), so the Agent Panel and Rewake can't run."
        : "Zed's agent is turned off (agent.enabled in Zed's settings), so the Agent Panel and Rewake can't run.",
      "Turn them back on in Zed's settings to use Rewake.",
    );
    status = "Not running: Zed's AI features are off.";
  } else if (setup.withRewake.length === 0) {
    lines.push(
      setup.agents.length > 0
        ? `Rewake isn't added to your agents yet (${names(setup.agents)}).`
        : "Rewake isn't set up yet, and Zed has no external agents (such as Claude Agent).",
      "To set it up: npx @codizelabs/agent-rewake install",
    );
    status = "Not set up yet.";
  } else if (setup.lastStart) {
    const who =
      setup.lastStart.agent === "default" ? "Claude Agent" : agentName(setup.lastStart.agent, env);
    lines.push(
      `Rewake is on for: ${names(setup.withRewake)}.`,
      `Working: Zed last started it ${new Date(setup.lastStart.at).toLocaleString(TEXT_LOCALE)}, for ${who}.`,
    );
    status = "Everything looks right.";
  } else {
    lines.push(
      `Rewake is on for: ${names(setup.withRewake)}.`,
      `Not used yet. Zed starts Rewake when you open or start a thread with ${setup.withRewake.length === 1 ? names(setup.withRewake) : "one of these agents"} in ${panel}. Restarting Zed alone doesn't start it.`,
      `If it still doesn't start: ${quitZed()}, open it again, then start a new thread with that agent.`,
    );
    status = "Installed, not used yet.";
  }
  if (!setup.lastStart && !setup.aiOff && !setup.agentOff)
    lines.push(
      "",
      `Where Rewake works: in ${panel}, with external agents such as Claude Agent, Codex and Gemini CLI.`,
      `It can't reach Zed's own agent${setup.usesZedAgent ? " (the one your settings pick a model for)" : ""}: Zed doesn't let add-ons into it. To have threads resume after a limit, start them with Claude Agent in the same panel.`,
      "It also can't reach Claude outside Zed's Agent Panel: Claude Code in a terminal and the Claude desktop app each have their own setting to continue after a usage limit.",
    );
  for (const id of toolsRefused(stateDir(env)))
    lines.push(
      "",
      `${agentName(id, env)} didn't accept Rewake's tools, so it can't suggest schedules. The Rewake menu and /schedule still work; there's nothing to fix.`,
    );
  if (problems.length > 0) lines.push("", "Needs fixing:", ...problems.map((p) => `  - ${p}`));
  if (details) {
    const home = homedir();
    const tilde = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
    lines.push(
      "",
      "Details (for bug reports):",
      `  Node.js ${process.versions.node}, ${process.platform} ${process.arch}`,
      `  Claude adapter: ${adapter ? adapter.version : "not found"}`,
      `  Zed settings folder: ${tilde(zedDir)}`,
      `  Zed data folder: ${tilde(zedDataDir(env))}`,
      `  Rewake's folder: ${tilde(stateDir(env))}`,
      `  Agents in Zed's settings: ${setup.agents.join(", ") || "none"}; with Rewake: ${setup.withRewake.join(", ") || "none"}`,
    );
    if (env.ANTHROPIC_API_KEY)
      lines.push(
        env.AGENT_REWAKE_KEEP_API_KEY === "1"
          ? "  Anthropic API key in this terminal: passed on to Claude Agent (AGENT_REWAKE_KEEP_API_KEY=1)."
          : "  Anthropic API key in this terminal: not passed on, so Claude Agent keeps using your Claude sign-in, as Zed does.",
      );
  }
  lines.push("", problems.length > 0 ? "Something needs fixing: see above." : status);
  if (!details) lines.push("More detail for a bug report: agent-rewake doctor --details");
  process.stdout.write(`${lines.join("\n")}\n`);
  return problems.length > 0 ? 1 : 0;
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
