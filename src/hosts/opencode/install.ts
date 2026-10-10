import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chooseProgram,
  compareVersions,
  opencodePrograms,
  type Program,
} from "../../install/detect.js";
import {
  unknownVersionText,
  type VersionProbe,
  versionProbe,
  withVersion,
} from "../../install/probe.js";
import { applyPlan, type FileChange, type Plan } from "../../install.js";
import { ensureLauncher, launcherPath } from "../../timers/launcher.js";
import { rewake } from "../../util/command.js";
import { newerThanTested, untestedText, versionOf } from "../versions.js";

/**
 * `agent-rewake install --only opencode` (a preview, never tried against a real OpenCode or a real
 * limit). OpenCode has no hook that runs a command; it loads every `.js` or `.ts` file in
 * `<config>/plugins/` at start-up and calls the functions the file exports with its events
 * (opencode.ai/docs/plugins; packages/opencode/src/config/plugin.ts globs `{plugin,plugins}/*.{ts,js}`
 * and plugin/index.ts calls every export, so the file exports exactly one function). `<config>` is
 * `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` (packages/core/src/global.ts, xdg-basedir).
 *
 * Rewake writes one file there, `agent-rewake.js`, whose first line says Rewake wrote it. It is
 * replaced on update (the old one backed up first) and deleted on uninstall; a file of the same
 * name that Rewake didn't write is never touched.
 */

export const MIN_OPENCODE = versionOf("opencode").min;

/** The first line of the file Rewake writes: how it tells its own file from the person's. */
const MARK = "// Written by Agent Rewake";

export function opencodeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

export function opencodePluginFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(opencodeConfigDir(env, home), "plugins", "agent-rewake.js");
}

/**
 * The plugin: it only passes OpenCode's events to `agent-rewake hook opencode <event>` on stdin,
 * one at a time and in order, and never throws into OpenCode. Paths go in as JSON strings.
 */
export function pluginSource(node: string, launcher: string): string {
  return `${MARK} (agent-rewake install --only opencode).
// It tells Rewake when an OpenCode session meets a usage limit or finishes a turn, so Rewake can
// continue the session after the limit resets. Rewake replaces this file when it updates and
// deletes it on uninstall: edits made here are lost.
import { spawn } from "node:child_process";

const NODE = ${JSON.stringify(node)};
const LAUNCHER = ${JSON.stringify(launcher)};
const met = new Set();
let queue = Promise.resolve();

function send(name, properties, directory) {
  queue = queue.then(
    () =>
      new Promise((done) => {
        try {
          const child = spawn(NODE, [LAUNCHER, "hook", "opencode", name], {
            stdio: ["pipe", "ignore", "ignore"],
            windowsHide: true,
          });
          const timer = setTimeout(() => {
            child.kill();
            done();
          }, 10000);
          const finish = () => {
            clearTimeout(timer);
            done();
          };
          child.on("error", finish);
          child.on("exit", finish);
          child.stdin.on("error", () => {});
          child.stdin.end(JSON.stringify({ properties, directory }));
        } catch {
          done();
        }
      }),
  );
  return queue;
}

export const AgentRewake = async ({ directory }) => ({
  event: async (input) => {
    try {
      const event = input && input.event;
      const type = event && event.type;
      const properties = event && event.properties;
      const status = properties && properties.status;
      if (type === "session.created") send(type, properties, directory);
      else if (type === "session.error" || (type === "session.status" && status && status.type === "retry")) {
        if (properties.sessionID) met.add(properties.sessionID);
        send(type, properties, directory);
      } else if (type === "session.status" && status && status.type === "idle") send(type, properties, directory);
    } catch {
      // Never a problem for OpenCode.
    }
  },
  "chat.message": async (input) => {
    try {
      send("chat.message", { sessionID: input && input.sessionID }, directory);
    } catch {
      // Never a problem for OpenCode.
    }
  },
  dispose: async () => {
    for (const sessionID of met) send("session.ended", { sessionID }, directory);
    await queue;
  },
});
`;
}

/** Whether the file at `file` is one Rewake wrote. */
function ours(file: string): boolean {
  try {
    return readFileSync(file, "utf8").startsWith(MARK);
  } catch {
    return false;
  }
}

/** Whether Rewake's plugin file is in OpenCode's plugin folder. */
export function opencodeInstalled(env: NodeJS.ProcessEnv, home: string): boolean {
  return ours(opencodePluginFile(env, home));
}

/**
 * The change to the plugin file: Rewake's own file written or replaced. A file of that name that
 * Rewake didn't write is an error, never overwritten. (Removing is `runOpenCodeInstall`'s.)
 */
export function planOpenCode(
  file: string,
  node: string,
  launcher: string,
): Plan | { error: string } {
  const existed = existsSync(file);
  if (existed && !ours(file))
    return {
      error: `Rewake couldn't set up OpenCode: a file named agent-rewake.js is already in OpenCode's plugin folder (${file}) and Rewake didn't write it. Rewake didn't change it. Rename or move it, then run this again.`,
    };
  const before = existed ? readFileSync(file, "utf8") : "";
  const after = pluginSource(node, launcher);
  if (before === after) return { changes: [], notes: [] };
  const change: FileChange = {
    file,
    existed,
    before,
    after,
    summary: [existed ? "Update Rewake's plugin in OpenCode" : "Add Rewake's plugin to OpenCode"],
  };
  return { changes: [change], notes: [] };
}

export interface OpenCodeInstallOptions {
  uninstall: boolean;
  yes: boolean;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  node: string;
  bundle: string;
  interactive: boolean;
  out: (text: string) => void;
  ask: (question: string) => Promise<boolean>;
  home?: string;
  programs?: Program[];
  /** Reads a version detection missed (tests: none). */
  probe?: VersionProbe;
}

export async function runOpenCodeInstall(o: OpenCodeInstallOptions): Promise<number> {
  const home = o.home ?? (o.env.HOME || o.env.USERPROFILE || homedir());
  const file = opencodePluginFile(o.env, home);
  const programs = o.programs ?? opencodePrograms({ env: o.env, home, platform: process.platform });
  const probe = o.probe ?? (o.programs ? () => undefined : versionProbe(o.env, o.node));
  const picked = chooseProgram(programs);
  const opencode = picked && !o.uninstall ? withVersion(picked, probe) : picked;
  if (o.uninstall) {
    if (!ours(file)) {
      o.out(
        existsSync(file)
          ? "The agent-rewake.js file in OpenCode's plugin folder isn't one Rewake wrote, so Rewake leaves it alone.\n"
          : "Rewake isn't set up in OpenCode: nothing to remove.\n",
      );
      return 0;
    }
    o.out(
      `Agent Rewake will delete its plugin from OpenCode:\n  ${file}\nYour own plugins and settings stay.\n`,
    );
  } else {
    if (!opencode) {
      o.out("OpenCode wasn't found on this computer, so there's nothing to set up for it.\n");
      return 1;
    }
    if (opencode.version && compareVersions(opencode.version, MIN_OPENCODE) < 0) {
      o.out(
        `OpenCode ${opencode.version} is too old for Rewake (it needs ${MIN_OPENCODE} or newer). Update it with "opencode upgrade", then run "${rewake("install --only opencode")}" again.\n`,
      );
      return 1;
    }
    const launcher = o.dryRun
      ? launcherPath(o.stateDir)
      : (ensureLauncher(o.stateDir, o.bundle) ?? launcherPath(o.stateDir));
    const plan = planOpenCode(file, o.node, launcher);
    if ("error" in plan) {
      o.out(`${plan.error}\n`);
      return 1;
    }
    if (plan.changes.length === 0) {
      o.out("Rewake is already set up in OpenCode: nothing to change.\n");
      return 0;
    }
    o.out(
      [
        `Agent Rewake (preview, not tried) will ${plan.changes[0]?.existed ? "update" : "add"} a small plugin in OpenCode${opencode.version ? ` (version ${opencode.version} found)` : ""}:`,
        `  ${file}`,
        "",
        "It tells Rewake when a session stops at a usage limit. Nothing else in OpenCode's settings changes, and Rewake continues a session only after you close OpenCode.",
        "",
        "A continued session follows your OpenCode permission settings, which allow most tools without asking by default. Rewake never turns on auto-approve.",
        "",
      ].join("\n"),
    );
    if (!opencode.version)
      o.out(unknownVersionText("OpenCode", MIN_OPENCODE, "opencode upgrade", "opencode"));
    if (opencode.version && newerThanTested("opencode", opencode.version))
      o.out(`${untestedText("opencode", opencode.version)}\n`);
    if (o.dryRun) {
      o.out("Dry run: nothing was changed.\n");
      return 0;
    }
    if (!(await confirmed(o))) return 1;
    applyPlan(plan);
    o.out("\nDone.\nNext, start OpenCode again: it loads plugins when it starts.\n");
    return 0;
  }
  if (o.dryRun) {
    o.out("Dry run: nothing was changed.\n");
    return 0;
  }
  if (!(await confirmed(o))) return 1;
  rmSync(file, { force: true });
  o.out("Done. Rewake is out of OpenCode.\n");
  return 0;
}

/** Whether the person agreed (or passed --yes); says why not when they didn't. */
async function confirmed(o: OpenCodeInstallOptions): Promise<boolean> {
  if (o.yes) return true;
  if (!o.interactive) {
    o.out("Not a terminal, so nothing was changed. Run again with --yes to apply.\n");
    return false;
  }
  if (!(await o.ask("\nApply these changes? [y/N] "))) {
    o.out("Nothing was changed.\n");
    return false;
  }
  return true;
}
