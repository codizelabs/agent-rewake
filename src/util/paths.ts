import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Where things live on each OS. Every
 * rule takes the platform, home directory and environment as inputs, so tests check the macOS,
 * Linux and Windows rules on any machine.
 */
export interface Host {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

export function currentHost(env: NodeJS.ProcessEnv = process.env): Host {
  return { platform: osPlatform(), home: homedir(), env };
}

const pathFor = (p: NodeJS.Platform) => (p === "win32" ? win32 : posix);

/**
 * An environment variable that names a directory, or undefined when it's unset, empty or
 * relative. The XDG spec says relative values must be ignored, and Zed does the same; an empty
 * value would otherwise put files in whatever directory the process was started in.
 */
export function absoluteDir(value: string | undefined, p: NodeJS.Platform): string | undefined {
  return value && pathFor(p).isAbsolute(value) ? value : undefined;
}

/** Flatpak Zed's per-app directories, as seen from the host. */
const FLATPAK_APP = [".var", "app", "dev.zed.Zed"];

/**
 * Per-user state directory:
 *   macOS   ~/Library/Application Support/agent-rewake
 *   Linux   ${XDG_STATE_HOME:-~/.local/state}/agent-rewake
 *   Windows %LOCALAPPDATA%\agent-rewake
 * AGENT_REWAKE_STATE_DIR overrides it (used by tests).
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env, host = currentHost(env)): string {
  if (env.AGENT_REWAKE_STATE_DIR) return env.AGENT_REWAKE_STATE_DIR;
  const { platform: p, home } = host;
  const path = pathFor(p);
  switch (p) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "agent-rewake");
    case "win32":
      return path.join(
        absoluteDir(env.LOCALAPPDATA, p) ?? path.join(home, "AppData", "Local"),
        "agent-rewake",
      );
    default:
      return path.join(
        absoluteDir(env.XDG_STATE_HOME, p) ?? path.join(home, ".local", "state"),
        "agent-rewake",
      );
  }
}

/**
 * Zed's configuration directory (settings.json, tasks.json, keymap.json), by Zed's own rule
 * (crates/paths/src/paths.rs):
 *   macOS   ~/.config/zed (Zed ignores XDG_CONFIG_HOME on macOS)
 *   Linux   ${FLATPAK_XDG_CONFIG_HOME:-${XDG_CONFIG_HOME:-~/.config}}/zed
 *   Windows %APPDATA%\Zed
 * Run from a host terminal, a Flatpak Zed's configuration is only visible under
 * ~/.var/app/dev.zed.Zed/config/zed: it's used when the standard one doesn't exist.
 * AGENT_REWAKE_ZED_CONFIG_DIR overrides it.
 */
export function zedConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  host = currentHost(env),
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.AGENT_REWAKE_ZED_CONFIG_DIR) return env.AGENT_REWAKE_ZED_CONFIG_DIR;
  const { platform: p, home } = host;
  const path = pathFor(p);
  if (p === "darwin") return path.join(home, ".config", "zed");
  if (p === "win32")
    return path.join(absoluteDir(env.APPDATA, p) ?? path.join(home, "AppData", "Roaming"), "Zed");
  const flatpak = absoluteDir(env.FLATPAK_XDG_CONFIG_HOME, p);
  if (flatpak) return path.join(flatpak, "zed");
  const standard = path.join(
    absoluteDir(env.XDG_CONFIG_HOME, p) ?? path.join(home, ".config"),
    "zed",
  );
  const sandboxed = path.join(home, ...FLATPAK_APP, "config", "zed");
  return !exists(standard) && exists(sandboxed) ? sandboxed : standard;
}

/**
 * Zed's data directory, where it keeps the registry cache and the agents it installed:
 *   macOS    ~/Library/Application Support/Zed
 *   Linux    ${FLATPAK_XDG_DATA_HOME:-${XDG_DATA_HOME:-~/.local/share}}/zed
 *   Windows  %LOCALAPPDATA%\Zed
 * The Flatpak rule from a host terminal matches zedConfigDir's. AGENT_REWAKE_ZED_DATA_DIR
 * overrides it.
 */
export function zedDataDir(
  env: NodeJS.ProcessEnv = process.env,
  host = currentHost(env),
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.AGENT_REWAKE_ZED_DATA_DIR) return env.AGENT_REWAKE_ZED_DATA_DIR;
  const { platform: p, home } = host;
  const path = pathFor(p);
  if (p === "darwin") return path.join(home, "Library", "Application Support", "Zed");
  if (p === "win32")
    return path.join(
      absoluteDir(env.LOCALAPPDATA, p) ?? path.join(home, "AppData", "Local"),
      "Zed",
    );
  const flatpak = absoluteDir(env.FLATPAK_XDG_DATA_HOME, p);
  if (flatpak) return path.join(flatpak, "zed");
  const standard = path.join(
    absoluteDir(env.XDG_DATA_HOME, p) ?? path.join(home, ".local", "share"),
    "zed",
  );
  const sandboxed = path.join(home, ...FLATPAK_APP, "data", "zed");
  return !exists(standard) && exists(sandboxed) ? sandboxed : standard;
}

/** Create a directory (and parents) with owner-only permissions. Returns the path. */
export function ensurePrivateDir(path: string, o: { tighten?: boolean } = {}): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // Rewake's own folders (its state) that were left more open, by an older version or by hand,
  // are closed to other users. Never used on an agent's or the editor's folders.
  if (o.tighten && osPlatform() !== "win32") {
    try {
      const st = statSync(path);
      if ((st.mode & 0o077) !== 0 && st.uid === process.getuid?.()) chmodSync(path, 0o700);
    } catch {
      // Not ours to change, or gone: leave it.
    }
  }
  return path;
}
