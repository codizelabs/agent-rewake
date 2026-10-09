import { existsSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { type LaunchCommand, launchCommand } from "../install.js";
import { ensureLauncher, launcherPath, refreshLauncher } from "../timers/launcher.js";
import { ensureNodeShim, nodeShimPath } from "../timers/node-shim.js";
import { VERSION } from "../version.js";

/** How Zed will start Rewake, and the step that makes it so before settings are written. */
export interface ZedLaunch {
  launch: LaunchCommand;
  /** Create the stable files `launch` names. Throws, saying why, when they can't be made. */
  prepare: () => void;
}

const nothing = (): void => undefined;

/**
 * What Zed's agent entries run: the same two stable files hooks and timers use, in Rewake's own
 * folder. `bin/rewake-node` finds a working Node.js 22 or newer each time, and
 * `bin/agent-rewake.mjs` is Rewake itself, copied there. Neither depends on npm, the network or one
 * Node.js folder, so upgrading or removing Node.js (nvm, fnm, asdf, Homebrew) or an empty npm cache
 * doesn't stop the agents Rewake is in front of.
 *
 * Windows keeps the Node.js and npx paths it always used, as does a run from source that has no
 * built copy to install (tests, a checkout).
 */
export function zedLaunch(
  state: string,
  bundle: string = process.argv[1] ?? "",
  p: NodeJS.Platform = platform(),
): ZedLaunch {
  if (p === "win32") return { launch: launchCommand(), prepare: nothing };
  const launcher = launcherPath(state);
  if (!existsSync(launcher) && !isBuiltBundle(bundle))
    return { launch: launchCommand(), prepare: nothing };
  return {
    launch: { command: nodeShimPath(state), args: [launcher] },
    prepare: () => {
      const shim = ensureNodeShim(state, undefined, p);
      // A copy that exists is only ever replaced by a newer Rewake, never an older one.
      if (existsSync(launcher)) refreshLauncher(state, bundle, VERSION);
      else ensureLauncher(state, bundle);
      if (!shim || !existsSync(launcher))
        throw new Error(
          `Rewake couldn't write its start files into ${state}. Check that this folder is writable, then run install again.`,
        );
    },
  };
}

function isBuiltBundle(bundle: string): boolean {
  try {
    return /\.m?js$/.test(realpathSync(bundle));
  } catch {
    return false;
  }
}
