import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/store.js";
import { compareVersions } from "../install/detect.js";
import { ensurePrivateDir } from "../util/paths.js";
import { VERSION } from "../version.js";

/**
 * A stable copy of Rewake for timers and hooks (plan §3.6). Run through npx, Rewake lives in npm's
 * cache, which can be cleaned, so a timer armed today can't point at it. Each install and each
 * arming copies the running bundle to `<stateDir>/bin/agent-rewake.mjs`. That path never changes,
 * so timer and hook commands stay byte-identical across versions (Codex keys its hook trust on
 * them). `.mjs`: the folder has no package.json to say the file is a module.
 *
 * `<stateDir>/bin` is private to the person (0700), because code there runs from timers and hooks.
 */
export function launcherPath(stateDir: string): string {
  return join(stateDir, "bin", "agent-rewake.mjs");
}

/**
 * Copy `bundle` (the running Rewake) to the launcher path when it differs. Returns the launcher
 * path, or undefined when `bundle` isn't a file (running from source, in tests).
 */
export function ensureLauncher(
  stateDir: string,
  bundle: string,
  version: string = VERSION,
): string | undefined {
  const target = launcherPath(stateDir);
  let source: string;
  try {
    source = realpathSync(bundle);
  } catch {
    return undefined;
  }
  if (!source.endsWith(".js") && !source.endsWith(".mjs")) return undefined;
  if (existsSync(target) && realpathSync(target) === source) return target;
  const code = readFileSync(source, "utf8");
  const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  const bin = ensurePrivateDir(join(stateDir, "bin"));
  if (current !== code) writeFileAtomic(bin, "agent-rewake.mjs", code);
  if (launcherVersion(stateDir) !== version)
    writeFileAtomic(bin, "agent-rewake.version", `${version}\n`);
  return target;
}

/** The version of the stable copy, when it recorded one. */
export function launcherVersion(stateDir: string): string | undefined {
  try {
    return readFileSync(join(stateDir, "bin", "agent-rewake.version"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep the stable copy current: once any integration outside Zed has created it, every newer
 * Rewake that runs (Zed's add-on through npx, `doctor`, an update) refreshes it, so hooks and
 * timers never keep running old code. An older Rewake never replaces a newer copy.
 */
export function refreshLauncher(stateDir: string, bundle: string, version: string): void {
  if (!existsSync(launcherPath(stateDir))) return;
  // Only Rewake's own bundle (dist/agent-rewake.js), never another script that loaded this code.
  let real: string;
  try {
    real = realpathSync(bundle);
  } catch {
    return;
  }
  if (!/[\\/]agent-rewake\.m?js$/.test(real)) return;
  const current = launcherVersion(stateDir);
  if (current === version) return;
  if (current && compareVersions(version, current) < 0) return;
  try {
    ensureLauncher(stateDir, bundle, version);
  } catch {
    // Best effort: the next run tries again.
  }
}
