import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

/**
 * Starting programs the same way on every OS.
 *
 * On Windows, Node's spawn finds only `.exe`/`.com` files, and refuses `.cmd`/`.bat` files without
 * a shell (CVE-2024-27980). Many agents and tools are `.cmd` shims there: `npx`, `gemini`, `pnpm`.
 * Zed starts them through a shell, so they work without Rewake; this makes them work through it,
 * without handing every argument to a shell.
 */
export interface Resolved {
  command: string;
  args: string[];
  /** Arguments are already quoted for cmd.exe (Windows only). */
  windowsVerbatimArguments?: boolean;
}

export interface SpawnHost {
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  read: (path: string) => string;
  execPath: string;
}

const defaultHost = (): SpawnHost => ({
  platform: osPlatform(),
  exists: existsSync,
  read: (p) => readFileSync(p, "utf8"),
  execPath: process.execPath,
});

/** An environment variable, looked up case-insensitively (Windows has `Path`, not `PATH`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** The file Windows would run for `command`, by PATH and PATHEXT, or undefined. */
export function findOnWindows(
  command: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | undefined {
  const exts = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const hasExt = exts.includes(win32.extname(command).toLowerCase());
  const candidates = (base: string) => (hasExt ? [base] : exts.map((e) => base + e));
  const dirs = /[\\/]/.test(command)
    ? [""]
    : (envValue(env, "PATH") ?? "").split(";").filter(Boolean);
  for (const dir of dirs)
    for (const file of candidates(dir ? win32.join(dir, command) : command))
      if (exists(file)) return file;
  return undefined;
}

// cmd.exe quoting, as in cross-spawn (MIT): quote each argument for the C runtime, then escape
// cmd's metacharacters with ^, so nothing in an argument is interpreted by cmd.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function quoteForCmd(arg: string): string {
  let a = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, "$1$1");
  return `"${a}"`.replace(CMD_META, "^$1");
}

/**
 * How to start `command args` on this OS. macOS and Linux: unchanged (the kernel runs scripts by
 * their `#!` line). Windows: an `.exe` is run directly; an npm `.cmd` shim is run as
 * `node <the JS file it points at>`; any other `.cmd`/`.bat` goes through `cmd.exe /d /s /c` with
 * every argument quoted. A command that can't be found is returned unchanged, so spawn reports it.
 */
export function resolveCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  host: SpawnHost = defaultHost(),
): Resolved {
  if (host.platform !== "win32") return { command, args };
  const file = findOnWindows(command, env, host.exists);
  if (!file) return { command, args };
  const ext = win32.extname(file).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: file, args };
  const js = npmShimTarget(file, host);
  if (js) return { command: host.execPath, args: [js, ...args] };
  const comspec = envValue(env, "COMSPEC") ?? "cmd.exe";
  const line = [file.replace(CMD_META, "^$1"), ...args.map(quoteForCmd)].join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * The JS file an npm-generated `.cmd` shim runs, e.g. `"%dp0%\node_modules\npm\bin\npx-cli.js"`
 * or `"%~dp0\..\gemini\dist\index.js"`, when it exists.
 */
export function npmShimTarget(file: string, host: SpawnHost = defaultHost()): string | undefined {
  let text: string;
  try {
    text = host.read(file);
  } catch {
    return undefined;
  }
  // npm's cmd-shim writes `"%dp0%\<path>.js"`; Node's own npx.cmd sets `"…=%~dp0\<path>.js"`.
  const m = /%~?dp0%?\\([^"%\r\n]+?\.(?:c|m)?js)\b/i.exec(text);
  if (!m?.[1]) return undefined;
  const js = win32.join(win32.dirname(file), m[1]);
  return host.exists(js) ? js : undefined;
}

/**
 * npm's own CLI scripts (`npm-cli.js`, `npx-cli.js`) next to the running Node, so npm and npx run
 * as `node <script>` everywhere: no shell, no `.cmd`, no PATH lookup.
 */
export function npmScript(
  name: "npm-cli.js" | "npx-cli.js",
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
  p: NodeJS.Platform = osPlatform(),
): string | undefined {
  const path = p === "win32" ? win32 : posix;
  const bin = path.dirname(execPath);
  for (const candidate of [
    path.join(bin, "..", "lib", "node_modules", "npm", "bin", name), // macOS, Linux
    path.join(bin, "node_modules", "npm", "bin", name), // Windows
  ])
    if (exists(candidate)) return candidate;
  return undefined;
}

/** Runs taskkill with these arguments and gives its exit status (tests give their own). */
export type TaskKill = (args: string[]) => number | null;

const taskkill: TaskKill = (args) => {
  const exe = join(
    dirname(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"),
    "taskkill.exe",
  );
  return spawnSync(existsSync(exe) ? exe : "taskkill", args, {
    stdio: "ignore",
    windowsHide: true,
  }).status;
};

/**
 * Stop a child and everything it started. On Windows, kill() ends only the direct child, so a
 * program behind cmd.exe would be left running; taskkill /T ends the whole tree ("Ends the
 * specified process and any child processes started by it": learn.microsoft.com/windows-server/
 * administration/windows-commands/taskkill).
 */
export function killTree(
  child: { pid?: number | undefined; kill: (signal?: NodeJS.Signals) => boolean },
  p: NodeJS.Platform = osPlatform(),
  signal: NodeJS.Signals = "SIGTERM",
  run: TaskKill = taskkill,
): void {
  if (p === "win32" && child.pid !== undefined) {
    if (run(["/pid", String(child.pid), "/T", "/F"]) === 0) return;
  }
  child.kill(signal);
}

/** `killTree` for a process known only by its id (one this process started, but not as a child). */
export function killPidTree(
  pid: number,
  p: NodeJS.Platform = osPlatform(),
  run: TaskKill = taskkill,
): void {
  killTree(
    {
      pid,
      kill: (signal) => {
        try {
          return process.kill(pid, signal);
        } catch {
          return false; // Already ended.
        }
      },
    },
    p,
    "SIGTERM",
    run,
  );
}
