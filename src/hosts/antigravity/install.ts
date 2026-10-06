import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../core/store.js";
import { agyPrograms, type Program } from "../../install/detect.js";
import { ensureLauncher, launcherPath } from "../../timers/launcher.js";
import { ensurePrivateDir } from "../../util/paths.js";
import { geminiHome } from "./host.js";

/**
 * `agent-rewake install --only antigravity` (a preview, until AG-E1 to AG-E7 are checked with a
 * real account): one plugin folder Rewake owns, `~/.gemini/config/plugins/agent-rewake/`, the
 * documented global plugin location read by Antigravity's app, CLI and IDE. It holds a Stop hook.
 * No Antigravity program is run to install it. Uninstall deletes the folder.
 */

export function pluginDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(geminiHome(env, home), "config", "plugins", "agent-rewake");
}

export function antigravityHooksJson(node: string, launcher: string): string {
  return `${JSON.stringify(
    {
      "agent-rewake": {
        Stop: [
          { type: "command", command: `"${node}" "${launcher}" hook antigravity Stop`, timeout: 5 },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

export interface AntigravityInstallOptions {
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
  programs?: Program[];
}

export async function runAntigravityInstall(o: AntigravityInstallOptions): Promise<number> {
  const home = o.env.HOME || o.env.USERPROFILE || homedir();
  const dir = pluginDir(o.env, home);
  const installed = existsSync(dir);
  if (o.uninstall) {
    if (!installed) {
      o.out("Rewake isn't set up in Antigravity: nothing to remove.\n");
      return 0;
    }
    o.out(`Agent Rewake will delete its plugin folder:\n  ${dir}\n`);
  } else {
    const programs = o.programs ?? agyPrograms({ env: o.env, home, platform: process.platform });
    if (programs.length === 0) {
      o.out(
        "Antigravity CLI (agy) wasn't found on this computer. Rewake continues conversations only in the CLI, so there's nothing to set up.\n",
      );
      return 1;
    }
    o.out(
      [
        `Agent Rewake (preview) will ${installed ? "update" : "add"} its plugin for Antigravity CLI (agy), in Antigravity's settings folder:`,
        `  ${dir}`,
        "",
        "It adds one hook that notes when a conversation stops at a usage limit. Rewake continues conversations in the CLI (agy) only, not in the Antigravity app or IDE. Nothing else in Antigravity's settings changes.",
        "",
      ].join("\n"),
    );
  }
  if (o.dryRun) {
    o.out("Dry run: nothing was changed.\n");
    return 0;
  }
  if (!o.yes) {
    if (!o.interactive) {
      o.out("Not a terminal, so nothing was changed. Run again with --yes to apply.\n");
      return 1;
    }
    if (!(await o.ask("\nApply these changes? [y/N] "))) {
      o.out("Nothing was changed.\n");
      return 1;
    }
  }
  if (o.uninstall) {
    rmSync(dir, { recursive: true, force: true });
    o.out("Done. Rewake is out of Antigravity.\n");
    return 0;
  }
  const launcher = ensureLauncher(o.stateDir, o.bundle) ?? launcherPath(o.stateDir);
  ensurePrivateDir(dir);
  writeFileAtomic(
    dir,
    "plugin.json",
    `${JSON.stringify(
      {
        $schema: "https://antigravity.google/schemas/v1/plugin.json",
        name: "agent-rewake",
        description: "Continues a conversation after a usage limit resets, when you ask.",
      },
      null,
      2,
    )}\n`,
  );
  writeFileAtomic(dir, "hooks.json", antigravityHooksJson(o.node, launcher));
  o.out(
    "\nDone.\nNext, start a new conversation in Antigravity CLI; conversations that are open don't load new plugins.\n",
  );
  return 0;
}
