import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type AgentCommand, claudeAdapterCommand } from "./adapters/claude/spawn.js";
import { SchedulingAddon } from "./addon.js";
import { runContinue } from "./continue.js";
import { applySettings, loadSettings } from "./core/settings.js";
import { ScheduleStore, TERMINAL_STATUSES } from "./core/store.js";
import { type DoctorContext, detailLines, diagnose, findZedApps, render } from "./doctor.js";
import { runAntigravityInstall } from "./hosts/antigravity/install.js";
import { runClaudeInstall } from "./hosts/claude-code/install.js";
import { type ClosedDeps, reapClosed } from "./hosts/closed.js";
import { runCodexInstall } from "./hosts/codex/install.js";
import { runCopilotInstall } from "./hosts/copilot/install.js";
import { runGeminiInstall } from "./hosts/gemini/install.js";
import { runGrokInstall } from "./hosts/grok/install.js";
import { readStdin, runHook } from "./hosts/hook.js";
import { CLOSED_HOSTS, hookHandler, hostAdapters, OWNER_ENV } from "./hosts/index.js";
import { installedPreviews, PREVIEW_NAMES } from "./hosts/previews.js";
import {
  agyPrograms,
  codexPrograms,
  compareVersions,
  copilotPrograms,
  detectAgents,
  geminiPrograms,
  grokPrograms,
} from "./install/detect.js";
import {
  keyChord,
  launchCommand,
  runInstall,
  selfCommand,
  stableNode,
  TASK_LABEL,
  taskEntry,
  wrappedEntry,
  zedConfigDir,
} from "./install.js";
import { runMcp } from "./mcp.js";
import { runProxy } from "./proxy.js";
import { agentName } from "./setup.js";
import { fire } from "./timers/fire.js";
import { ensureLauncher, launcherPath, refreshLauncher } from "./timers/launcher.js";
import { osNotifier } from "./timers/notify.js";
import { type SweepDeps, scheduleFire, sweep } from "./timers/sweep.js";
import { cancelTimer, defaultTimerHost, parseTimerName } from "./timers/timers.js";
import { overview, overviewText } from "./ui/overview.js";
import { runTui } from "./ui/tui.js";
import { Wakefulness } from "./util/keep-awake.js";
import { Logger } from "./util/log.js";
import { ensurePrivateDir, stateDir } from "./util/paths.js";
import { agentProcess } from "./util/proc.js";
import { readSleepSettings } from "./util/sleep-settings.js";
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

/** Places `install --only` takes: Zed (the default) and the previews being tested. */
const INSTALL_PLACES = new Set([
  "zed",
  "claude-code",
  "codex",
  "copilot-cli",
  "grok",
  "gemini-cli",
  "antigravity",
]);

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
  agent-rewake continue [--always | --ask | --cancel]
                                   Continue a closed agent session after its usage limit resets.
                                   --always: continue sessions by itself from now on.
                                   --ask: go back to asking each time.
                                   --cancel: cancel every planned resume.
  agent-rewake fire <id>           Run by Rewake's timers at a resume's time (safe to run any time)
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
  // A newer Rewake keeps the copy that hooks and timers run current (plan §3.6).
  if (process.argv[1]) refreshLauncher(stateDir(env), process.argv[1], VERSION);

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
  if (first === "doctor") {
    sweepQuietly(env);
    return doctor(env, argv.includes("--details"));
  }
  if (first === "ui") {
    sweepQuietly(env);
    const t = argv.indexOf("--thread");
    const threadId = t !== -1 ? argv[t + 1] : undefined;
    const { timers, sweepDeps, state, node } = timerDeps(env);
    const hosts = hostAdapters(env, node, state);
    return runTui(stateDir(env), {
      inline: argv.includes("--inline"),
      ...(threadId && { threadId }),
      env,
      hostName: (h) => hosts.get(h)?.name,
      // A resume outside Zed changed on the page: its OS timer follows.
      onHostChange: (id) => {
        const s = new ScheduleStore(state).get(id);
        if (s?.status === "scheduled") scheduleFire(id, s.dueAt, sweepDeps(Date.now()));
        else cancelTimer(id, timers);
      },
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
    const places: string[] = [];
    const unknown: string[] = [];
    const rest = argv.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] ?? "";
      if (a === "--agent" && first === "install" && rest[i + 1]) only.push(rest[++i] ?? "");
      else if (a === "--only" && rest[i + 1])
        places.push(
          ...(rest[++i] ?? "")
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
        );
      else if (!known.has(a) || (first === "uninstall" && a === "--keybinding")) unknown.push(a);
    }
    if (unknown.length > 0) {
      process.stderr.write(`agent-rewake: unknown option for ${first}: ${unknown.join(" ")}\n`);
      return 2;
    }
    const chosen = places.length > 0 ? [...new Set(places)] : ["zed"];
    const bad = chosen.filter((p) => !INSTALL_PLACES.has(p));
    if (bad.length > 0) {
      process.stderr.write(
        `agent-rewake: ${bad.join(", ")}: not a place Rewake can ${first === "install" ? "install into" : "remove from"}. Choose from: ${[...INSTALL_PLACES].join(", ")}.\n`,
      );
      return 2;
    }
    const yes = argv.includes("--yes") || argv.includes("-y");
    const dryRun = argv.includes("--dry-run");
    let code = 0;
    if (chosen.includes("zed"))
      code = Math.max(
        code,
        await runInstall({
          uninstall: first === "uninstall",
          ...(only.length > 0 && { only }),
          yes,
          dryRun,
          keybinding: argv.includes("--keybinding"),
          env,
        }),
      );
    const ask = async (q: string) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(q)).trim());
      } finally {
        rl.close();
      }
    };
    if (chosen.includes("claude-code"))
      code = Math.max(
        code,
        await runClaudeInstall({
          uninstall: first === "uninstall",
          yes,
          dryRun,
          env,
          stateDir: stateDir(env),
          node: stableNode(),
          bundle: process.argv[1] ?? "",
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          out: (t) => process.stdout.write(t),
          ask,
        }),
      );
    if (chosen.includes("codex"))
      code = Math.max(
        code,
        await runCodexInstall({
          uninstall: first === "uninstall",
          yes,
          dryRun,
          env,
          stateDir: stateDir(env),
          node: stableNode(),
          bundle: process.argv[1] ?? "",
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          out: (t) => process.stdout.write(t),
          ask,
        }),
      );
    if (chosen.includes("copilot-cli"))
      code = Math.max(
        code,
        await runCopilotInstall({
          uninstall: first === "uninstall",
          yes,
          dryRun,
          env,
          stateDir: stateDir(env),
          node: stableNode(),
          bundle: process.argv[1] ?? "",
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          out: (t) => process.stdout.write(t),
          ask: async (q) => /^y(es)?$/i.test((await prompt(q)).trim()),
        }),
      );
    if (chosen.includes("grok"))
      code = Math.max(
        code,
        await runGrokInstall({
          uninstall: first === "uninstall",
          yes,
          dryRun,
          env,
          stateDir: stateDir(env),
          node: stableNode(),
          bundle: process.argv[1] ?? "",
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          out: (t) => process.stdout.write(t),
          ask: async (q) => /^y(es)?$/i.test((await prompt(q)).trim()),
        }),
      );
    const common = {
      uninstall: first === "uninstall",
      yes,
      dryRun,
      env,
      stateDir: stateDir(env),
      node: stableNode(),
      bundle: process.argv[1] ?? "",
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      out: (t: string) => process.stdout.write(t),
      ask: async (q: string) => /^y(es)?$/i.test((await prompt(q)).trim()),
    };
    if (chosen.includes("gemini-cli")) code = Math.max(code, await runGeminiInstall(common));
    if (chosen.includes("antigravity")) code = Math.max(code, await runAntigravityInstall(common));
    if (first === "uninstall" && !dryRun) cancelResumesOf(chosen, env);
    if (!dryRun) sweepQuietly(env);
    return code;
  }
  if (first === "continue") {
    const flag = argv[1];
    const mode =
      flag === "--always"
        ? "always"
        : flag === "--ask"
          ? "ask"
          : flag === "--cancel"
            ? "cancel"
            : undefined;
    if (flag !== undefined && mode === undefined) {
      process.stderr.write(
        "agent-rewake: usage: agent-rewake continue [--always | --ask | --cancel]\n",
      );
      return 2;
    }
    return runContinueCommand(env, mode);
  }
  if (first === "fire") return runFire(argv[1] ?? "", env);
  if (first === "hook") return runHookCommand(argv[1] ?? "", argv[2] ?? "", env);
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
      log.error("agent.resolve_failed", {
        agent: wrap.target.kind === "registry" ? wrap.target.id : (wrap.target.id ?? "custom"),
        message: (err as Error).message,
      });
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

  // Hooks Rewake installed for this agent's own CLI stand down in sessions Zed runs (plan §3.5).
  agent = { ...agent, env: { ...agent.env, [OWNER_ENV]: "acp" } };
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

/** `agent-rewake doctor [--details]`: see src/doctor.ts. Exit status 1 when something is broken. */
function doctor(env: NodeJS.ProcessEnv, details: boolean): number {
  const ctx: DoctorContext = {
    env,
    now: Date.now(),
    platform: process.platform,
    home: homedir(),
    zedApps: () => findZedApps(process.platform, homedir(), env),
    agents: () => {
      const ids = new Set(installedPreviews(env, homedir(), stateDir(env)));
      return detectAgents({ env, home: homedir(), platform: process.platform }).filter(
        (f) => !ids.has(f.id),
      );
    },
    previews: () => previewNames(env),
    sleep: () => {
      const keepAwake = loadSettings(stateDir(env)).keepAwake;
      return {
        settings: readSleepSettings({ env }),
        hold: new Wakefulness().supported && keepAwake !== "never" ? keepAwake : "none",
      };
    },
    launch: launchCommand(),
    version: VERSION,
    nodeVersion: process.versions.node,
  };
  const findings = diagnose(ctx);
  for (const id of toolsRefused(stateDir(env)))
    findings.push({
      area: "Recently",
      level: "info",
      text: `${agentName(id, env)} didn't accept Rewake's tools, so it can't suggest schedules. The Rewake menu and /schedule still work.`,
    });
  const ascii = (process.platform === "win32" && !env.WT_SESSION) || env.TERM === "dumb";
  process.stdout.write(
    render(findings, { version: VERSION, ascii, ...(details && { details: detailLines(ctx) }) }),
  );
  return findings.some((f) => f.level === "problem") ? 1 : 0;
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

/** The Rewake that timers and detached runs start: the stable copy, made now if it's missing. */
function rewakeCli(state: string): string {
  const stable = launcherPath(state);
  if (existsSync(stable)) return stable;
  const bundle = process.argv[1] ?? "";
  return (bundle && ensureLauncher(state, bundle)) || bundle || stable;
}

/**
 * After `uninstall --only <agents>`: their planned resumes are cancelled and their timers removed,
 * so nothing continues a session in an agent Rewake was taken out of. Only if Rewake really is out
 * (the agent's hooks or plugin are gone); a declined or failed uninstall leaves them.
 */
function cancelResumesOf(places: string[], env: NodeJS.ProcessEnv): void {
  const { state, timers } = timerDeps(env);
  const still = new Set<string>(installedPreviews(env, homedir(), state));
  // Place ids and host ids are the same words ("codex", "copilot-cli", "grok", …).
  const gone = places.filter((p) => p !== "zed" && !still.has(p));
  if (gone.length === 0) return;
  const store = new ScheduleStore(state);
  const hosts = hostAdapters(env, stableNode(), state);
  for (const place of gone) {
    let n = 0;
    for (const s of store.list()) {
      if (s.host !== place || TERMINAL_STATUSES.has(s.status)) continue;
      store.update(s.scheduleId, (x) => ({ ...x, status: "cancelled" }), Date.now());
      cancelTimer(s.scheduleId, timers);
      n++;
    }
    const name = hosts.get(place)?.name ?? place;
    if (n > 0)
      process.stdout.write(
        `Also cancelled ${n === 1 ? "1 resume message" : `${n} resume messages`} for ${name} sessions.\n`,
      );
  }
}

/** Re-arm lost timers and start due resumes (plan §5); never fails the command running it. */
function sweepQuietly(env: NodeJS.ProcessEnv): void {
  try {
    const { sweepDeps } = timerDeps(env);
    sweep(sweepDeps(Date.now()));
    reapClosed(CLOSED_HOSTS, closedDeps(env, Date.now()));
  } catch {
    // The next hook or command sweeps again.
  }
}

/** What closed-session handling needs outside a hook (the sweep's reaping of ended sessions). */
function closedDeps(env: NodeJS.ProcessEnv, now: number): ClosedDeps {
  const { state, timers, sweepDeps } = timerDeps(env);
  const notify = osNotifier();
  return {
    stateDir: state,
    now,
    env,
    arm: (id, at) => {
      scheduleFire(id, at, sweepDeps(Date.now()));
    },
    disarm: (id) => cancelTimer(id, timers),
    notify: (title, body) => {
      notify(title, body);
    },
  };
}

/** Timers, the sweep and a detached `fire`, for this run. */
function timerDeps(env: NodeJS.ProcessEnv) {
  const state = stateDir(env);
  const node = stableNode();
  const cli = rewakeCli(state);
  const timers = defaultTimerHost(state, node, cli);
  return {
    state,
    node,
    timers,
    sweepDeps: (now: number): SweepDeps => ({
      stateDir: state,
      now,
      hosts: hostAdapters(env, node, state),
      timers,
      fireDetached: (id) => timers.detached(node, [cli, "fire", id]),
    }),
  };
}

/**
 * `agent-rewake fire <id>`: run by a resume's OS timer (src/timers/). Exit status 0 unless the
 * id is malformed; what happened is in the schedule and the log.
 */
async function runFire(name: string, env: NodeJS.ProcessEnv): Promise<number> {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) {
    process.stderr.write("agent-rewake: usage: agent-rewake fire <id>\n");
    return 2;
  }
  // A timer re-armed from inside another runs as `<id>-r<n>` (src/timers/timers.ts).
  const { id, gen } = parseTimerName(name);
  const { state, node, timers } = timerDeps(env);
  const log = new Logger(env);
  const outcome = await fire(id, {
    stateDir: state,
    now: Date.now,
    hosts: hostAdapters(env, node, state),
    timers,
    notify: osNotifier(),
    log: (event, fields) => log.info(event, fields),
    fromTimer: true,
    timerGen: gen,
  });
  log.info("fire.done", { outcome });
  return 0;
}

/**
 * `agent-rewake hook <host> <event>`: run by an agent's hook (src/hosts/hook.ts). Always exits 0
 * so a problem in Rewake never breaks the agent; it prints only the reply the agent expects.
 */
async function runHookCommand(
  host: string,
  event: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const log = new Logger(env);
  try {
    const { state, timers, sweepDeps } = timerDeps(env);
    const notify = osNotifier();
    const handler = hookHandler(host, {
      arm: (id, at) => {
        const r = scheduleFire(id, at, sweepDeps(Date.now()));
        log.info("hook.arm", { host, via: r === "fired" ? "now" : r.ok ? r.via : r.reason });
      },
      disarm: (id) => cancelTimer(id, timers),
      notify: (title, body) => {
        notify(title, body);
      },
      closed: (ctx) => ({
        stateDir: ctx.stateDir,
        now: ctx.now,
        env: ctx.env,
        arm: (id, at) => {
          const r = scheduleFire(id, at, sweepDeps(Date.now()));
          log.info("hook.arm", { host, via: r === "fired" ? "now" : r.ok ? r.via : r.reason });
        },
        disarm: (id) => cancelTimer(id, timers),
        notify: (title, body) => {
          notify(title, body);
        },
        agent: () => agentProcess(),
      }),
      program: (h, e) => {
        const host = { env: e, home: homedir(), platform: process.platform };
        if (h === "copilot-cli") return copilotPrograms(host)[0]?.path;
        if (h === "grok") return grokPrograms(host)[0]?.path;
        if (h === "gemini-cli") return geminiPrograms(host)[0]?.path;
        if (h === "antigravity") return agyPrograms(host)[0]?.path;
        return undefined;
      },
      codexPath: () => {
        const programs = codexPrograms({ env, home: homedir(), platform: process.platform });
        const cli = programs.filter((p) => p.surface === "terminal");
        const pool = cli.length > 0 ? cli : programs;
        return pool.sort((a, b) => compareVersions(b.version ?? "0", a.version ?? "0"))[0]?.path;
      },
    });
    const reply = await runHook(handler, event, await readStdin(), env, state, Date.now());
    if (reply) process.stdout.write(`${reply}\n`);
    const swept = sweep(sweepDeps(Date.now()));
    const reaped = reapClosed(CLOSED_HOSTS, closedDeps(env, Date.now()));
    log.info("hook", { host, event, fired: swept.fired, armed: swept.armed, reaped });
  } catch (err) {
    log.error("hook.failed", { host, event, message: (err as Error).message });
  }
  return 0;
}

/** Ask one question in the terminal; resolves with what was typed. */
async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** `agent-rewake continue`: continue a closed session after its usage limit (src/continue.ts). */
async function runContinueCommand(
  env: NodeJS.ProcessEnv,
  mode?: "always" | "ask" | "cancel",
): Promise<number> {
  const { state, timers, sweepDeps } = timerDeps(env);
  sweepQuietly(env);
  return runContinue({
    sleepSettings: () => readSleepSettings({ env }),
    ...(mode && { mode }),
    hosts: CLOSED_HOSTS,
    deps: {
      stateDir: state,
      now: Date.now(),
      env,
      arm: (id, at) => {
        scheduleFire(id, at, sweepDeps(Date.now()));
      },
      disarm: (id) => cancelTimer(id, timers),
      notify: () => {},
    },
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (t) => process.stdout.write(t),
    ask: prompt,
  });
}

/** The previews set up on this computer, by name. */
function previewNames(env: NodeJS.ProcessEnv): string[] {
  return installedPreviews(env, homedir(), stateDir(env)).map((id) => PREVIEW_NAMES[id] ?? id);
}
