import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { claudeAutoContinueDisabled } from "./adapters/claude/sources.js";
import { resolveClaudeAdapter } from "./adapters/claude/spawn.js";
import { loadSettings } from "./core/settings.js";
import { ScheduleStore } from "./core/store.js";
import { TEXT_LOCALE } from "./core/time.js";
import { compareVersions, type Found, otherAgentsNote } from "./install/detect.js";
import {
  AGENT_NAME,
  agentPanelKey,
  type LaunchCommand,
  missingLaunchFiles,
  pinnedVersion,
  planInstall,
  quitZed,
  unwrappedEntry,
} from "./install.js";
import { agentName, detectSetup } from "./setup.js";
import { rewake } from "./util/command.js";
import { readText } from "./util/fs.js";
import { stateDir, zedConfigDir, zedDataDir } from "./util/paths.js";
import { SLEEP_DOCS_URL, type SleepSettings, sleepRisks } from "./util/sleep-settings.js";
import { CLAUDE_REGISTRY_ID } from "./wrap.js";

/**
 * `agent-rewake doctor`: looks at the whole setup and says, in plain words, what works and what's
 * left to do. Offline and read-only (apart from a test file in Rewake's own folder).
 *
 * What it reads: Zed's settings.json (on/off switches and the agent entries, never their env
 * values), whether Zed's apps exist and their version, Zed's cached agent list, and Rewake's own
 * folder (logs, schedules, settings). It never reads message text, thread titles or folders,
 * Zed's databases or logs, or any sign-in data: an agent's sign-in kind comes from what the agent
 * itself reported to Zed, which Rewake logs as one word.
 *
 * The default output names no files, folders, accounts or keys; `--details` adds versions and
 * folders, with the home folder shortened to ~.
 *
 * Facts used here (Zed 1.22.0, 2026-09-30, unless noted):
 *   - All release channels share one settings.json; "stable"/"preview"/"nightly"/"dev" and
 *     "macos"/"linux"/"windows" keys override it (settings_store.rs, settings_content.rs).
 *   - Zed starts an external agent when a thread with it is opened, not when Zed starts.
 *   - A registry agent missing from Zed's cached list isn't shown (agent_server_store.rs).
 *   - Agents get the user's shell environment, so variables set in the shell reach Rewake.
 *   - For claude-acp Zed sets ANTHROPIC_API_KEY to "" after the entry's own env when the entry is
 *     a custom command (Rewake's), so a key set there doesn't reach Claude (custom.rs,
 *     agent_server_store.rs).
 *   - API-key and cloud-provider Claude accounts have rate limits, not usage windows
 *     (code.claude.com/docs/en/errors).
 */

export type Level = "ok" | "info" | "todo" | "problem";
export type Area =
  | "Zed"
  | "Rewake"
  | "Sign-in"
  | "Scheduled messages"
  | "Sleep settings"
  | "Outside Zed"
  | "Recently";

export interface Finding {
  area: Area;
  level: Level;
  text: string;
  /** What to do about it, in one sentence. */
  fix?: string;
}

export interface DoctorContext {
  env: NodeJS.ProcessEnv;
  now: number;
  platform: NodeJS.Platform;
  home: string;
  /** Installed Zed apps with their versions (version undefined when it can't be read). */
  zedApps: () => ZedApp[];
  /** How this copy of Rewake would be launched, for comparing with Zed's entries. */
  launch?: LaunchCommand;
  version: string;
  nodeVersion: string;
  /** Other coding agents on this computer (src/install/detect.ts); none when not given. */
  agents?: () => Found[];
  /** Names of the previews set up here (src/hosts/previews.ts); none when not given. */
  previews?: () => string[];
  /** This computer's sleep settings, and how Rewake can hold it awake itself; not checked when absent. */
  sleep?: () => { settings: SleepSettings; hold: "plugged-in" | "always" | "none" };
}

export interface ZedApp {
  name: string;
  version?: string;
}

const CHANNELS = ["stable", "preview", "nightly", "dev"] as const;
const OS_KEYS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
};
const MIN_ZED = "1.22.0";
const MIN_NODE = 22;
const DAY = 24 * 60 * 60 * 1000;

export { compareVersions };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Zed's apps where its installers put them, with versions where the app records one. */
export function findZedApps(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ZedApp[] {
  const apps: ZedApp[] = [];
  const names = ["Zed", "Zed Preview", "Zed Nightly", "Zed Dev"];
  if (platform === "darwin") {
    for (const dir of ["/Applications", join(home, "Applications")]) {
      for (const name of names) {
        const plist = join(dir, `${name}.app`, "Contents", "Info.plist");
        if (!existsSync(plist) || apps.some((a) => a.name === name)) continue;
        const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
          readTextSafe(plist),
        );
        apps.push({ name, ...(m?.[1] && { version: m[1] }) });
      }
    }
  } else if (platform === "linux") {
    // The install script's folders (script/install.sh); the bundle has no version file.
    const local = [
      ["Zed", "zed.app"],
      ["Zed Preview", "zed-preview.app"],
      ["Zed Nightly", "zed-nightly.app"],
    ] as const;
    for (const [name, dir] of local) if (existsSync(join(home, ".local", dir))) apps.push({ name });
    if (existsSync(join(home, ".var", "app", "dev.zed.Zed"))) apps.push({ name: "Zed (Flatpak)" });
  } else if (platform === "win32") {
    // Per-user installer folder (an Inno Setup convention; not checked against a real install).
    const programs = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs") : undefined;
    if (programs)
      for (const name of names) if (existsSync(join(programs, name))) apps.push({ name });
  }
  return apps;
}

function readTextSafe(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

interface LogRecord {
  t: number;
  event: string;
  pid?: number;
  [key: string]: unknown;
}

/** Rewake's log records from the last `days` days, oldest first (only the newest files are read). */
export function recentLogs(state: string, now: number, days = 14): LogRecord[] {
  const dir = join(state, "logs");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^rewake-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const since = now - days * DAY;
  const cutoff = new Date(since - DAY).toISOString().slice(0, 10);
  const out: LogRecord[] = [];
  for (const f of files.sort()) {
    if (f.slice(7, 17) < cutoff) continue;
    for (const line of readTextSafe(join(dir, f)).split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        const t = typeof r.t === "string" ? Date.parse(r.t) : Number.NaN;
        if (typeof r.event === "string" && t >= since)
          out.push({ ...r, t, event: r.event } as LogRecord);
      } catch {
        // A torn or foreign line: skipped.
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function readSettings(file: string): {
  state: "missing" | "invalid" | "ok";
  value: Record<string, unknown>;
} {
  if (!existsSync(file)) return { state: "missing", value: {} };
  const errors: ParseError[] = [];
  const value = parse(readText(file) || "{}", errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) return { state: "invalid", value: {} };
  return { state: "ok", value };
}

/** Where a setting is turned on: the main settings, or a channel or OS section of them. */
function sectionsSetting(
  settings: Record<string, unknown>,
  platform: NodeJS.Platform,
  test: (s: Record<string, unknown>) => boolean,
  channels: readonly string[] = CHANNELS,
): string[] {
  const where: string[] = [];
  if (test(settings)) where.push("");
  const osKey = OS_KEYS[platform];
  for (const key of [...channels, ...(osKey ? [osKey] : [])]) {
    const section = settings[key];
    if (isRecord(section) && test(section)) where.push(key);
  }
  return where;
}

const inWhere = (where: string[]) =>
  where.map((w) => (w ? `the "${w}" section of Zed's settings` : "Zed's settings")).join(" and ");

export function diagnose(ctx: DoctorContext): Finding[] {
  const { env, now, platform } = ctx;
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const zedDir = zedConfigDir(env);
  const state = stateDir(env);
  const panel = `Zed's Agent Panel (${agentPanelKey(platform)})`;
  const install = `npx ${"@codizelabs/agent-rewake"} install`;
  // Updating: `@latest`, because a bare `npx <package>` may run a copy npx cached earlier.
  const update = `npx ${"@codizelabs/agent-rewake"}@latest install`;

  // Other coding agents on this computer, and whether the line about them was shown yet.
  const reach = otherAgentsNote(ctx.agents?.() ?? [], ctx.previews?.() ?? []);
  let reachShown = false;

  // ---- Zed ------------------------------------------------------------------------------------
  const apps = ctx.zedApps();
  const settingsFile = join(zedDir, "settings.json");
  const settings = readSettings(settingsFile);
  if (apps.length > 0) {
    const old = apps.filter((a) => a.version && compareVersions(a.version, MIN_ZED) < 0);
    const label = apps.map((a) => (a.version ? `${a.name} ${a.version}` : a.name)).join(", ");
    if (old.length > 0)
      add({
        area: "Zed",
        level: "problem",
        text: `Found ${label}. Rewake needs Zed ${MIN_ZED.replace(/\.0$/, "")} or newer.`,
        fix: 'Update Zed: in Zed, run the command "zed: check for updates", or download it from zed.dev.',
      });
    else add({ area: "Zed", level: "ok", text: `Found ${label}.` });
  } else if (settings.state === "missing") {
    add({
      area: "Zed",
      level: "problem",
      text: "Zed doesn't seem to be installed on this computer (no Zed app and no Zed settings).",
      fix: "Install Zed from zed.dev, open it once, then run the install command again.",
    });
  }
  if (settings.state === "missing" && apps.length > 0)
    add({
      area: "Zed",
      level: "todo",
      text: "Zed hasn't saved any settings yet.",
      fix: `Open Zed once, then run: ${install}`,
    });
  if (settings.state === "invalid")
    add({
      area: "Zed",
      level: "problem",
      text: "Zed's settings file has a mistake in it, so neither Zed nor Rewake can read all of it.",
      fix: 'In Zed, run "zed: open settings file", fix the part Zed underlines, then run doctor again.',
    });
  const s = settings.value;
  // A channel's section matters only for that edition of Zed, if it's installed (all of them
  // when the apps can't be found, as on Linux without the install script).
  const edition: Record<string, string> = {
    stable: "Zed",
    preview: "Zed Preview",
    nightly: "Zed Nightly",
    dev: "Zed Dev",
  };
  const channels =
    apps.length === 0 || apps.some((a) => a.name.startsWith("Zed ("))
      ? CHANNELS
      : CHANNELS.filter((c) => apps.some((a) => a.name === edition[c]));
  const aiOff = sectionsSetting(s, platform, (x) => x.disable_ai === true, channels);
  const agentOff = sectionsSetting(
    s,
    platform,
    (x) => isRecord(x.agent) && x.agent.enabled === false,
    channels,
  );
  if (aiOff.length > 0)
    add({
      area: "Zed",
      level: "problem",
      text: `Zed's AI features are turned off (disable_ai in ${inWhere(aiOff)}), so the Agent Panel and Rewake can't run.`,
      fix: 'Remove "disable_ai": true from Zed\'s settings (zed: open settings file).',
    });
  if (agentOff.length > 0)
    add({
      area: "Zed",
      level: "problem",
      text: `Zed's agent is turned off ("agent": { "enabled": false } in ${inWhere(agentOff)}), so the Agent Panel can't run.`,
      fix: "Remove that line from Zed's settings (zed: open settings file).",
    });
  if (aiOff.length === 0 && agentOff.length === 0 && settings.state === "ok")
    add({ area: "Zed", level: "ok", text: "Zed's AI features and Agent Panel are on." });

  // ---- Rewake: which agents have it -------------------------------------------------------------
  const setup = detectSetup(zedDir, state);
  const names = (ids: string[]) => ids.map((id) => agentName(id, env)).join(", ");
  const servers = isRecord(s.agent_servers) ? s.agent_servers : {};
  if (Number.parseInt(ctx.nodeVersion, 10) < MIN_NODE)
    add({
      area: "Rewake",
      level: "problem",
      text: `This terminal's Node.js is ${ctx.nodeVersion}; Rewake needs Node.js ${MIN_NODE} or newer.`,
      fix: "Install a current Node.js from nodejs.org, then run the install command again.",
    });
  try {
    resolveClaudeAdapter();
  } catch {
    add({
      area: "Rewake",
      level: "problem",
      text: "Rewake's copy of the Claude adapter is missing.",
      fix: `Run the install command again: ${install}`,
    });
  }
  if (setup.withRewake.length === 0) {
    add({
      area: "Rewake",
      level: "todo",
      text:
        setup.agents.length > 0
          ? `Rewake isn't added to your agents yet (${names(setup.agents)}).`
          : "Rewake isn't set up yet, and Zed has no external agents yet.",
      fix:
        setup.agents.length > 0
          ? `Run: ${install}`
          : `Run: ${install}  (it offers to add Claude Agent, Claude in Zed's Agent Panel)`,
    });
  } else {
    add({ area: "Rewake", level: "ok", text: `Rewake is on for: ${names(setup.withRewake)}.` });
  }
  if (ctx.launch && settings.state === "ok") {
    const plan = planInstall({
      dir: zedDir,
      launch: ctx.launch,
      keybinding: false,
      env,
      stateDir: state,
    });
    const missing = setup.agents.filter((id) => !setup.withRewake.includes(id));
    const skipped = new Map<string, string>();
    for (const n of plan.notes) {
      const m = /: "([^"]+)"[^:]* left as is: (.+)\.$/.exec(n);
      if (m?.[1] && m[2]) skipped.set(m[1], m[2]);
    }
    const addable = missing.filter((id) => !skipped.has(id));
    if (addable.length > 0 && setup.withRewake.length > 0)
      add({
        area: "Rewake",
        level: "todo",
        text: `Not on yet for: ${names(addable)}.`,
        fix: `Run: ${install}`,
      });
    const noRegistry = !existsSync(
      join(zedDataDir(env), "external_agents", "registry", "registry.json"),
    );
    for (const [id, why] of skipped) {
      if (noRegistry && /copy of the ACP Registry/.test(why)) continue; // reported once, below
      add({
        area: "Rewake",
        level: "info",
        text: `${agentName(id, env)} can't have Rewake yet: ${why}.`,
      });
    }
  }
  if (missingLaunchFiles(zedDir).length > 0)
    add({
      area: "Rewake",
      level: "problem",
      text: "Zed would start Rewake with a Node.js or a Rewake copy that has moved or been removed (after a Node.js upgrade, for example), so those agents won't start.",
      fix: `Run the install command again to update Zed's settings: ${update}`,
    });

  // Which version Zed starts, from the pinned `@codizelabs/agent-rewake@<version>` argument.
  const pins = new Set<string>();
  for (const entry of Object.values(servers)) {
    if (!isRecord(entry) || unwrappedEntry(entry) === undefined) continue;
    const pin = pinnedVersion(entry);
    if (pin) pins.add(pin);
  }
  for (const pin of pins) {
    if (compareVersions(pin, ctx.version) < 0)
      add({
        area: "Rewake",
        level: "todo",
        text: `Zed starts Rewake ${pin}; this is Rewake ${ctx.version}.`,
        fix: `To update, run: ${update}  Then quit Zed completely and open it again.`,
      });
    else if (compareVersions(pin, ctx.version) > 0)
      add({
        area: "Rewake",
        level: "info",
        text: `Zed starts Rewake ${pin}, newer than this check (${ctx.version}). For an up-to-date check, run: npx @codizelabs/agent-rewake@latest doctor`,
      });
  }

  // Channel or OS sections that set one of Rewake's agents again, replacing its entry.
  for (const key of [...CHANNELS, OS_KEYS[platform] ?? ""]) {
    const section = key ? s[key] : undefined;
    if (!isRecord(section) || !isRecord(section.agent_servers)) continue;
    for (const [id, entry] of Object.entries(section.agent_servers)) {
      if (!setup.withRewake.includes(id) || unwrappedEntry(entry) !== undefined) continue;
      add({
        area: "Rewake",
        level: "todo",
        text: `The "${key}" section of Zed's settings sets ${agentName(id, env)} again, without Rewake, and Zed uses that one.`,
        fix: `Remove ${agentName(id, env)} from the "${key}" section of Zed's settings, or run: ${install}`,
      });
    }
  }

  // Zed's cached agent list: needed for every registry agent except Claude (Rewake bundles it).
  const registryIds = Object.entries(servers)
    .filter(([id, e]) => isRecord(e) && id !== CLAUDE_REGISTRY_ID && id !== AGENT_NAME)
    .filter(
      ([, e]) =>
        isRecord(e) && (e.type === "registry" || (unwrappedEntry(e)?.type ?? "") === "registry"),
    )
    .map(([id]) => id);
  if (
    registryIds.length > 0 &&
    !existsSync(join(zedDataDir(env), "external_agents", "registry", "registry.json"))
  )
    add({
      area: "Zed",
      level: "todo",
      text: `Zed hasn't downloaded its list of agents yet, which ${names(registryIds)} need${registryIds.length === 1 ? "s" : ""}.`,
      fix: `Open ${panel} once while online, then run doctor again.`,
    });

  // Settings that change what Rewake does, set on an agent or in the shell (Zed passes the
  // shell's environment to agents).
  for (const [id, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || unwrappedEntry(entry) === undefined) continue;
    const envBlock = isRecord(entry.env) ? entry.env : {};
    const who = agentName(id, env);
    if (envBlock.AGENT_REWAKE_ALLOW_AUTO === "0")
      add({
        area: "Rewake",
        level: "info",
        text: `Automatic resume is off for ${who} (AGENT_REWAKE_ALLOW_AUTO=0 in its Zed settings). Rewake still asks at each limit.`,
      });
    if (envBlock.AGENT_REWAKE_AGENT_TOOLS === "0")
      add({
        area: "Rewake",
        level: "info",
        text: `${who} can't suggest schedules (AGENT_REWAKE_AGENT_TOOLS=0 in its Zed settings). The Rewake menu still works.`,
      });
    if (
      id === CLAUDE_REGISTRY_ID &&
      typeof envBlock.ANTHROPIC_API_KEY === "string" &&
      envBlock.ANTHROPIC_API_KEY !== ""
    )
      add({
        area: "Sign-in",
        level: "todo",
        text: "Zed's settings give Claude Agent an Anthropic API key, but Zed clears that key when Claude Agent runs through Rewake, so Claude uses your Claude sign-in instead.",
        fix: `To keep using your Claude sign-in, remove the key from Claude Agent in Zed's settings. To use the API key instead, Rewake can't pass it on yet: run "${rewake("uninstall")}" for Claude Agent's setup without Rewake.`,
      });
  }
  if (env.AGENT_REWAKE_ALLOW_AUTO === "0")
    add({
      area: "Rewake",
      level: "info",
      text: "Automatic resume is off: AGENT_REWAKE_ALLOW_AUTO=0 is set in your shell, which Zed passes to agents.",
    });

  // ---- Rewake: has Zed started it, and can it write its files? ---------------------------------
  const logs = recentLogs(state, now);
  const starts = logs.filter((r) => r.event === "proxy.start");
  const lastStart = setup.lastStart;
  if (setup.withRewake.length > 0 && aiOff.length === 0 && agentOff.length === 0) {
    if (lastStart) {
      const who = lastStart.agent === "default" ? "Claude Agent" : agentName(lastStart.agent, env);
      add({
        area: "Rewake",
        level: "ok",
        text: `Working: Zed last started it ${when(lastStart.at, now)}, for ${who}.`,
      });
    } else {
      const one = setup.withRewake.length === 1 ? names(setup.withRewake) : "one of these agents";
      add({
        area: "Rewake",
        level: "todo",
        text: "Installed, but Zed hasn't started Rewake yet. Zed starts it when you open a thread with the agent, not when Zed starts.",
        fix: `Open ${panel} and start a thread with ${one}. If it still doesn't start, ${quitZed(platform)}, open it again and try once more.`,
      });
      // With other agents found here, the specific line says this and names them.
      if (reach) {
        add({ area: "Rewake", level: "info", text: reach });
        reachShown = true;
      } else
        add({
          area: "Rewake",
          level: "info",
          text: `Rewake works only in Zed's Agent Panel, with external agents such as Claude Agent, Codex and Gemini CLI. It can't reach Zed's own agent${setup.usesZedAgent ? " (your settings pick a model for it)" : ""}, the Claude desktop app, claude.ai, or Claude Code in a terminal; Claude Code and the desktop app have their own setting to continue after a usage limit.`,
        });
      add({
        area: "Rewake",
        level: "info",
        text: "Working in an SSH or WSL project? There, Zed runs agents on the other machine, so install Rewake on that machine too.",
      });
    }
  }
  const lastNode = [...starts].reverse().find((r) => typeof r.node === "string")?.node as
    | string
    | undefined;
  if (lastNode && Number.parseInt(lastNode, 10) < MIN_NODE)
    add({
      area: "Rewake",
      level: "problem",
      text: `Zed starts Rewake with Node.js ${lastNode}; Rewake needs Node.js ${MIN_NODE} or newer.`,
      fix: `Install a current Node.js, then run: ${install}`,
    });
  if (!canWrite(state))
    add({
      area: "Rewake",
      level: "problem",
      text: "Rewake can't write to its own folder, so it can't save scheduled messages or settings.",
      fix: "Check the folder's permissions (doctor --details shows where it is).",
    });

  // ---- Sign-in: the kind each agent last reported ----------------------------------------------
  const agentOfPid = new Map<number, string>();
  for (const r of logs)
    if (r.event === "proxy.start" && typeof r.pid === "number")
      agentOfPid.set(r.pid, typeof r.agent === "string" ? r.agent : "default");
  const whoOf = (r: LogRecord) => {
    const id =
      typeof r.agent === "string" && r.event !== "agent_tools.refused"
        ? r.agent
        : typeof r.pid === "number"
          ? agentOfPid.get(r.pid)
          : undefined;
    return !id || id === "default" ? "Claude Agent" : agentName(id, env);
  };
  const auth = new Map<string, string>();
  for (const r of logs)
    if (r.event === "agent.auth" && typeof r.kind === "string") auth.set(whoOf(r), r.kind);
  for (const [who, kind] of auth) {
    if (kind === "account")
      add({ area: "Sign-in", level: "ok", text: `${who} is signed in with an account.` });
    else if (kind === "none")
      add({
        area: "Sign-in",
        level: "todo",
        text: `${who} wasn't signed in the last time it ran.`,
        fix: `Open a thread with ${who} in ${panel} and sign in when it asks.`,
      });
    else
      add({
        area: "Sign-in",
        level: "info",
        text: `${who} uses ${kind === "api_key" ? "an API key" : kind === "gateway" ? "a gateway" : "a cloud provider"}: billed per use, with rate limits rather than usage windows, so resuming after a limit rarely applies. Scheduled messages still work.`,
      });
  }

  // ---- Scheduled messages ------------------------------------------------------------------------
  // Zed's own; resumes of agents outside Zed are under "Outside Zed" (src/hosts/doctor.ts).
  const schedules = new ScheduleStore(state).list().filter((x) => !x.host);
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const overdue = schedules.filter(
    (x) => (x.status === "scheduled" || x.status === "queued") && x.dueAt < now - 60_000,
  );
  const needsYou = schedules.filter((x) => x.status === "needs_attention");
  const failed = schedules.filter((x) => x.status === "failed" && x.dueAt > now - 7 * DAY);
  const missed = schedules.filter((x) => x.status === "missed" && x.dueAt > now - 7 * DAY);
  const upcoming = schedules
    .filter(
      (x) =>
        (x.status === "scheduled" || x.status === "waiting_for_limit") && x.dueAt >= now - 60_000,
    )
    .sort((a, b) => a.dueAt - b.dueAt);
  if (overdue.length > 0)
    add({
      area: "Scheduled messages",
      level: "todo",
      text: `${count(overdue.length, "message")} ${overdue.length === 1 ? "is" : "are"} past due. Rewake sends only while Zed is open with that thread's agent running.`,
      fix: `Open Zed and the thread in ${panel}; Rewake sends it then; if it's more than 15 minutes late, it asks first (a repeating message skips to its next run).`,
    });
  if (needsYou.length > 0)
    add({
      area: "Scheduled messages",
      level: "todo",
      text: `${count(needsYou.length, "message")} need${needsYou.length === 1 ? "s" : ""} you (for example the reply was cut off, or the next reset is more than a day away).`,
      fix: `Open the thread and use the Rewake menu, or run: ${rewake("ui")}`,
    });
  if (failed.length > 0)
    add({
      area: "Scheduled messages",
      level: "info",
      text: `${count(failed.length, "message")} failed in the last 7 days. The thread shows the agent's reason.`,
    });
  if (missed.length > 0)
    add({
      area: "Scheduled messages",
      level: "info",
      text: `${count(missed.length, "message")} ${missed.length === 1 ? "was" : "were"} missed in the last 7 days (Zed or the computer was off at the time).`,
    });
  const next = upcoming[0];
  if (next)
    add({
      area: "Scheduled messages",
      level: "ok",
      text: `${count(upcoming.length, "message")} scheduled; the next one ${when(next.dueAt, now)}. Keep Zed open with the thread's agent running then.`,
    });

  // Automatic resume switched off by a choice somewhere.
  const settingsRewake = loadSettings(state);
  if (settingsRewake.newThreads === "off")
    add({
      area: "Rewake",
      level: "info",
      text: "New threads don't offer automatic resume (you chose Never). Rewake still asks at each limit.",
      fix: "To change it: Rewake menu → Settings…",
    });
  if (setup.withRewake.includes(CLAUDE_REGISTRY_ID) && claudeAutoContinueDisabled(env, ""))
    add({
      area: "Rewake",
      level: "info",
      text: 'Automatic resume is off for Claude: Claude Code\'s "Continue automatically at usage limit" setting is off, and Rewake follows it. Rewake still asks at each limit.',
    });

  // ---- Recently: problems in Rewake's logs (last 14 days) --------------------------------------
  const failedStarts = new Map<string, { n: number; last: number }>();
  const crashes = new Map<string, { n: number; last: number }>();
  const bump = (m: Map<string, { n: number; last: number }>, who: string, t: number) => {
    const v = m.get(who) ?? { n: 0, last: 0 };
    m.set(who, { n: v.n + 1, last: Math.max(v.last, t) });
  };
  let lostSessions = 0;
  let unrecoverable = 0;
  for (const r of logs) {
    if (r.event === "agent.spawn_failed" || r.event === "agent.resolve_failed")
      bump(failedStarts, whoOf(r), r.t);
    if (r.event === "proxy.exit" && r.reason === "agent_exited" && r.code !== 0)
      bump(crashes, whoOf(r), r.t);
    if (r.event === "reattach.unavailable" || (r.event === "reattach.done" && r.ok === false))
      lostSessions++;
    if (r.event === "schedule.settled" && r.outcome === "not_recoverable") unrecoverable++;
  }
  const lastGoodStart = new Map<string, number>();
  for (const r of starts) lastGoodStart.set(whoOf(r), r.t);
  for (const [who, v] of failedStarts) {
    // A start after the last failure that wasn't followed by another failure: it works again.
    const fixed = (lastGoodStart.get(who) ?? 0) > v.last + 60_000;
    add({
      area: "Recently",
      level: fixed ? "info" : "problem",
      text: `${who} couldn't start ${count(v.n, "time")}, last ${when(v.last, now)}${fixed ? "; it has started since" : ""}.`,
      ...(!fixed && {
        fix: `Reopen the thread. If it keeps failing, run the install command again (${install}), or check that ${who} starts without Rewake (${rewake("uninstall")}).`,
      }),
    });
  }
  for (const [who, v] of crashes)
    add({
      area: "Recently",
      level: "info",
      text: `${who} stopped unexpectedly ${count(v.n, "time")}, last ${when(v.last, now)}. Rewake restarts it up to 3 times in 10 minutes.`,
    });
  if (lostSessions > 0)
    add({
      area: "Recently",
      level: "info",
      text: `An agent lost a conversation and couldn't reopen it (${count(lostSessions, "time")}). Starting a new thread, or Zed's "Reload Agent", fixes it.`,
    });
  if (unrecoverable > 0)
    add({
      area: "Recently",
      level: "todo",
      text: `${count(unrecoverable, "scheduled message")} failed for a reason waiting won't fix, such as sign-in or billing.`,
      fix: "Open the thread to see the agent's message.",
    });

  // ---- Other coding agents here: say plainly that Rewake doesn't reach them on their own ------
  if (reach && !reachShown) add({ area: "Rewake", level: "info", text: reach });

  if (ctx.sleep) for (const f of sleepFindings(ctx.sleep())) add(f);
  return findings;
}

/** Whether Rewake can write to its folder. A folder that doesn't exist yet isn't created here. */
function canWrite(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    const probe = join(dir, `.doctor-${process.pid}.tmp`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** "today at 4:47 PM", "tomorrow at 9:00 AM", or "on Oct 3 at 9:00 AM". */
/** Whether this computer's own settings let it sleep while a resume waits, and what to change. */
export function sleepFindings(o: {
  settings: SleepSettings;
  hold: "plugged-in" | "always" | "none";
}): Finding[] {
  const s = o.settings;
  const area: Area = "Sleep settings";
  if (s.pluggedInSleepMin === undefined && s.onBattery === undefined && s.lid === undefined)
    return [
      {
        area,
        level: "info",
        text: "This computer's sleep settings couldn't be read.",
        fix: `To keep it awake while a resume waits, see ${SLEEP_DOCS_URL}`,
      },
    ];
  const findings: Finding[] = [];
  const risks = sleepRisks(s, o.hold);
  if (risks.length > 0)
    findings.push({
      area,
      level: "todo",
      text: `This computer may sleep while a resume waits: ${risks.join("; ")}.`,
      fix: s.managed
        ? `Your organisation sets this; ask your IT team. What to ask for: ${SLEEP_DOCS_URL}`
        : `Set it not to sleep when plugged in (the screen can still turn off): ${SLEEP_DOCS_URL}`,
    });
  else
    findings.push({
      area,
      level: "ok",
      text:
        o.hold !== "none" && (s.pluggedInSleepMin ?? 0) > 0
          ? "While it's plugged in, Rewake keeps this computer awake for resumes due within six hours."
          : "This computer doesn't sleep on its own while plugged in.",
    });
  if (s.lid === "sleep")
    findings.push({
      area,
      level: "info",
      text: "Closing the lid puts this computer to sleep: keep it open while a resume is due.",
    });
  return findings;
}

export function when(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString(TEXT_LOCALE, { hour: "numeric", minute: "2-digit" });
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return `today at ${time}`;
  if (day(at) === day(now + DAY)) return `tomorrow at ${time}`;
  if (day(at) === day(now - DAY)) return `yesterday at ${time}`;
  const date = new Date(at).toLocaleDateString(TEXT_LOCALE, { month: "short", day: "numeric" });
  return `on ${date} at ${time}`;
}

const AREAS: Area[] = [
  "Zed",
  "Rewake",
  "Sign-in",
  "Scheduled messages",
  "Sleep settings",
  "Outside Zed",
  "Recently",
];

/** The report people read. ASCII marks where the terminal may not show symbols. */
export function render(
  findings: Finding[],
  opts: { version: string; ascii: boolean; details?: string[] },
): string {
  const mark: Record<Level, string> = opts.ascii
    ? { ok: "ok", info: "--", todo: "!!", problem: "XX" }
    : { ok: "✓", info: "•", todo: "!", problem: "✗" };
  const lines = [`Agent Rewake ${opts.version}: checking your setup`];
  for (const area of AREAS) {
    const items = findings.filter((f) => f.area === area);
    if (items.length === 0) continue;
    lines.push("", area);
    for (const f of items) {
      lines.push(`  ${mark[f.level]} ${f.text}`);
      if (f.fix) lines.push(`    ${opts.ascii ? "->" : "→"} ${f.fix}`);
    }
  }
  if (opts.details)
    lines.push("", "Details (for bug reports)", ...opts.details.map((d) => `  ${d}`));
  const problems = findings.filter((f) => f.level === "problem").length;
  const todos = findings.filter((f) => f.level === "todo").length;
  const first =
    findings.find((f) => f.level === "problem" && f.fix) ??
    findings.find((f) => f.level === "todo" && f.fix);
  lines.push("");
  if (problems === 0 && todos === 0) lines.push("All set: nothing to do.");
  else {
    const parts = [
      problems > 0 && `${problems} problem${problems === 1 ? "" : "s"}`,
      todos > 0 && `${todos} thing${todos === 1 ? "" : "s"} to do`,
    ].filter(Boolean);
    lines.push(`${parts.join(" and ")}.${first?.fix ? ` Start here: ${first.fix}` : ""}`);
  }
  if (!opts.details) lines.push(`More detail for a bug report: ${rewake("doctor --details")}`);
  return `${lines.join("\n")}\n`;
}

/** Versions and folders for `--details`, the home folder shortened to ~. No values of settings. */
export function detailLines(ctx: DoctorContext): string[] {
  const { env } = ctx;
  const tilde = (p: string) =>
    ctx.home && p.startsWith(ctx.home) ? `~${p.slice(ctx.home.length)}` : p;
  const state = stateDir(env);
  const setup = detectSetup(zedConfigDir(env), state);
  let adapter = "not found";
  try {
    adapter = resolveClaudeAdapter().version;
  } catch {
    // reported above
  }
  const starts = recentLogs(state, ctx.now).filter((r) => r.event === "proxy.start");
  const last = starts[starts.length - 1];
  const lines = [
    `Rewake ${ctx.version}; Node.js ${ctx.nodeVersion}; ${ctx.platform} ${process.arch}`,
    `Claude adapter: ${adapter}`,
    `Zed apps: ${
      ctx
        .zedApps()
        .map((a) => `${a.name} ${a.version ?? "(version unknown)"}`)
        .join(", ") || "none found"
    }`,
    `Zed settings folder: ${tilde(zedConfigDir(env))}`,
    `Zed data folder: ${tilde(zedDataDir(env))}`,
    `Rewake's folder: ${tilde(state)}`,
    `Agents in Zed's settings: ${setup.agents.join(", ") || "none"}; with Rewake: ${setup.withRewake.join(", ") || "none"}`,
    `Other coding agents: ${
      ctx
        .agents?.()
        .map((a) => `${a.name} ${a.version ?? "(version unknown)"} [${a.surfaces.join(", ")}]`)
        .join(", ") || "none found"
    }`,
    `Last start: ${last ? `${new Date(last.t).toISOString()}, Rewake ${String(last.version ?? "?")}, Node.js ${String(last.node ?? "?")}` : "none in the last 14 days"}`,
  ];
  const set = Object.keys(env).filter((k) => k.startsWith("AGENT_REWAKE_"));
  if (set.length > 0) lines.push(`Rewake variables set in this shell: ${set.sort().join(", ")}`);
  if (env.ANTHROPIC_API_KEY)
    lines.push(
      env.AGENT_REWAKE_KEEP_API_KEY === "1"
        ? "Anthropic API key in this shell: passed on to Claude Agent (AGENT_REWAKE_KEEP_API_KEY=1)."
        : "Anthropic API key in this shell: not passed on, so Claude Agent uses your Claude sign-in, as Zed does.",
    );
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)
    lines.push("A proxy is set in this shell.");
  return lines;
}
