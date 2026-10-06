import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, delimiter, dirname, join, posix, win32 } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  applyEdits,
  type FormattingOptions,
  modify,
  type ParseError,
  parse,
  printParseErrorCode,
} from "jsonc-parser";
import { MENU_CONFIG_ID } from "./addon.js";
import { ThreadStore } from "./core/threads.js";
import { pluginDir as antigravityPluginDir } from "./hosts/antigravity/install.js";
import { modInstalled } from "./hosts/claude-code/install.js";
import { pluginInstalled } from "./hosts/codex/plugin.js";
import { hooksFile } from "./hosts/copilot/install.js";
import { grokHooksFile } from "./hosts/grok/install.js";
import { detectAgents, type Found, otherAgentsNote, withoutInstalled } from "./install/detect.js";
import { readText, renameWithRetry } from "./util/fs.js";
import { ensurePrivateDir, stateDir, zedConfigDir } from "./util/paths.js";
import { findOnWindows, npmScript } from "./util/spawn.js";
import { PACKAGE_NAME, REPO_URL, VERSION } from "./version.js";
import {
  CLAUDE_REGISTRY_ID,
  canWrapRegistry,
  registryAgent,
  WRAP_COMMAND,
  WRAP_REGISTRY,
  type WrapTarget,
  wrapArgs,
} from "./wrap.js";

/**
 * The separate External Agent that earlier versions added. Rewake now wraps the agents Zed already
 * has, under their own ids, so install removes this entry.
 */
export const AGENT_NAME = "Agent Rewake";

export const TASK_LABEL = "Agent Rewake: schedules";

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

export { zedConfigDir } from "./util/paths.js";

export interface LaunchCommand {
  command: string;
  args: string[];
}

/**
 * How Zed should start Rewake. Run from npx's temporary cache, a fixed path would vanish when the
 * cache is cleaned, so Zed gets a pinned npx command instead, run as `node npx-cli.js` so it's the
 * same on every OS (no `npx.cmd` on Windows). Otherwise the absolute Node binary and the real path
 * of this script (Zed doesn't read your shell's PATH).
 */
export function launchCommand(
  execPath: string = stableNode(),
  script: string = process.argv[1] ?? "",
  npxCli: string | undefined = npmScript("npx-cli.js", execPath),
): LaunchCommand {
  const real = existsSync(script) ? realpathSync(script) : script;
  if (/[\\/]_npx[\\/]/.test(real)) {
    const pinned = ["--yes", `${PACKAGE_NAME}@${VERSION}`];
    if (npxCli) return { command: execPath, args: [npxCli, ...pinned] };
    const npx = join(dirname(execPath), platform() === "win32" ? "npx.cmd" : "npx");
    return { command: existsSync(npx) ? npx : "npx", args: pinned };
  }
  return { command: execPath, args: [real] };
}

/**
 * The Node binary to write into Zed's settings: the `node` on PATH when it is this same binary by
 * another, stable name (Homebrew's /opt/homebrew/bin/node instead of a versioned Cellar path that
 * an upgrade deletes), otherwise this process's own.
 */
export function stableNode(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  p: NodeJS.Platform = platform(),
): string {
  const real = (f: string) => {
    try {
      return realpathSync(f);
    } catch {
      return undefined;
    }
  };
  const self = real(execPath);
  const candidates =
    p === "win32"
      ? [findOnWindows("node", env, existsSync)]
      : (env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((d) => join(d, "node"));
  for (const c of candidates) if (c && c !== execPath && self && real(c) === self) return c;
  return execPath;
}

/**
 * How this running Rewake starts another copy of itself: its
 * own Node and script, which exist for as long as it runs. Never npx, which would mean a `.cmd` on
 * Windows and a registry check for every thread.
 */
export function selfCommand(
  execPath: string = process.execPath,
  script: string = process.argv[1] ?? "",
): LaunchCommand {
  return { command: execPath, args: [existsSync(script) ? realpathSync(script) : script] };
}

/**
 * An `agent_servers` entry that runs `target` through Rewake, keeping everything else the user set
 * on it (env, default mode, default config options, favourites).
 */
export function wrappedEntry(
  original: Record<string, unknown>,
  target: WrapTarget,
  launch: LaunchCommand,
): Record<string, unknown> {
  const { type: _type, command: _command, args: _args, ...rest } = original;
  return {
    ...rest,
    type: "custom",
    command: launch.command,
    args: [...launch.args, ...wrapArgs(target)],
  };
}

/** The entry as it was before Rewake wrapped it, or undefined if Rewake didn't wrap it. */
export function unwrappedEntry(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry) || entry.type !== "custom" || !Array.isArray(entry.args)) return undefined;
  const args = entry.args.map(String);
  const i = args.findIndex((a) => a === WRAP_REGISTRY || a === WRAP_COMMAND);
  if (i === -1) return undefined;
  const { command: _command, args: _args, type: _type, ...rest } = entry;
  const options = isRecord(rest.default_config_options) ? rest.default_config_options : undefined;
  if (options && MENU_CONFIG_ID in options) {
    const { [MENU_CONFIG_ID]: _menu, ...others } = options;
    rest.default_config_options = others;
  }
  if (args[i] === WRAP_REGISTRY) return { type: "registry", ...rest };
  try {
    const original = JSON.parse(args[i + 1] ?? "") as { command: string; args?: string[] };
    return { type: "custom", command: original.command, args: original.args ?? [], ...rest };
  } catch {
    return undefined;
  }
}

/** What an agent entry is: already wrapped, wrappable (and how), or not wrappable (and why). */
function wrapTargetFor(
  id: string,
  entry: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): { target: WrapTarget } | { skip: string } {
  if (entry.type === "registry" || entry.type === "extension") {
    if (canWrapRegistry(id, env)) return { target: { kind: "registry", id } };
    const agent = registryAgent(id, env);
    return {
      skip: agent
        ? `it has no build for this computer in the registry (${agent.kind === "other" ? agent.types.join("/") || "none" : agent.kind})`
        : "it isn't in Zed's copy of the ACP Registry yet (open the agent once in Zed, then run install again)",
    };
  }
  if (entry.type === "custom" && typeof entry.command === "string" && entry.command) {
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    return { target: { kind: "command", command: entry.command, args, id } };
  }
  return { skip: "its settings don't name a command" };
}

function agentLabel(id: string, env: NodeJS.ProcessEnv): string {
  const name = registryAgent(id, env)?.name;
  return name && name !== id ? `"${id}" (${name})` : `"${id}"`;
}

/**
 * The schedules page as a Zed task. Zed joins a task's command and args with spaces and doesn't
 * quote them, so a path with a space, such as
 * C:\Program Files\nodejs\node.exe, would break the task. Each part that needs it is quoted
 * here for the shell the task runs in: POSIX quoting on macOS and Linux (bash, zsh and fish all
 * read it), and on Windows the task names cmd as its shell, whose quoting is predictable (the
 * default there is PowerShell, which needs `&` before a quoted command).
 */
export function taskEntry(
  launch: LaunchCommand,
  p: NodeJS.Platform = platform(),
): Record<string, unknown> {
  const quote = p === "win32" ? quoteForCmdTask : quoteForPosix;
  return {
    label: TASK_LABEL,
    command: quote(launch.command),
    args: [...launch.args, "ui"].map(quote),
    ...(p === "win32" && { shell: { program: "cmd" } }),
    reveal: "always",
    use_new_terminal: false,
  };
}

const quoteForPosix = (s: string): string =>
  /^[\w/.,:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;

// Windows paths can't contain double quotes, so wrapping in them is enough for cmd.
const quoteForCmdTask = (s: string): string => (/^[\w\\/.:@+=-]+$/.test(s) ? s : `"${s}"`);

export function keyChord(): string {
  return platform() === "darwin" ? "cmd-alt-r" : "ctrl-alt-r";
}

const KEY_ACTION = ["task::Spawn", { task_name: TASK_LABEL }];

/** One planned edit to one of Zed's files. */
export interface FileChange {
  file: string;
  existed: boolean;
  before: string;
  after: string;
  /** Plain-language lines for the confirmation summary. */
  summary: string[];
}

export interface Plan {
  changes: FileChange[];
  /** Files left alone, and why (already set up, can't be parsed, key already bound…). */
  notes: string[];
}

function read(file: string): { text: string; existed: boolean } {
  return existsSync(file) ? { text: readText(file), existed: true } : { text: "", existed: false };
}

function parseJsonc(text: string): { value: unknown; error?: string } {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  const first = errors[0];
  return first
    ? { value, error: `${printParseErrorCode(first.error)} at offset ${first.offset}` }
    : { value };
}

/**
 * One of an agent's own settings in Zed (`agent_servers.<id>.<key>`), or undefined. Used for
 * `default_mode`, which Zed applies only to its legacy mode picker.
 */
export function zedAgentSetting(
  agentId: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  const file = join(zedConfigDir(env), "settings.json");
  if (!existsSync(file)) return undefined;
  const value = parseJsonc(readText(file)).value as Record<string, unknown> | undefined;
  const servers = value && typeof value === "object" ? value.agent_servers : undefined;
  const entry =
    servers && typeof servers === "object"
      ? (servers as Record<string, unknown>)[agentId]
      : undefined;
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>)[key] : undefined;
}

function edit(text: string, path: (string | number)[], value: unknown, insert = false): string {
  return applyEdits(
    text,
    modify(text, path, value, { formattingOptions: FORMAT, isArrayInsertion: insert }),
  );
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isOurKeyBlock(v: unknown): boolean {
  if (!isRecord(v) || !isRecord(v.bindings)) return false;
  return Object.values(v.bindings).some((action) => same(action, KEY_ACTION));
}

export interface InstallOptions {
  dir: string;
  launch: LaunchCommand;
  keybinding: boolean;
  /** Only wrap these agent ids (default: every agent Rewake can wrap). */
  only?: string[];
  /** Environment used to find Zed's data directory and registry cache. */
  env?: NodeJS.ProcessEnv;
  /** Rewake's state directory, to find threads started with the earlier separate agent. */
  stateDir?: string;
}

/** The earlier separate agent, kept as Claude Agent with Rewake so its threads keep opening. */
function legacyEntry(launch: LaunchCommand): Record<string, unknown> {
  return wrappedEntry({}, { kind: "registry", id: CLAUDE_REGISTRY_ID }, launch);
}

function legacyNote(settingsFile: string): string {
  return `${settingsFile}: "${AGENT_NAME}" is kept only so threads you started with it still open. Use your usual agents for new threads.`;
}

/**
 * Threads seen by a build before agents were recorded per thread: those were started with the
 * separate "Agent Rewake" agent, the only way Rewake ran then.
 */
function hasLegacyThreads(stateDir: string): boolean {
  return new ThreadStore(stateDir).list().some((t) => t.agentId === undefined);
}

/** The Rewake version an agent entry pins (`@codizelabs/agent-rewake@<version>`), if it pins one. */
export function pinnedVersion(entry: unknown): string | undefined {
  const args = isRecord(entry) && Array.isArray(entry.args) ? entry.args : [];
  const prefix = `${PACKAGE_NAME}@`;
  for (const a of args)
    if (typeof a === "string" && a.startsWith(prefix)) return a.slice(prefix.length);
  return undefined;
}

/** Work out every edit `install` would make, without touching the disk. */
export function planInstall(opts: InstallOptions): Plan {
  const changes: FileChange[] = [];
  const notes: string[] = [];

  // 1. settings.json: wrap each External Agent in place, under its own id, so its threads stay.
  const env = opts.env ?? process.env;
  const settingsFile = join(opts.dir, "settings.json");
  const settings = read(settingsFile);
  const base = settings.text.trim() === "" ? "{}\n" : settings.text;
  const parsed = parseJsonc(base);
  if (parsed.error || !isRecord(parsed.value)) {
    notes.push(
      `${settingsFile}: left alone, it isn't valid JSON (${parsed.error ?? "not an object"}). Fix it in Zed, then run install again.`,
    );
  } else {
    let after = base;
    const summary: string[] = [];
    const servers = isRecord(parsed.value.agent_servers) ? parsed.value.agent_servers : {};
    let wrappedAny = false;
    for (const [id, entry] of Object.entries(servers)) {
      if (!isRecord(entry)) continue;
      if (id === AGENT_NAME) {
        // Kept: Zed ties the threads started with it to this id, and removing it leaves them
        // unopenable ("Custom agent server `Agent Rewake` is not registered").
        const want = legacyEntry(opts.launch);
        if (same(entry, want)) notes.push(legacyNote(settingsFile));
        else {
          after = edit(after, ["agent_servers", AGENT_NAME], want);
          summary.push(
            `Keep "${AGENT_NAME}" from an earlier version (now Claude Agent with Rewake), so the threads you started with it still open. Start new threads with your usual agents`,
          );
        }
        continue;
      }
      if (opts.only && !opts.only.includes(id)) continue;
      const original = unwrappedEntry(entry);
      if (original) {
        wrappedAny = true;
        const target = wrapTargetFor(id, original, env);
        const want =
          "target" in target ? wrappedEntry(original, target.target, opts.launch) : entry;
        if (same(entry, want))
          notes.push(`${settingsFile}: ${agentLabel(id, env)} already has Rewake.`);
        else {
          after = edit(after, ["agent_servers", id], want);
          const from = pinnedVersion(entry);
          const to = pinnedVersion(want);
          summary.push(
            `Update Rewake in ${agentLabel(id, env)}${from && to && from !== to ? ` (from ${from} to ${to})` : ""}`,
          );
        }
        continue;
      }
      const target = wrapTargetFor(id, entry, env);
      if ("skip" in target) {
        notes.push(`${settingsFile}: ${agentLabel(id, env)} left as is: ${target.skip}.`);
        continue;
      }
      wrappedAny = true;
      after = edit(after, ["agent_servers", id], wrappedEntry(entry, target.target, opts.launch));
      summary.push(
        `Add Rewake to ${agentLabel(id, env)}. Its threads, settings and login stay as they are`,
      );
    }
    if (!(AGENT_NAME in servers) && opts.stateDir && hasLegacyThreads(opts.stateDir)) {
      // An earlier install removed it, but threads started with it still need it to open.
      after = edit(after, ["agent_servers", AGENT_NAME], legacyEntry(opts.launch));
      summary.push(
        `Restore "${AGENT_NAME}" from an earlier version (Claude Agent with Rewake): threads you started with it can't open without it`,
      );
    }
    if (!wrappedAny && (!opts.only || opts.only.includes(CLAUDE_REGISTRY_ID))) {
      // No agents yet: set up Claude Agent with Rewake, the way Zed's registry would add it.
      after = edit(
        after,
        ["agent_servers", CLAUDE_REGISTRY_ID],
        wrappedEntry({}, { kind: "registry", id: CLAUDE_REGISTRY_ID }, opts.launch),
      );
      summary.push(
        `Add Claude Agent ("${CLAUDE_REGISTRY_ID}") with Rewake. You have no external agents in Zed yet; Claude Agent is Claude in Zed's Agent Panel, and that's where Rewake works`,
      );
    }
    const agent = isRecord(parsed.value.agent) ? parsed.value.agent : {};
    if (parsed.value.disable_ai === true || agent.enabled === false)
      notes.push(
        `${settingsFile}: Zed's AI features are turned off (${parsed.value.disable_ai === true ? "disable_ai" : "agent.enabled"}), so the Agent Panel and Rewake won't run until you turn them back on.`,
      );
    if (summary.length > 0)
      changes.push({
        file: settingsFile,
        existed: settings.existed,
        before: settings.text,
        after,
        summary: [
          ...summary,
          `    Rewake runs as: ${[opts.launch.command, ...opts.launch.args].join(" ")}`,
        ],
      });
  }

  // 2. tasks.json: the schedules page.
  const tasksFile = join(opts.dir, "tasks.json");
  const tasks = read(tasksFile);
  const tasksBase = tasks.text.trim() === "" ? "[]\n" : tasks.text;
  const tasksParsed = parseJsonc(tasksBase);
  if (tasksParsed.error || !Array.isArray(tasksParsed.value)) {
    notes.push(
      `${tasksFile}: left alone, it isn't a valid task list (${tasksParsed.error ?? "not an array"}).`,
    );
  } else {
    const want = taskEntry(opts.launch);
    const list = tasksParsed.value as unknown[];
    const index = list.findIndex((t) => isRecord(t) && t.label === TASK_LABEL);
    if (index !== -1 && same(list[index], want))
      notes.push(`${tasksFile}: the task "${TASK_LABEL}" is already set up.`);
    else
      changes.push({
        file: tasksFile,
        existed: tasks.existed,
        before: tasks.text,
        after:
          index === -1
            ? edit(tasksBase, [list.length], want, true)
            : edit(tasksBase, [index], want),
        summary: [
          `${index === -1 ? "Add" : "Update"} the task "${TASK_LABEL}" (opens the schedules page in Zed's terminal)`,
        ],
      });
  }

  // 3. keymap.json: optional, and never over a key the user already bound.
  if (opts.keybinding) {
    const keymapFile = join(opts.dir, "keymap.json");
    const keymap = read(keymapFile);
    const keymapBase = keymap.text.trim() === "" ? "[]\n" : keymap.text;
    const keymapParsed = parseJsonc(keymapBase);
    const chord = keyChord();
    if (keymapParsed.error || !Array.isArray(keymapParsed.value)) {
      notes.push(
        `${keymapFile}: left alone, it isn't a valid keymap (${keymapParsed.error ?? "not an array"}).`,
      );
    } else {
      const blocks = keymapParsed.value as unknown[];
      const taken = blocks.some(
        (b) => isRecord(b) && isRecord(b.bindings) && chord in b.bindings && !isOurKeyBlock(b),
      );
      if (blocks.some(isOurKeyBlock))
        notes.push(`${keymapFile}: the keybinding is already set up.`);
      else if (taken)
        notes.push(`${keymapFile}: ${chord} is already bound in your keymap, so no key was added.`);
      else
        changes.push({
          file: keymapFile,
          existed: keymap.existed,
          before: keymap.text,
          after: edit(keymapBase, [blocks.length], { bindings: { [chord]: KEY_ACTION } }, true),
          summary: [`Bind ${chord} to the schedules page`],
        });
    }
  }

  return { changes, notes };
}

/** Work out every edit `uninstall` would make: only Rewake's own entries are removed. */
/**
 * Files that Zed's agent entries for Rewake point at and that no longer exist: the Node binary
 * and Rewake's script, written as absolute paths. Bare names like "npx" are left to Zed's PATH lookup.
 */
export function missingLaunchFiles(
  dir: string,
  exists: (path: string) => boolean = existsSync,
): Array<{ id: string; path: string }> {
  const parsed = parseJsonc(read(join(dir, "settings.json")).text || "{}");
  const servers = isRecord(parsed.value) ? parsed.value.agent_servers : undefined;
  if (parsed.error || !isRecord(servers)) return [];
  const missing: Array<{ id: string; path: string }> = [];
  const absolute = (s: unknown): s is string =>
    typeof s === "string" && (posix.isAbsolute(s) || win32.isAbsolute(s));
  for (const [id, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || unwrappedEntry(entry) === undefined) continue;
    const args = Array.isArray(entry.args) ? entry.args : [];
    for (const path of [entry.command, args[0]])
      if (absolute(path) && !exists(path)) missing.push({ id, path });
  }
  return missing;
}

export function planUninstall(dir: string): Plan {
  const changes: FileChange[] = [];
  const notes: string[] = [];

  const settingsFile = join(dir, "settings.json");
  const settings = read(settingsFile);
  const parsed = parseJsonc(settings.text || "{}");
  const servers = isRecord(parsed.value) ? parsed.value.agent_servers : undefined;
  if (!parsed.error && isRecord(servers)) {
    let text = settings.text;
    const summary: string[] = [];
    for (const [id, entry] of Object.entries(servers)) {
      if (id === AGENT_NAME) {
        text = edit(text, ["agent_servers", id], undefined);
        summary.push(`Remove the External Agent "${AGENT_NAME}"`);
        continue;
      }
      const original = unwrappedEntry(entry);
      if (!original) continue;
      text = edit(text, ["agent_servers", id], original);
      summary.push(`Take Rewake out of "${id}" (back to how it was; its threads stay)`);
    }
    if (summary.length > 0)
      changes.push({
        file: settingsFile,
        existed: true,
        before: settings.text,
        after: text,
        summary,
      });
  }

  const tasksFile = join(dir, "tasks.json");
  const tasks = read(tasksFile);
  const taskList = parseJsonc(tasks.text || "[]");
  if (!taskList.error && Array.isArray(taskList.value)) {
    let text = tasks.text;
    const indexes = (taskList.value as unknown[])
      .map((t, i) => (isRecord(t) && t.label === TASK_LABEL ? i : -1))
      .filter((i) => i !== -1)
      .reverse();
    for (const i of indexes) text = edit(text, [i], undefined);
    if (indexes.length > 0)
      changes.push({
        file: tasksFile,
        existed: true,
        before: tasks.text,
        after: text,
        summary: [`Remove the task "${TASK_LABEL}"`],
      });
  }

  // A keymap block that holds only Rewake's binding goes; elsewhere only that binding is removed.
  const keymapFile = join(dir, "keymap.json");
  const keymap = read(keymapFile);
  const blocks = parseJsonc(keymap.text || "[]");
  if (!blocks.error && Array.isArray(blocks.value)) {
    let text = keymap.text;
    const list = blocks.value as unknown[];
    for (let i = list.length - 1; i >= 0; i--) {
      const block = list[i];
      if (!isOurKeyBlock(block) || !isRecord(block) || !isRecord(block.bindings)) continue;
      const ours = Object.keys(block.bindings).filter((k) =>
        same((block.bindings as Record<string, unknown>)[k], KEY_ACTION),
      );
      const onlyOurs =
        Object.keys(block).length === 1 && Object.keys(block.bindings).length === ours.length;
      if (onlyOurs) text = edit(text, [i], undefined);
      else for (const k of ours) text = edit(text, [i, "bindings", k], undefined);
    }
    if (text !== keymap.text)
      changes.push({
        file: keymapFile,
        existed: true,
        before: keymap.text,
        after: text,
        summary: ["Remove the schedules-page keybinding"],
      });
  }

  if (changes.length === 0)
    notes.push(`Nothing to remove: Zed has no Agent Rewake entries in ${dir}.`);
  return { changes, notes };
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/**
 * Write the planned edits. Each existing file is first copied to
 * `<file>.agent-rewake-backup-<time>`, then replaced atomically, keeping its permissions. Symlinked
 * files (dotfile setups) are written through to their target.
 */
export function applyPlan(plan: Plan, now: Date = new Date()): string[] {
  const backups: string[] = [];
  for (const change of plan.changes) {
    const target = change.existed ? realpathSync(change.file) : change.file;
    const dir = dirname(target);
    if (!change.existed) ensurePrivateDir(dir);
    let mode = 0o644;
    let bom = "";
    if (change.existed) {
      mode = statSync(target).mode & 0o777;
      // A file saved with a byte-order mark keeps it (read() strips it for editing).
      if (readFileSync(target, "utf8").charCodeAt(0) === 0xfeff) bom = "\uFEFF";
      const backup = `${target}.agent-rewake-backup-${stamp(now)}`;
      copyFileSync(target, backup);
      backups.push(backup);
    }
    const tmp = join(dir, `.${basename(target)}.agent-rewake.${process.pid}.tmp`);
    const fd = openSync(tmp, "w", mode);
    try {
      writeSync(fd, bom + change.after);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Windows refuses to replace a read-only file: make it writable, then restore its mode.
    if (process.platform === "win32" && change.existed && !(mode & 0o200)) chmodSync(target, 0o666);
    renameWithRetry(tmp, target);
  }
  return backups;
}

function describe(plan: Plan, verb: string): string {
  const lines: string[] = [];
  if (plan.changes.length > 0) {
    lines.push(`Agent Rewake will ${verb}:`, "");
    for (const c of plan.changes) {
      lines.push(`  ${c.file}${c.existed ? "" : " (new file)"}`);
      for (const s of c.summary) lines.push(s.startsWith(" ") ? `    ${s}` : `    - ${s}`);
    }
    lines.push(
      "",
      "Nothing else in these files changes; comments and formatting are kept.",
      "Each existing file is backed up next to itself first.",
    );
  }
  for (const n of plan.notes) lines.push(`  ${n}`);
  return `${lines.join("\n")}\n`;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export interface RunInstallOptions {
  uninstall: boolean;
  /** Only wrap these agent ids. */
  only?: string[];
  yes: boolean;
  dryRun: boolean;
  keybinding: boolean;
  env: NodeJS.ProcessEnv;
  interactive?: boolean;
  out?: (text: string) => void;
  ask?: (question: string) => Promise<boolean>;
  /** Other coding agents on this computer (default: detected now). */
  agents?: Found[];
}

/** `agent-rewake install` and `agent-rewake uninstall`. */
export async function runInstall(opts: RunInstallOptions): Promise<number> {
  const out = opts.out ?? ((t: string) => process.stdout.write(t));
  const dir = zedConfigDir(opts.env);
  const plan = opts.uninstall
    ? planUninstall(dir)
    : planInstall({
        dir,
        launch: launchCommand(),
        keybinding: opts.keybinding,
        env: opts.env,
        stateDir: stateDir(opts.env),
        ...(opts.only && { only: opts.only }),
      });

  out(describe(plan, opts.uninstall ? "remove these entries from Zed" : "set up Zed"));
  let note: string | undefined;
  if (!opts.uninstall) {
    note = otherAgentsNote(
      opts.agents ??
        withoutInstalled(
          detectAgents({
            env: opts.env,
            home: opts.env.HOME || opts.env.USERPROFILE || homedir(),
            platform: platform(),
          }),
          (id) => {
            const home = opts.env.HOME || opts.env.USERPROFILE || homedir();
            return (
              (id === "codex" && pluginInstalled(opts.env, home)) ||
              (id === "claude-code" && modInstalled(opts.env, home)) ||
              (id === "copilot-cli" && existsSync(hooksFile(opts.env, home))) ||
              (id === "grok" && existsSync(grokHooksFile(opts.env, home))) ||
              (id === "antigravity" && existsSync(antigravityPluginDir(opts.env, home)))
            );
          },
        ),
    );
    if (note) out(`\n${note}\n`);
  }
  if (plan.changes.length === 0) {
    if (!opts.uninstall) out(nextSteps(note !== undefined));
    return 0;
  }
  if (opts.dryRun) {
    out("\nDry run: nothing was written.\n");
    return 0;
  }
  if (!opts.yes) {
    const interactive = opts.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      out("\nNot a terminal, so nothing was written. Run again with --yes to apply.\n");
      return 1;
    }
    const ok = await (opts.ask ?? confirm)("\nApply these changes? [y/N] ");
    if (!ok) {
      out("Nothing was written.\n");
      return 1;
    }
  }

  const backups = applyPlan(plan);
  out("\nDone.\n");
  for (const b of backups) out(`  Backup: ${b}\n`);
  out(
    opts.uninstall
      ? "Rewake is out of your agents. Your threads are untouched, and your scheduled messages are kept; `agent-rewake doctor` shows where.\n"
      : nextSteps(note !== undefined),
  );
  return 0;
}

/** The shortcut that opens Zed's Agent Panel (Zed 1.22.0 keymaps, `agent::ToggleFocus`). */
export function agentPanelKey(p: NodeJS.Platform = platform()): string {
  if (p === "darwin") return "Cmd+?";
  if (p === "win32") return "Ctrl+Shift+/";
  return "Ctrl+?";
}

/** How to quit Zed completely on this OS, for "restart Zed" instructions. */
export function quitZed(p: NodeJS.Platform = platform()): string {
  if (p === "darwin") return "quit Zed completely (Cmd+Q)";
  if (p === "win32") return "close every Zed window so Zed exits";
  return "quit Zed completely (Ctrl+Q)";
}

/** What to do next. `reachShown`: the specific "works only in Zed" line was shown already. */
function nextSteps(reachShown = false): string {
  return [
    "",
    `Now ${quitZed()} and open it again.`,
    `Then open Zed's Agent Panel (${agentPanelKey()}) and open or start a thread with one of these agents.`,
    "Zed starts Rewake when you open a thread with the agent, not when Zed itself starts.",
    "`agent-rewake doctor` shows whether it has started.",
    "",
    'In the thread, the "Rewake" menu under the message box (next to the model picker) schedules messages.',
    "When the agent hits a usage limit, Rewake asks you in the thread with Yes/No buttons.",
    `All threads: command palette, task: spawn, then "${TASK_LABEL}".`,
    "",
    ...(reachShown
      ? []
      : [
          "Rewake works only in Zed's Agent Panel, with external agents such as Claude Agent, Codex and Gemini CLI.",
          "It can't reach Zed's own agent, Claude Code in a terminal, or the Claude desktop app.",
          "",
        ]),
    `Agent Rewake is open source: ${REPO_URL}. If it saves you time, a star there helps others find it.`,
    "",
  ].join("\n");
}
