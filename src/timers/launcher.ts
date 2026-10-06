import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/store.js";
import { ensurePrivateDir } from "../util/paths.js";

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
export function ensureLauncher(stateDir: string, bundle: string): string | undefined {
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
  if (current !== code)
    writeFileAtomic(ensurePrivateDir(join(stateDir, "bin")), "agent-rewake.mjs", code);
  return target;
}
