import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { type AgentCommand, claudeAdapterCommand } from "./adapters/claude/spawn.js";
import { SchedulingAddon } from "./addon.js";
import { runContinue } from "./continue.js";
import { applySettings, loadSettings } from "./core/settings.js";
import { ScheduleStore, TERMINAL_STATUSES } from "./core/store.js";
import {
  type DoctorContext,
  detailLines,
  diagnose,
  when as doctorWhen,
  findZedApps,
  recentLogs,
  render,
  renderJson,
} from "./doctor.js";
import { buildReport, ISSUE_URL, REPORT_DAYS, writeReport } from "./doctor-report.js";
import { commandHelp, completionScript, PLACES, SHELLS, usageText } from "./help.js";
import { runAntigravityInstall } from "./hosts/antigravity/install.js";
import { refreshMod, runClaudeInstall } from "./hosts/claude-code/install.js";
import { type ClosedDeps, reapClosed } from "./hosts/closed.js";
import { runCodexInstall } from "./hosts/codex/install.js";
import { runCopilotInstall } from "./hosts/copilot/install.js";
import { cursorFound, runCursorInstall } from "./hosts/cursor/install.js";
import { devinFound, runDevinInstall } from "./hosts/devin/install.js";
import { diagnoseOutside } from "./hosts/doctor.js";
import { runGeminiInstall } from "./hosts/gemini/install.js";
import { runGrokInstall } from "./hosts/grok/install.js";
import { readStdin, runHook } from "./hosts/hook.js";
import { CLOSED_HOSTS, hookHandler, hostAdapters, OWNER_ENV } from "./hosts/index.js";
import { jetbrainsFound, runJetbrainsInstall } from "./hosts/jetbrains/install.js";
import { runOpenCodeInstall } from "./hosts/opencode/install.js";
import { installedPreviews, PREVIEW_NAMES } from "./hosts/previews.js";
import { runQwenInstall } from "./hosts/qwen/install.js";
import { SessionRecords } from "./hosts/sessions.js";
import { AGENT_VERSIONS } from "./hosts/versions.js";
import { finishUninstall } from "./install/cleanup.js";
import {
  agentCopies,
  agyPrograms,
  chooseProgram,
  codexPrograms,
  compareVersions,
  copilotPrograms,
  detectAgents,
  type Found,
  geminiPrograms,
  grokPrograms,
  opencodePrograms,
  type PlaceId,
  qwenPrograms,
  terminalAgents,
} from "./install/detect.js";
import {
  choosePlaces,
  defaultChoice,
  defaultPlaceText,
  type Keypress,
  listNames,
  type Place,
  PREVIEW_NOTE,
  placesFrom,
  quickSetupPrompt,
  UNREACHABLE,
} from "./install/select.js";
import { zedLaunch } from "./install/zed-launch.js";
import {
  keyChord,
  launchCommand,
  planUninstall,
  runInstall,
  selfCommand,
  stableNode,
  TASK_LABEL,
  taskEntry,
  wrappedEntry,
  zedConfigDir,
} from "./install.js";
import { renderSample } from "./limit-sample.js";
import { runMcp } from "./mcp.js";
import { runProxy } from "./proxy.js";
import { runSettings } from "./settings-command.js";
import { agentName } from "./setup.js";
import { fire } from "./timers/fire.js";
import { ensureLauncher, launcherPath, refreshLauncher } from "./timers/launcher.js";
import { loginItem, loginItemPlanText, loginItemText, syncLoginItem } from "./timers/login.js";
import { rewakeNode } from "./timers/node-shim.js";
import { osNotifier } from "./timers/notify.js";
import { pruneState } from "./timers/prune.js";
import { type SweepDeps, scheduleFire, sweep } from "./timers/sweep.js";
import {
  cancelTimer,
  defaultTimerHost,
  parseTimerName,
  timerArmed,
  timerKind,
} from "./timers/timers.js";
import { isWsl, runWaiter, waiterNote } from "./timers/waiter.js";
import { history, historyText } from "./ui/history.js";
import { explainSchedule, overview, overviewText } from "./ui/overview.js";
import { runTui } from "./ui/tui.js";
import { rewake } from "./util/command.js";
import { readInstalled, recordInstall } from "./util/installed.js";
import { Wakefulness } from "./util/keep-awake.js";
import { Logger } from "./util/log.js";
import { ensurePrivateDir, stateDir } from "./util/paths.js";
import { agentProcess } from "./util/proc.js";
import { readSleepSettings } from "./util/sleep-settings.js";
import { resolveCommand } from "./util/spawn.js";
import { noColorFrom, paint } from "./util/style.js";
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
const INSTALL_PLACES: ReadonlySet<string> = new Set(PLACES);

/** Options each of these commands takes; anything else is a mistake worth saying so. */
const KNOWN_OPTIONS: Record<string, string[]> = {
  doctor: ["--details", "--json", "--report"],
  schedules: ["--all", "--json", "--explain"],
  history: ["--days"],
};

/** An agent outside Zed as people know it ("Codex"), from its host id, without starting anything. */
function hostLabel(host: string): string | undefined {
  return (
    CLOSED_HOSTS.find((x) => x.id === host)?.name ??
    Object.entries(PREVIEW_NAMES).find(([id]) => id === host)?.[1]
  );
}

/** The first option `command` doesn't take (a value after `--days` is skipped), if any. */
function unknownOption(command: string, rest: string[]): string | undefined {
  const known = KNOWN_OPTIONS[command] ?? [];
  const at = command === "history" ? rest.indexOf("--days") : -1;
  const value = at === -1 ? -1 : at + 1;
  return rest.find((a, i) => i !== value && !known.includes(a));
}

/**
 * Whether a person already said what to set up — the screen's own question, or typing `--all` on
 * purpose — so a separate "Apply these changes?" would just ask the same decision again (plan
 * §4.1: one decision, which places, not two). True only when a live person could have just
 * decided it: a real terminal, or the raw `--yes` flag. A script with neither — `--all` with no
 * terminal and no `--yes` — still gets the same refusal as before: nobody was there to decide.
 */
export function alreadyConfirmedChoice(
  picked: boolean,
  yes: boolean,
  interactive: boolean,
): boolean {
  return picked && (yes || interactive);
}

/**
 * The one line said before applying several places from the screen (or `--all`): their names,
 * not each one's own full breakdown of file paths and per-agent bullets. That full breakdown
 * still exists, unabridged, one flag away.
 */
export function multiPlaceLine(names: string[], noColor: boolean): string {
  const colored = names.map((n) => paint(n, "accent", noColor));
  return (
    `\nAgent Rewake will set up ${listNames(colored)}.\n` +
    `${paint(`See every line: ${rewake("install --dry-run")}`, "dim", noColor)}\n`
  );
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const wrap = parseWrapArgs(argv);
  if (wrap && "error" in wrap) {
    process.stderr.write(`agent-rewake: ${wrap.error}\n`);
    return 2;
  }

  // Help changes nothing and starts nothing: answered before anything else is touched.
  const helpCode = helpFor(argv);
  if (helpCode !== undefined) return helpCode;

  // Terminal-auth relaunch: the client re-runs our command with the adapter's
  // `--cli …` args. Hand straight to the adapter with inherited stdio; Rewake never sees the login.
  // (In wrap mode the same happens further down, for whichever agent is wrapped.)
  if (!wrap && argv.includes("--cli")) {
    return runInTerminal(claudeAdapterCommand(argv, env));
  }

  // The clock (and later settings) apply to everything this process prints.
  applySettings(stateDir(env));
  // A newer Rewake keeps the copy that hooks and timers run current (plan §3.6).
  if (process.argv[1]) {
    refreshLauncher(stateDir(env), process.argv[1], VERSION);
    refreshMod(stateDir(env), process.argv[1], VERSION);
  }

  const [first] = argv;
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (first === "mcp")
    // The agent's tool server, started by the agent. stdout carries MCP.
    return runMcp({ stateDir: stateDir(env), link: env.AGENT_REWAKE_LINK });
  if (first === "doctor" && argv.includes("--limit-sample")) {
    // The words after the flag, so an unquoted message works too. Reads no Rewake state.
    const text = argv
      .slice(argv.indexOf("--limit-sample") + 1)
      .join(" ")
      .trim();
    const report = text === "" ? "" : renderSample(text);
    if (report === "") {
      process.stderr.write(
        `Give the limit message after the flag, in quotes: ${rewake('doctor --limit-sample "<the message your agent showed>"')}\n`,
      );
      return 2;
    }
    process.stdout.write(report);
    return 0;
  }
  if (first === "doctor" || first === "schedules" || first === "history") {
    const bad = unknownOption(first, argv.slice(1));
    if (bad) {
      process.stderr.write(
        `agent-rewake: unknown option for ${first}: ${bad}. Run ${rewake(`${first} --help`)} for the options.\n`,
      );
      return 2;
    }
  }
  if (first === "completion") {
    const shell = argv[1];
    if (!shell || !(SHELLS as readonly string[]).includes(shell)) {
      process.stderr.write(`agent-rewake: usage: agent-rewake completion <${SHELLS.join("|")}>\n`);
      return 2;
    }
    process.stdout.write(completionScript(shell as (typeof SHELLS)[number]));
    return 0;
  }
  if (first === "history") {
    const at = argv.indexOf("--days");
    const days = at === -1 ? 7 : Number(argv[at + 1]);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      process.stderr.write("agent-rewake: --days takes a whole number of days, from 1 to 3650.\n");
      return 2;
    }
    process.stdout.write(
      `${historyText(history(stateDir(env), Date.now(), days, hostLabel), days)}\n`,
    );
    return 0;
  }
  if (first === "doctor") {
    const json = argv.includes("--json");
    const report = argv.includes("--report");
    if (json && report) {
      process.stderr.write("agent-rewake: use --json or --report, not both.\n");
      return 2;
    }
    sweepQuietly(env);
    return doctor(env, { details: argv.includes("--details"), json, report });
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
      hostNoun: (h) => hosts.get(h)?.noun,
      // A resume outside Zed changed on the page: its OS timer follows.
      onHostChange: (id) => {
        const s = new ScheduleStore(state).get(id);
        if (s?.status === "scheduled") scheduleFire(id, s.dueAt, sweepDeps(Date.now()));
        else cancelTimer(id, timers);
      },
    });
  }
  if (first === "schedules") {
    const e = argv.indexOf("--explain");
    if (e !== -1) {
      const wanted = argv[e + 1];
      if (!wanted || wanted.startsWith("--")) {
        process.stderr.write("agent-rewake: usage: agent-rewake schedules --explain <id>\n");
        return 2;
      }
      const { node, state } = timerDeps(env);
      const hosts = hostAdapters(env, node, state);
      const r = explainSchedule(stateDir(env), wanted, Date.now(), (h) => hosts.get(h));
      if (!r.ok) {
        process.stderr.write(`agent-rewake: ${r.error}\n`);
        return 1;
      }
      process.stdout.write(`${r.text}\n`);
      return 0;
    }
    const all = argv.includes("--all");
    const { node, state } = timerDeps(env);
    const hosts = hostAdapters(env, node, state);
    const groups = overview(stateDir(env), all, hostLabel, (h) => hosts.get(h)?.noun);
    process.stdout.write(
      argv.includes("--json")
        ? `${JSON.stringify(groups, null, 2)}\n`
        : `${overviewText(groups, Date.now(), undefined, all)}\n`,
    );
    return 0;
  }
  if (first === "install" || first === "uninstall") {
    const known = new Set(["--yes", "-y", "--dry-run", "--keybinding", "--all"]);
    const only: string[] = [];
    const places: string[] = [];
    const skip: string[] = [];
    const unknown: string[] = [];
    const rest = argv.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] ?? "";
      if (a === "--agent" && first === "install" && rest[i + 1]) only.push(rest[++i] ?? "");
      else if ((a === "--only" || a === "--skip") && rest[i + 1])
        (a === "--only" ? places : skip).push(
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
    const yes = argv.includes("--yes") || argv.includes("-y");
    const dryRun = argv.includes("--dry-run");
    let chosen: string[];
    // Chosen on the screen or with --all: changes are shown together and asked about once.
    let picked = false;
    if (places.length > 0) chosen = [...new Set(places)];
    else if (argv.includes("--all") || first === "uninstall") {
      // Uninstall with no place named: every place Rewake is set up in, asked about once.
      chosen = pickablePlaces(env, first === "uninstall");
      picked = true;
    } else if (
      first === "install" &&
      only.length === 0 &&
      !yes &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      // No place named, in a terminal: show what's here and let the person pick (plan §4.1).
      const pickedPlaces = await pickPlaces(env);
      if (!pickedPlaces) {
        process.stdout.write("Nothing was changed.\n");
        return 1;
      }
      chosen = pickedPlaces;
      picked = true;
    } else {
      // Scripts and `--yes` keep today's default, Zed, and say so.
      chosen = ["zed"];
      if (first === "install" && only.length === 0)
        process.stdout.write(defaultPlaceText(placesHere(env).places));
    }
    chosen = chosen.filter((p) => !skip.includes(p));
    const bad = [...chosen, ...skip].filter((p) => !INSTALL_PLACES.has(p));
    if (bad.length > 0) {
      process.stderr.write(
        `agent-rewake: ${bad.join(", ")}: not a place Rewake can ${first === "install" ? "install into" : "remove from"}. Choose from: ${[...INSTALL_PLACES].join(", ")}.\n`,
      );
      return 2;
    }
    if (chosen.length === 0) {
      process.stdout.write("No places chosen: nothing was changed.\n");
      return 0;
    }
    const uninstall = first === "uninstall";
    const ask = async (q: string) => /^y(es)?$/i.test((await prompt(q)).trim());
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    /** One place's install (or uninstall), with how it asks and where it prints. */
    const runPlace = (
      id: string,
      o: { yes: boolean; dryRun: boolean; out: (t: string) => void },
    ): Promise<number> => {
      if (id === "zed") {
        const zed = zedLaunch(stateDir(env), process.argv[1] ?? "");
        return runInstall({
          uninstall,
          launch: zed.launch,
          prepare: zed.prepare,
          ...(only.length > 0 && { only }),
          yes: o.yes,
          dryRun: o.dryRun,
          keybinding: argv.includes("--keybinding"),
          env,
          out: o.out,
        });
      }
      const common = {
        uninstall,
        yes: o.yes,
        dryRun: o.dryRun,
        env,
        stateDir: stateDir(env),
        node: rewakeNode(stateDir(env)),
        bundle: process.argv[1] ?? "",
        interactive,
        out: o.out,
        ask,
      };
      if (id === "claude-code") return runClaudeInstall(common);
      if (id === "codex") return runCodexInstall(common);
      if (id === "copilot-cli") return runCopilotInstall(common);
      if (id === "grok") return runGrokInstall(common);
      if (id === "gemini-cli") return runGeminiInstall(common);
      if (id === "qwen-code") return runQwenInstall(common);
      if (id === "opencode") return runOpenCodeInstall(common);
      if (id === "devin-desktop")
        return runDevinInstall({
          uninstall,
          yes: o.yes,
          dryRun: o.dryRun,
          env,
          launch: launchCommand(),
          interactive,
          out: o.out,
          ask,
        });
      if (id === "cursor") return runCursorInstall(common);
      if (id === "jetbrains")
        return runJetbrainsInstall({
          uninstall,
          yes: o.yes,
          dryRun: o.dryRun,
          env,
          launch: launchCommand(),
          interactive,
          out: o.out,
          ask,
        });
      return runAntigravityInstall(common);
    };
    const order = [...INSTALL_PLACES].filter((p) => chosen.includes(p));
    const print = (t: string) => {
      process.stdout.write(t);
    };
    let code = 0;
    // The screen's own question (or --all, typed on purpose) already is the one decision to
    // apply: a second "Apply these changes?" asks the same thing again. It's still skipped when
    // there's no live person to have just decided anything — a non-interactive --all still needs
    // --yes, the same safety net as before (checked after showing what would happen, as before).
    const alreadyConfirmed = alreadyConfirmedChoice(picked, yes, interactive);
    if (picked && !dryRun && order.length > 1) {
      // Several places from the screen: one short line naming them (not each place's own full
      // breakdown — that was a wall of file paths and a bullet per agent, exactly the long-to-read
      // screen the quick question upstream was built to avoid), then (plan §4.1: one decision,
      // already made on the screen that chose these places) straight on to applying them. The full
      // breakdown for every place is still `install --dry-run`, unabridged, same as for one place.
      print(multiPlaceLine(order.map(placeName), noColorFrom(env)));
      if (!uninstall && loginWouldAdd(env, order))
        print(`\n${loginItemPlanText(process.platform)}`);
      if (!alreadyConfirmed) {
        print(
          "\nNot a terminal, so nothing was changed. Run again with --yes to apply the changes above.\n",
        );
        return 1;
      }
      const results: [string, number, string][] = [];
      for (const id of order) {
        let text = "";
        const c = await runPlace(id, {
          yes: true,
          dryRun: false,
          out: (t) => {
            text += t;
          },
        });
        results.push([id, c, text]);
        code = Math.max(code, c);
      }
      print(summaryText(results, uninstall ? "uninstall" : "install"));
    } else {
      // Said before the place's own question, with its other changes.
      if (!uninstall && loginWouldAdd(env, order)) print(loginItemPlanText(process.platform));
      for (const id of order)
        code = Math.max(
          code,
          await runPlace(id, { yes: yes || alreadyConfirmed, dryRun, out: print }),
        );
    }
    if (uninstall && !dryRun) cancelResumesOf(chosen, env);
    // Noted for `doctor`'s "installed N days ago": local only, nothing is checked online.
    if (!dryRun && !uninstall && code === 0) recordInstall(stateDir(env), VERSION, Date.now());
    if (!dryRun) {
      const change = syncLogin(env);
      if (change !== "unchanged") print(loginItemText(change, process.platform));
      if (!uninstall && order.some((p) => TIMER_PLACES.has(p)) && usesWaiter(env))
        print(((n) => `${n.text} ${n.fix}\n`)(waiterNote(isWsl())));
      if (uninstall) {
        // Out of every place: the timers and helper files go too, and what stays is listed. With
        // places left, nothing is deleted (their hooks run those files) and the sweep carries on.
        const done = finishUninstall({
          env,
          home: homedir(),
          platform: process.platform,
          chosen,
        });
        if (done.text) print(done.text);
        if (done.remains) sweepQuietly(env);
      } else sweepQuietly(env);
    }
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
    // `--cancel <id>`: one planned resume, by the id the lists show.
    const cancelId = mode === "cancel" ? argv[2] : undefined;
    const extra = argv.length > (cancelId === undefined ? 2 : 3);
    if ((flag !== undefined && mode === undefined) || extra || cancelId?.startsWith("-")) {
      process.stderr.write(
        "agent-rewake: usage: agent-rewake continue [--always | --ask | --cancel [<id>]]\n",
      );
      return 2;
    }
    return runContinueCommand(env, mode, cancelId);
  }
  if (first === "settings")
    return runSettings({
      stateDir: stateDir(env),
      args: argv.slice(1),
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      wakeSupported: new Wakefulness().supported,
      out: (t) => process.stdout.write(t),
      err: (t) => process.stderr.write(t),
      ask: prompt,
    });
  if (first === "sweep") {
    // Run at login by Rewake's login item (src/timers/login.ts): set lost timers again.
    const at = argv.indexOf("--state-dir");
    const dir = at !== -1 ? argv[at + 1] : undefined;
    sweepQuietly(dir ? { ...env, AGENT_REWAKE_STATE_DIR: dir } : env);
    return 0;
  }
  if (first === "wait") {
    // Rewake's own timer where Linux has no other (src/timers/waiter.ts); started by armTimer.
    const at = argv.indexOf("--state-dir");
    const dir = at !== -1 ? argv[at + 1] : undefined;
    const { state, node, timers } = timerDeps(dir ? { ...env, AGENT_REWAKE_STATE_DIR: dir } : env);
    return runWaiter({
      timers,
      pid: process.pid,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      fire: (name) => timers.detached(node, [timers.cli, "fire", name, "--state-dir", state]),
    });
  }
  if (first === "fire") {
    // Timers name the state folder: they run without Rewake's environment (src/timers/timers.ts).
    const at = argv.indexOf("--state-dir");
    const dir = at !== -1 ? argv[at + 1] : undefined;
    return runFire(argv[1] ?? "", dir ? { ...env, AGENT_REWAKE_STATE_DIR: dir } : env);
  }
  if (first === "hook") return runHookCommand(argv[1] ?? "", argv[2] ?? "", env);
  if (first === "setup") {
    if (argv[1] !== "zed") {
      process.stderr.write("agent-rewake: usage: agent-rewake setup zed\n");
      return 2;
    }
    process.stdout.write(setupZedText(env));
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
    process.stderr.write(`agent-rewake: unknown arguments: ${argv.join(" ")}\n${usageText()}\n`);
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
    ...testTiming(env),
  });
  const code = await runProxy({
    agent,
    clientIn: process.stdin,
    clientOut: process.stdout,
    log,
    hooks: addon.hooks(),
    setup: (router) => addon.attach(router),
    onAgentRestarted: (inFlight) => void addon.onAgentRestarted(inFlight),
    onFailOpen: () => addon.failOpen(),
    handleSignals: true,
    handleProcessErrors: true,
  });
  addon.stop();
  return code;
}

/**
 * `agent-rewake doctor [--details] [--json | --report]`: see src/doctor.ts and
 * src/doctor-report.ts. Exit status 1 when something is broken.
 */
function doctor(
  env: NodeJS.ProcessEnv,
  mode: { details: boolean; json: boolean; report: boolean },
): number {
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
    copies: () => agentCopies({ env, home: homedir(), platform: process.platform }),
    previews: () => previewNames(env),
    sleep: () => {
      const keepAwake = loadSettings(stateDir(env)).keepAwake;
      return {
        settings: readSleepSettings({ env }),
        hold: new Wakefulness().supported && keepAwake !== "never" ? keepAwake : "none",
      };
    },
    installed: () => readInstalled(stateDir(env)),
    launch: zedLaunch(stateDir(env), process.argv[1] ?? "").launch,
    version: VERSION,
    nodeVersion: process.versions.node,
  };
  const findings = diagnose(ctx);
  const { state, node, timers } = timerDeps(env);
  findings.push(
    ...diagnoseOutside({
      stateDir: state,
      env,
      home: homedir(),
      now: ctx.now,
      platform: process.platform,
      previews: installedPreviews(env, homedir(), state).map((id) => ({
        id,
        name: PREVIEW_NAMES[id] ?? id,
      })),
      hosts: hostAdapters(env, node, state),
      ...((kind) => ({ hasTimer: kind !== undefined, ...(kind && { timerKind: kind }) }))(
        timerKind(timers),
      ),
      wsl: process.platform === "linux" && isWsl(),
      agents: terminalAgents({ env, home: homedir(), platform: process.platform }),
      when: doctorWhen,
    }),
  );
  if (env.AGENT_REWAKE_TEST_TIMING)
    findings.push({
      area: "Rewake",
      level: "info",
      text: env.AGENT_REWAKE_STATE_DIR
        ? "AGENT_REWAKE_TEST_TIMING is set: resumes here use test timings, for Rewake's own tests."
        : "AGENT_REWAKE_TEST_TIMING is set but ignored: it applies only with AGENT_REWAKE_STATE_DIR.",
      fix: "Unset AGENT_REWAKE_TEST_TIMING unless you're running Rewake's tests.",
    });
  for (const id of toolsRefused(stateDir(env)))
    findings.push({
      area: "Recently",
      level: "info",
      text: `${agentName(id, env)} didn't accept Rewake's tools, so it can't suggest schedules. The Rewake menu and /rewake still work.`,
    });
  const code = findings.some((f) => f.level === "problem") ? 1 : 0;
  if (mode.json) {
    process.stdout.write(
      renderJson(findings, {
        version: VERSION,
        ...(mode.details && { details: detailLines(ctx) }),
      }),
    );
    return code;
  }
  if (mode.report) {
    const logs = recentLogs(state, ctx.now, REPORT_DAYS);
    const store = new ScheduleStore(state);
    const text = buildReport({
      version: VERSION,
      nodeVersion: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      now: ctx.now,
      home: homedir(),
      findings,
      details: detailLines(ctx),
      logs,
      schedules: store.list(),
      timerKind: timerKind(timers),
      timerArmed: (id) => {
        try {
          return timerKind(timers) ? timerArmed(id, timers) : undefined;
        } catch {
          return undefined;
        }
      },
      sessions: CLOSED_HOSTS.map((h) => ({
        host: h.id,
        name: h.name,
        records: new SessionRecords(state, h.id).list(),
      })),
    });
    const file = writeReport(state, ctx.now, text);
    const shown = file.startsWith(homedir()) ? `~${file.slice(homedir().length)}` : file;
    process.stdout.write(
      [
        `Wrote your bug report to ${shown}`,
        "It shows your home folder as ~, hides session ids and leaves out message text. Read it before you share it: nothing has been sent.",
        `To report the problem, open ${ISSUE_URL} and attach the file.`,
        "",
      ].join("\n"),
    );
    return code;
  }
  const ascii = (process.platform === "win32" && !env.WT_SESSION) || env.TERM === "dumb";
  process.stdout.write(
    render(findings, {
      version: VERSION,
      ascii,
      ...(mode.details && { details: detailLines(ctx) }),
    }),
  );
  return code;
}

/** `--help`, `help [command]` and `<command> --help`: the exit code, or undefined if it's neither. */
function helpFor(argv: string[]): number | undefined {
  const [first, second] = argv;
  const say = (text: string) => {
    process.stdout.write(`${text}\n`);
    return 0;
  };
  if (first === "--help" || first === "-h") return say(usageText(argv.includes("--all")));
  if (first === "help") {
    if (second === undefined) return say(usageText());
    const text = commandHelp(second === "--help" || second === "-h" ? "help" : second);
    if (text) return say(text);
    process.stderr.write(`agent-rewake: no command named "${second}".\n${usageText()}\n`);
    return 2;
  }
  if (first && argv.slice(1).some((a) => a === "--help" || a === "-h")) {
    const text = commandHelp(first);
    if (text) return say(text);
  }
  return undefined;
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
function setupZedText(env: NodeJS.ProcessEnv): string {
  // The entries name files in Rewake's own folder, so they are made now: pasted by hand, they work.
  const zed = zedLaunch(stateDir(env), process.argv[1] ?? "");
  let launch = zed.launch;
  try {
    zed.prepare();
  } catch {
    launch = launchCommand();
  }
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
    `Easiest: run \`${rewake("install")}\`, which adds these for you after asking.`,
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

/**
 * Test seam (plan §10.4): `AGENT_REWAKE_TEST_TIMING="margin=0,jitter=0,heartbeat=1000"` shortens
 * the add-on's waits for end-to-end tests. Honoured only with AGENT_REWAKE_STATE_DIR set (a test's
 * own state folder), so it can't change a person's setup; `doctor` reports it.
 */
export function testTiming(env: NodeJS.ProcessEnv): {
  resumeMarginMs?: number;
  jitterMs?: number;
  heartbeatMs?: number;
} {
  const spec = env.AGENT_REWAKE_TEST_TIMING;
  if (!spec || !env.AGENT_REWAKE_STATE_DIR) return {};
  const keys = { margin: "resumeMarginMs", jitter: "jitterMs", heartbeat: "heartbeatMs" } as const;
  const out: { resumeMarginMs?: number; jitterMs?: number; heartbeatMs?: number } = {};
  for (const part of spec.split(",")) {
    const [k, v] = part.split("=");
    const key = keys[(k ?? "").trim() as keyof typeof keys];
    const n = Number(v);
    if (key && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

/** What `install` finds here, as the selection screen lists it. */
function placesHere(env: NodeJS.ProcessEnv): { places: Place[]; missing: string[] } {
  const host = { env, home: homedir(), platform: process.platform };
  const found = detectAgents(host);
  const zedApps = findZedApps(process.platform, homedir(), env);
  const installed = new Set<PlaceId>(installedPreviews(env, homedir(), stateDir(env)));
  // JetBrains IDEs run agents through ACP: offered like an agent, with no version of their own.
  const withIde: Found[] = [
    ...found,
    ...(jetbrainsFound(env, homedir(), process.platform)
      ? [{ id: "jetbrains" as const, name: "JetBrains IDEs", surfaces: ["app"] }]
      : []),
    ...(devinFound(homedir())
      ? [{ id: "devin-desktop" as const, name: "Devin Desktop", surfaces: ["app"] }]
      : []),
    ...(cursorFound(env, homedir(), process.platform)
      ? [{ id: "cursor" as const, name: "Cursor", surfaces: ["app"] }]
      : []),
  ];
  const places = placesFrom(
    withIde,
    {
      found: zedApps.length > 0,
      ...(zedApps[0]?.version && { version: zedApps[0].version }),
    },
    installed,
    (id) => (id === "zed" ? undefined : AGENT_VERSIONS[id]?.min),
    (a, b) => compareVersions(a, b) < 0,
    (id) => (id === "zed" ? undefined : AGENT_VERSIONS[id]?.update),
  );
  const names: Partial<Record<PlaceId, string>> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    "copilot-cli": "GitHub Copilot CLI",
    grok: "Grok Build",
    "gemini-cli": "Gemini CLI",
    "qwen-code": "Qwen Code",
    opencode: "OpenCode",
    antigravity: "Antigravity",
  };
  const ids = new Set(places.map((p) => p.id));
  const missing = Object.entries(names)
    .filter(([id]) => !ids.has(id as PlaceId))
    .map(([, n]) => n as string);
  return { places, missing };
}

function placeName(id: string): string {
  const names: Record<string, string> = {
    zed: "Zed",
    "claude-code": "Claude Code",
    codex: "Codex",
    "copilot-cli": "GitHub Copilot CLI",
    grok: "Grok Build",
    "gemini-cli": "Gemini CLI",
    "qwen-code": "Qwen Code",
    opencode: "OpenCode",
    antigravity: "Antigravity",
    jetbrains: "JetBrains IDEs",
    "devin-desktop": "Devin Desktop",
  };
  return names[id] ?? id;
}

/**
 * One line per place after applying several: done and the one next step, or why not. The next
 * step is what the place's own install said after "Done."; a failure, its last line.
 */
export function summaryText(
  results: [string, number, string][],
  verb: "install" | "uninstall" = "install",
): string {
  const width = Math.max(...results.map(([id]) => placeName(id).length));
  const lines = results.map(([id, c, text]) => {
    const said = text
      .trim()
      .split("\n")
      .map((l) => l.trim())
      // The plan above said each file is backed up next to itself: the summary keeps to the next step.
      .filter((l) => l && !l.startsWith("Backup:"));
    const done = said.findIndex((l) => l.startsWith("Done"));
    const next =
      c === 0
        ? done >= 0
          ? said
              .slice(done)
              .join(" ")
              .replace(/^Done\.?\s*/, "")
          : (said.at(-1) ?? "")
        : (said.at(-1) ?? "");
    const state = c === 0 ? "done" : "not changed";
    // A place that didn't change: its reason, then how to try it on its own.
    const retry = c === 0 ? "" : ` Try it on its own: ${rewake(`${verb} --only ${id}`)}`;
    return `  ${placeName(id).padEnd(width)}  ${state}${next ? `: ${next}` : ""}${retry}`;
  });
  return `\nResult:\n${lines.join("\n")}\n`;
}

/** `--all`: every place found that Rewake can install into, or (uninstall) every one it's in. */
function pickablePlaces(env: NodeJS.ProcessEnv, uninstall: boolean): string[] {
  if (uninstall) {
    // Where Rewake is set up, found from its own entries (an agent removed since still counts).
    const zed = planUninstall(zedConfigDir(env)).changes.length > 0 ? ["zed"] : [];
    const ids = [...zed, ...installedPreviews(env, homedir(), stateDir(env))];
    // Set up nowhere: Zed's own uninstall says there's nothing to remove.
    return ids.length > 0 ? ids : ["zed"];
  }
  const { places } = placesHere(env);
  return places.filter((p) => p.state !== "too-old").map((p) => p.id);
}

/**
 * The selection screen, in this terminal; undefined when the person quits.
 *
 * Key presses go through Node's own `readline.emitKeypressEvents`, not a match on the raw bytes:
 * a terminal can split an escape sequence (`ESC [ A`) across more than one `data` event (common
 * over SSH, in tmux/screen, some terminal emulators), and some terminals send arrow keys as
 * `ESC O A` (application cursor mode) instead of `ESC [ A`. Matching whole chunks got a lone ESC
 * byte read as "quit" and the `O` form not recognised at all — arrow keys could do nothing, or
 * exit the screen. `emitKeypressEvents` buffers and decodes both forms the way every well-behaved
 * terminal program does.
 */
async function pickPlaces(env: NodeJS.ProcessEnv): Promise<string[] | undefined> {
  const { places, missing } = placesHere(env);
  // The common path is one question, not a checklist to read through (plan §4.1 revised, F3): set
  // up everywhere Rewake found, or say no and pick. Nothing is asked when there's only one place
  // and nothing to explain about it (F4) — `quickSetupPrompt` returns undefined then.
  const prompt = quickSetupPrompt(places);
  if (prompt === undefined) return [...defaultChoice(places)];
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
    if (/^(y(es)?)?$/i.test(answer)) return [...defaultChoice(places)];
  }
  process.stdout.write(
    `\n${PREVIEW_NOTE} ${UNREACHABLE}\n\n` +
      `Agent Rewake ${VERSION} found these on your computer:\n\n`,
  );
  const stdin = process.stdin;
  emitKeypressEvents(stdin);
  // Key presses through a listener that's removed afterwards: iterating stdin would close it, and
  // the question that follows needs it.
  const queue: Keypress[] = [];
  let wake: (() => void) | undefined;
  const onKeypress = (_str: string, key: Keypress | undefined) => {
    if (!key) return;
    queue.push(key);
    wake?.();
  };
  async function* keys(): AsyncIterable<Keypress> {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as Keypress;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  }
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on("keypress", onKeypress);
  stdin.resume();
  try {
    return await choosePlaces(places, missing, {
      keys: keys(),
      write: (t) => process.stdout.write(t),
      noColor: Boolean(env.NO_COLOR) || env.TERM === "dumb",
      columns: () => process.stdout.columns || 80,
    });
  } finally {
    stdin.off("keypress", onKeypress);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  }
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
  const hosts = hostAdapters(env, rewakeNode(state), state);
  for (const place of gone) {
    let n = 0;
    for (const s of store.list()) {
      if (s.host !== place || TERMINAL_STATUSES.has(s.status)) continue;
      if (!store.cancel(s.scheduleId, Date.now())) continue;
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
/** The previews whose sessions a system timer continues: these need timers back after a restart. */
const TIMER_PLACES = new Set([
  "codex",
  "copilot-cli",
  "gemini-cli",
  "qwen-code",
  "opencode",
  "grok",
  "antigravity",
  "cursor",
]);

/** Whether installing these places would add the login item (it isn't there yet). */
function usesWaiter(env: NodeJS.ProcessEnv): boolean {
  try {
    return timerKind(timerDeps(env).timers) === "waiter";
  } catch {
    return false;
  }
}

function loginWouldAdd(env: NodeJS.ProcessEnv, places: readonly string[]): boolean {
  if (!places.some((p) => TIMER_PLACES.has(p))) return false;
  const { state, node } = timerDeps(env);
  const item = loginItem({
    platform: process.platform,
    home: env.HOME || env.USERPROFILE || homedir(),
    node,
    cli: rewakeCli(state),
    stateDir: state,
    run: () => ({ status: 0 }),
    exists: existsSync,
  });
  return item !== undefined && !existsSync(item.path);
}

/** Keep the login item while a preview that uses timers is set up, and remove it after. */
function syncLogin(env: NodeJS.ProcessEnv): "added" | "removed" | "unchanged" {
  try {
    const { state, node, timers } = timerDeps(env);
    const home = env.HOME || env.USERPROFILE || homedir();
    const wanted = installedPreviews(env, home, state).some((p) => TIMER_PLACES.has(p));
    return syncLoginItem(
      {
        platform: process.platform,
        home,
        node,
        cli: rewakeCli(state),
        stateDir: state,
        run: (cmd, args) => timers.run(cmd, args),
        exists: existsSync,
      },
      wanted,
    );
  } catch {
    return "unchanged";
  }
}

function sweepQuietly(env: NodeJS.ProcessEnv): void {
  try {
    const { sweepDeps } = timerDeps(env);
    sweep(sweepDeps(Date.now()));
    reapClosed(CLOSED_HOSTS, closedDeps(env, Date.now()));
    pruneState(stateDir(env), Date.now());
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
  const node = rewakeNode(state);
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
        return r === "fired" || r.ok;
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
        if (h === "qwen-code") return qwenPrograms(host)[0]?.path;
        if (h === "opencode") return opencodePrograms(host)[0]?.path;
        if (h === "antigravity") return agyPrograms(host)[0]?.path;
        return undefined;
      },
      codexPath: () => {
        const programs = codexPrograms({ env, home: homedir(), platform: process.platform });
        return chooseProgram(programs)?.path;
      },
    });
    const reply = await runHook(handler, event, await readStdin(), env, state, Date.now());
    if (reply) process.stdout.write(`${reply}\n`);
    const swept = sweep(sweepDeps(Date.now()));
    const reaped = reapClosed(CLOSED_HOSTS, closedDeps(env, Date.now()));
    // Once a day, after the work the agent is waiting for: old records and temporary files go.
    const pruned = pruneState(state, Date.now());
    log.info("hook", { host, event, fired: swept.fired, armed: swept.armed, reaped });
    if (pruned) log.info("state.pruned", { ...pruned });
  } catch (err) {
    // The error's kind only: its message can hold paths and session ids (plan §2.6).
    log.error("hook.failed", {
      host,
      event,
      error: (err as NodeJS.ErrnoException).code ?? (err as Error).name,
    });
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
  cancelId?: string,
): Promise<number> {
  const { state, timers, sweepDeps, node } = timerDeps(env);
  sweepQuietly(env);
  const adapters = hostAdapters(env, node, state);
  return runContinue({
    sleepSettings: () => readSleepSettings({ env }),
    ...(mode && { mode }),
    ...(cancelId !== undefined && { cancelId }),
    // Codex's resumes too, which `continue` doesn't arm itself.
    hostOf: (id) => adapters.get(id),
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
    err: (t) => process.stderr.write(t),
    ask: prompt,
  });
}

/** The previews set up on this computer, by name. */
function previewNames(env: NodeJS.ProcessEnv): string[] {
  return installedPreviews(env, homedir(), stateDir(env)).map((id) => PREVIEW_NAMES[id] ?? id);
}
