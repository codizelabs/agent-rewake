import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { basename, join, win32 } from "node:path";
import { type AgentCommand, claudeAdapterCommand } from "./adapters/claude/spawn.js";
import { readJsonFile, renameWithRetry } from "./util/fs.js";
import { ensurePrivateDir, zedDataDir } from "./util/paths.js";
import { npmScript, type Resolved, resolveCommand } from "./util/spawn.js";

/**
 * Wrapping an agent Zed already knows, under its own id: Zed keys threads by agent
 * id, so keeping the id keeps every existing thread. The wrapped agent is named in Rewake's args:
 *
 *   --wrap-registry <id>          an ACP Registry agent (npx or binary), e.g. claude-acp, codex-acp
 *   --wrap-command <json>         a custom agent: {"command": "...", "args": [...]}
 *
 * Anything after these is an extra argument Zed appended: Rewake then hands the terminal straight to the agent.
 */
export const WRAP_REGISTRY = "--wrap-registry";
export const WRAP_COMMAND = "--wrap-command";

/** The registry id of Claude Agent; Rewake runs its own pinned adapter for it. */
export const CLAUDE_REGISTRY_ID = "claude-acp";

export type WrapTarget =
  | { kind: "registry"; id: string }
  /** `id` is the agent's key in Zed's settings, so the schedules page can name the agent. */
  | { kind: "command"; command: string; args: string[]; id?: string };

/** Find a wrap target in argv. Returns the target and the extra arguments after it. */
export function parseWrapArgs(
  argv: string[],
): { target: WrapTarget; extra: string[] } | { error: string } | undefined {
  const i = argv.findIndex((a) => a === WRAP_REGISTRY || a === WRAP_COMMAND);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value) return { error: `missing value after ${argv[i]}` };
  const extra = argv.slice(i + 2);
  if (argv[i] === WRAP_REGISTRY) return { target: { kind: "registry", id: value }, extra };
  try {
    const parsed = JSON.parse(value) as { command?: unknown; args?: unknown; id?: unknown };
    if (typeof parsed.command !== "string" || !parsed.command) throw new Error("no command");
    const args = Array.isArray(parsed.args) ? parsed.args.map(String) : [];
    const id = typeof parsed.id === "string" && parsed.id ? parsed.id : undefined;
    return { target: { kind: "command", command: parsed.command, args, ...(id && { id }) }, extra };
  } catch (err) {
    return {
      error: `${WRAP_COMMAND} needs {"command": …, "args": […]} (${(err as Error).message})`,
    };
  }
}

/** The args that tell Rewake which agent to wrap, as written into Zed's settings. */
export function wrapArgs(target: WrapTarget): string[] {
  return target.kind === "registry"
    ? [WRAP_REGISTRY, target.id]
    : [
        WRAP_COMMAND,
        JSON.stringify({
          command: target.command,
          args: target.args,
          ...(target.id && { id: target.id }),
        }),
      ];
}

export { zedDataDir } from "./util/paths.js";

export interface NpxDistribution {
  package: string;
  args: string[];
  env: Record<string, string>;
}

/** One platform's build of a binary registry agent (the registry's `distribution.binary[<platform>]`). */
export interface BinaryTarget {
  archive: string;
  /** Relative to the extracted directory, starting with "./" (Zed rejects anything else). */
  cmd: string;
  args: string[];
  env: Record<string, string>;
  sha256?: string;
}

export type RegistryDistribution =
  | { kind: "npx"; npx: NpxDistribution; name: string | undefined; version: string | undefined }
  | { kind: "binary"; binary: BinaryTarget; name: string | undefined; version: string }
  | { kind: "other"; types: string[]; name: string | undefined };

/**
 * Zed's name for this machine in the registry: `{darwin|linux|windows}-{aarch64|x86_64}`
 * (agent_server_store.rs). AGENT_REWAKE_PLATFORM overrides it (tests).
 */
export function platformKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AGENT_REWAKE_PLATFORM) return env.AGENT_REWAKE_PLATFORM;
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[platform() as string];
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch as string];
  return os && arch ? `${os}-${arch}` : undefined;
}

const strings = (v: unknown): Record<string, string> =>
  isRecord(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : {};

/**
 * Read one agent from the copy of the ACP Registry that Zed caches
 * (`<data>/external_agents/registry/registry.json`, agent_registry_store.rs). Like Zed, a binary
 * build for this platform wins over npx, and an agent with neither isn't runnable.
 */
export function registryAgent(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): RegistryDistribution | undefined {
  const file = join(zedDataDir(env), "external_agents", "registry", "registry.json");
  let agents: unknown;
  try {
    agents = (readJsonFile(file) as { agents?: unknown }).agents;
  } catch {
    return undefined;
  }
  if (!Array.isArray(agents)) return undefined;
  const agent = agents.find((a) => isRecord(a) && a.id === id) as
    | Record<string, unknown>
    | undefined;
  if (!agent) return undefined;
  const name = typeof agent.name === "string" ? agent.name : undefined;
  const version = typeof agent.version === "string" ? agent.version : undefined;
  const dist = isRecord(agent.distribution) ? agent.distribution : {};
  const key = platformKey(env);
  const target = key && isRecord(dist.binary) ? dist.binary[key] : undefined;
  if (
    isRecord(target) &&
    typeof target.archive === "string" &&
    typeof target.cmd === "string" &&
    version
  ) {
    return {
      kind: "binary",
      name,
      version,
      binary: {
        archive: target.archive,
        cmd: target.cmd,
        args: Array.isArray(target.args) ? target.args.map(String) : [],
        env: strings(target.env),
        ...(typeof target.sha256 === "string" && { sha256: target.sha256 }),
      },
    };
  }
  const npx = isRecord(dist.npx) ? dist.npx : undefined;
  if (npx && typeof npx.package === "string") {
    return {
      kind: "npx",
      name,
      version,
      npx: {
        package: npx.package,
        args: Array.isArray(npx.args) ? npx.args.map(String) : [],
        env: strings(npx.env),
      },
    };
  }
  return { kind: "other", name, types: Object.keys(dist) };
}

/** Can Rewake wrap this registry agent? Claude always (own pinned adapter); others need an npx
 * package or a binary build for this platform, the same agents Zed can run. */
export function canWrapRegistry(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (id === CLAUDE_REGISTRY_ID) return true;
  const kind = registryAgent(id, env)?.kind;
  return kind === "npx" || kind === "binary";
}

/** "@scope/pkg@1.2.3" → ["@scope/pkg", "1.2.3"]; no version → [spec, undefined]. */
export function splitPackageSpec(spec: string): [string, string | undefined] {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return [spec, undefined];
  return [spec.slice(0, at), spec.slice(at + 1)];
}

function installedVersion(dir: string, pkg: string): string | undefined {
  try {
    const json = readJsonFile(join(dir, "node_modules", pkg, "package.json")) as Record<
      string,
      unknown
    >;
    return typeof json.version === "string" ? json.version : undefined;
  } catch {
    return undefined;
  }
}

/** The package's executable, the way npm would pick it: the only bin, or the one named after it. */
export function packageExecutable(dir: string, pkg: string): string | undefined {
  const root = join(dir, "node_modules", pkg);
  let json: { bin?: unknown };
  try {
    json = readJsonFile(join(root, "package.json")) as typeof json;
  } catch {
    return undefined;
  }
  const bin = json.bin;
  if (typeof bin === "string") return join(root, bin);
  if (!isRecord(bin)) return undefined;
  const short = pkg.replace(/^@[^/]+\//, "");
  const chosen = bin[short] ?? Object.values(bin)[0];
  return typeof chosen === "string" ? join(root, chosen) : undefined;
}

/**
 * npm, as `node npm-cli.js` next to the running Node when it's there; otherwise `npm` from PATH,
 * started without a shell (resolveCommand handles Windows' npm.cmd), so the version range below
 * stays one argument.
 */
function npmCli(args: string[], env: NodeJS.ProcessEnv): Resolved {
  const script = npmScript("npm-cli.js");
  return script
    ? { command: process.execPath, args: [script, ...args] }
    : resolveCommand("npm", args, env);
}

/**
 * Where a registry npx agent is installed. Zed treats the registry version as a ceiling and runs
 * whatever copy it has (`<pkg>@0.0.0 - <version>`, agent_server_store.rs: "the user might have an
 * older cached version"), so Rewake runs that same copy, whatever its version, and starts at once.
 * Only when there's no copy at all does it install one into its own directory, with the same
 * ceiling. npm's output goes to Rewake's log, never to stdout, which carries ACP.
 */
export function ensureNpxAgent(
  id: string,
  npx: NpxDistribution,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  logFile?: string,
): string {
  const [pkg, version] = splitPackageSpec(npx.package);
  const zedDir = join(zedDataDir(env), "external_agents", "registry", "npx", safeName(id));
  const ownDir = join(stateDir, "agents", "npx", safeName(id));
  for (const dir of [zedDir, ownDir]) if (installedVersion(dir, pkg)) return dir;
  ensurePrivateDir(ownDir);
  const spec = version ? `${pkg}@0.0.0 - ${version}` : pkg;
  const npm = npmCli(["install", spec, "--save-exact", "--no-audit", "--no-fund"], env);
  const out = logFile ? openSync(logFile, "a") : "ignore";
  const r = spawnSync(npm.command, npm.args, {
    cwd: ownDir,
    env,
    stdio: ["ignore", out, out],
    windowsHide: true,
    ...(npm.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
  });
  if (installedVersion(ownDir, pkg)) return ownDir;
  throw new Error(
    `couldn't install ${npx.package} for "${id}" (npm exit ${r.status ?? "?"}). Check your network, then reopen the thread.`,
  );
}

/**
 * Zed's directory for one version of a binary agent (agent_server_store.rs
 * `versioned_archive_cache_dir`): `v_<version>_<sha256(version)[..16]>_<sha256(archive[\0sha256:<hash>])[..16]>`.
 */
export function zedBinaryDir(
  id: string,
  version: string,
  target: BinaryTarget,
  env: NodeJS.ProcessEnv,
): string {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const archiveKey = target.sha256
    ? `${target.archive}\0sha256:${target.sha256.toLowerCase()}`
    : target.archive;
  return join(
    zedDataDir(env),
    "external_agents",
    "registry",
    zedSafeName(id),
    `v_${zedSafeName(version)}_${sha(version)}_${sha(archiveKey)}`,
  );
}

function commandIn(dir: string, cmd: string): string | undefined {
  if (!/^\.[\\/]/.test(cmd) || cmd.includes("..")) return undefined;
  const path = join(dir, cmd.slice(2));
  return existsSync(path) ? path : undefined;
}

/**
 * Find a binary agent's command: Zed's own copy of this version first, then any other version Zed
 * has (newest first), then Rewake's own download. Returns undefined if none is installed.
 */
export function findBinaryAgent(
  id: string,
  version: string,
  target: BinaryTarget,
  stateDir: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const exact = commandIn(zedBinaryDir(id, version, target, env), target.cmd);
  if (exact) return exact;
  const zedAgentDir = join(zedDataDir(env), "external_agents", "registry", zedSafeName(id));
  const own = join(stateDir, "agents", "bin", safeName(id));
  for (const base of [zedAgentDir, own]) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(base)
        .filter((d) => d.startsWith("v_"))
        .map((d) => join(base, d))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const found = commandIn(d, target.cmd);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Download and unpack a binary agent the way Zed would, into Rewake's own directory: verify the
 * SHA-256 when the registry gives one, unpack .zip, .tar.gz or .tar.bz2 with the system's tools
 * (no bundled dependency), or keep a raw binary as is. Returns the command's path.
 */
export async function downloadBinaryAgent(
  id: string,
  version: string,
  target: BinaryTarget,
  stateDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = ensurePrivateDir(join(stateDir, "agents", "bin", safeName(id)));
  const dest = join(base, `v_${safeName(version)}`);
  const tmp = `${dest}.partial-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const res = await fetchImpl(target.archive);
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (target.sha256) {
      const got = createHash("sha256").update(bytes).digest("hex");
      if (got !== target.sha256.toLowerCase())
        throw new Error("the download doesn't match the registry's checksum");
    }
    const name = basename(new URL(target.archive).pathname) || "agent";
    const file = join(tmp, name);
    writeFileSync(file, bytes);
    const lower = name.toLowerCase();
    if (lower.endsWith(".zip")) {
      unpack(unpackers("zip", file, tmp));
      rmSync(file, { force: true });
    } else if (/\.(tar\.gz|tgz)$/.test(lower)) {
      unpack(unpackers("gz", file, tmp));
      rmSync(file, { force: true });
    } else if (/\.(tar\.bz2|tbz2?)$/.test(lower)) {
      unpack(unpackers("bz2", file, tmp));
      rmSync(file, { force: true });
    } else if (target.cmd.replace(/^\.[\\/]/, "") !== name) {
      // A raw binary: put it where `cmd` expects it.
      renameSync(file, join(tmp, target.cmd.slice(2)));
    }
    const cmd = commandIn(tmp, target.cmd);
    if (!cmd) throw new Error(`the download has no ${target.cmd}`);
    chmodSync(cmd, 0o755);
    rmSync(dest, { recursive: true, force: true });
    renameWithRetry(tmp, dest);
    return join(dest, target.cmd.slice(2));
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `couldn't set up "${id}" ${version} (${(err as Error).message}). Check your network, or open the agent once without Rewake (agent-rewake uninstall), then reopen the thread.`,
    );
  }
}

/**
 * The tools that can unpack an archive here, in order:
 * - Windows: its own tar.exe (bsdtar: zip, gz and bz2), by full path, because the GNU tar that
 *   Git puts on PATH reads `C:\…` as a remote host;
 * - macOS: tar is bsdtar too, and unzip is always there;
 * - Linux: GNU tar can't read zip, so unzip, then bsdtar, then Python's zipfile module.
 */
export function unpackers(
  kind: "zip" | "gz" | "bz2",
  file: string,
  dir: string,
  p: NodeJS.Platform = platform(),
  env: NodeJS.ProcessEnv = process.env,
): Array<[string, string[]]> {
  const tarFlag = { zip: "-xf", gz: "-xzf", bz2: "-xjf" }[kind];
  if (p === "win32") {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    return [[win32.join(root, "System32", "tar.exe"), [tarFlag, file, "-C", dir]]];
  }
  if (kind !== "zip") return [["tar", [tarFlag, file, "-C", dir]]];
  return [
    ["unzip", ["-q", "-o", file, "-d", dir]],
    ["bsdtar", ["-xf", file, "-C", dir]],
    ["tar", ["-xf", file, "-C", dir]],
    ["python3", ["-m", "zipfile", "-e", file, dir]],
  ];
}

function unpack(tools: Array<[string, string[]]>): void {
  for (const [command, args] of tools) {
    const r = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
    if (r.status === 0) return;
  }
  throw new Error(
    `couldn't unpack the archive: install one of ${tools.map(([c]) => c.split(/[\\/]/).pop()).join(", ")}`,
  );
}

/** The command for a wrapped agent, launched the way Zed would launch it unwrapped. */
export async function wrappedAgentCommand(
  target: WrapTarget,
  extra: string[],
  env: NodeJS.ProcessEnv,
  stateDir: string,
  logFile?: string,
  fetchImpl?: typeof fetch,
): Promise<AgentCommand> {
  if (target.kind === "command")
    return { command: target.command, args: [...target.args, ...extra], env: { ...env } };
  if (target.id === CLAUDE_REGISTRY_ID) return claudeAdapterCommand(extra, env);
  const agent = registryAgent(target.id, env);
  if (!agent)
    throw new Error(
      `"${target.id}" isn't in Zed's copy of the ACP Registry. Open Zed's agent registry once, or run agent-rewake uninstall to restore the original entry.`,
    );
  if (agent.kind === "binary") {
    const cmd =
      findBinaryAgent(target.id, agent.version, agent.binary, stateDir, env) ??
      (await downloadBinaryAgent(target.id, agent.version, agent.binary, stateDir, fetchImpl));
    return {
      command: cmd,
      args: [...agent.binary.args, ...extra],
      env: { ...env, ...agent.binary.env },
    };
  }
  if (agent.kind !== "npx")
    throw new Error(
      `"${target.id}" has no build for this computer (${platformKey(env) ?? "unknown platform"}), so Zed can't run it either. Run agent-rewake uninstall to restore it.`,
    );
  const dir = ensureNpxAgent(target.id, agent.npx, stateDir, env, logFile);
  const [pkg] = splitPackageSpec(agent.npx.package);
  const exe = packageExecutable(dir, pkg);
  if (!exe) throw new Error(`${pkg} has no executable to run`);
  return {
    command: process.execPath,
    args: [exe, ...agent.npx.args, ...extra],
    env: { ...env, ...agent.npx.env },
  };
}

/** Zed's `sanitize_path_component`: anything but [A-Za-z0-9._-] becomes "-". */
function zedSafeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-") || "unknown";
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
