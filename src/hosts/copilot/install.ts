import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../core/store.js";
import { compareVersions, copilotPrograms, type Program } from "../../install/detect.js";
import { ensureLauncher, launcherPath } from "../../timers/launcher.js";
import { ensurePrivateDir } from "../../util/paths.js";

/**
 * `agent-rewake install --only copilot-cli` (a preview, until the real-account checks E-C1 to E-C5
 * pass): one file Rewake owns, `$COPILOT_HOME/hooks/agent-rewake.json`. Copilot loads user hooks
 * from that folder without a trust step, and nothing in the person's settings changes. The hooks
 * use the `exec` + `args` form, so no shell parses the paths (documented from 1.0.92).
 * Uninstall deletes the file.
 */

export const MIN_COPILOT = "1.0.92";
export const COPILOT_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "userPromptSubmitted",
  "errorOccurred",
] as const;

export function copilotHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.COPILOT_HOME || join(home, ".copilot");
}

export function hooksFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(copilotHome(env, home), "hooks", "agent-rewake.json");
}

export function copilotHooksJson(node: string, launcher: string): string {
  const hooks = Object.fromEntries(
    COPILOT_EVENTS.map((event) => [
      event,
      [
        {
          type: "command",
          exec: node,
          args: [launcher, "hook", "copilot-cli", event],
          timeoutSec: 5,
        },
      ],
    ]),
  );
  return `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
}

export interface CopilotInstallOptions {
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

export async function runCopilotInstall(o: CopilotInstallOptions): Promise<number> {
  const home = o.env.HOME || o.env.USERPROFILE || homedir();
  const programs = o.programs ?? copilotPrograms({ env: o.env, home, platform: process.platform });
  const copilot = [...programs].sort((a, b) =>
    compareVersions(b.version ?? "0", a.version ?? "0"),
  )[0];
  const file = hooksFile(o.env, home);
  const installed = existsSync(file);

  if (o.uninstall) {
    if (!installed) {
      o.out("Rewake isn't set up in GitHub Copilot CLI: nothing to remove.\n");
      return 0;
    }
    o.out(`Agent Rewake will delete its hooks file:\n  ${file}\n`);
  } else {
    if (!copilot) {
      o.out(
        "GitHub Copilot CLI wasn't found on this computer, so there's nothing to set up for it.\n",
      );
      return 1;
    }
    const label = `GitHub Copilot CLI${copilot.version ? ` (version ${copilot.version} found)` : ""}`;
    if (copilot.version && compareVersions(copilot.version, MIN_COPILOT) < 0) {
      o.out(
        `GitHub Copilot CLI ${copilot.version} is too old for Rewake (it needs ${MIN_COPILOT} or newer). Update it with "copilot update" (or npm install -g @github/copilot@latest), then run "agent-rewake install --only copilot-cli" again.\n`,
      );
      return 1;
    }
    o.out(
      [
        `Agent Rewake (preview) will ${installed ? "update" : "add"} its hooks file for ${label}:`,
        `  ${file}`,
        "",
        `It adds ${COPILOT_EVENTS.length} hooks that note when a session starts, ends, gets a message or hits a usage limit. Nothing else in Copilot's settings changes.`,
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
    rmSync(file, { force: true });
    o.out("Done. Rewake is out of GitHub Copilot CLI.\n");
    return 0;
  }
  const launcher = ensureLauncher(o.stateDir, o.bundle) ?? launcherPath(o.stateDir);
  writeFileAtomic(
    ensurePrivateDir(join(copilotHome(o.env, home), "hooks")),
    "agent-rewake.json",
    copilotHooksJson(o.node, launcher),
  );
  o.out(
    [
      "",
      "Done.",
      "Next, start a new GitHub Copilot CLI session; sessions that are open don't load new hooks.",
      "",
    ].join("\n"),
  );
  return 0;
}
