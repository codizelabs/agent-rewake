import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../core/store.js";
import {
  chooseProgram,
  compareVersions,
  grokPrograms,
  type Program,
} from "../../install/detect.js";
import {
  unknownVersionText,
  type VersionProbe,
  versionProbe,
  withVersion,
} from "../../install/probe.js";
import { ensureLauncher, launcherPath } from "../../timers/launcher.js";
import { rewake } from "../../util/command.js";
import { ensurePrivateDir } from "../../util/paths.js";
import { hooksTurnedOff } from "../policy.js";
import { newerThanTested, untestedText, versionOf } from "../versions.js";
import { grokHome } from "./host.js";

/**
 * `agent-rewake install --only grok` (a preview, until the real-account checks X-G1 to X-G5 pass):
 * one file Rewake owns, `$GROK_HOME/hooks/agent-rewake.json`, a documented user location that Grok
 * always trusts (observed on 1.0.46: `grok inspect --json` lists the hooks as `user`). Grok reads
 * hooks when a session starts. Uninstall deletes the file. Rewake never passes `--trust`.
 */

export const MIN_GROK = versionOf("grok").min;
export const GROK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "StopFailure",
  "SessionEnd",
] as const;

export function grokHooksFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(grokHome(env, home), "hooks", "agent-rewake.json");
}

/** Grok runs hook commands through a shell, so both paths are quoted. */
export function grokHooksJson(node: string, launcher: string): string {
  const cmd = (event: string) => `"${node}" "${launcher}" hook grok ${event}`;
  const hooks = Object.fromEntries(
    GROK_EVENTS.map((event) => [
      event,
      [
        {
          ...(event === "StopFailure" && { matcher: "rate_limit|invalid_request" }),
          hooks: [
            { type: "command", command: cmd(event), timeout: event === "SessionEnd" ? 2 : 5 },
          ],
        },
      ],
    ]),
  );
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

export interface GrokInstallOptions {
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
  /** Reads a version detection missed (tests: none). */
  probe?: VersionProbe;
}

export async function runGrokInstall(o: GrokInstallOptions): Promise<number> {
  const home = o.env.HOME || o.env.USERPROFILE || homedir();
  const programs = o.programs ?? grokPrograms({ env: o.env, home, platform: process.platform });
  const probe = o.probe ?? (o.programs ? () => undefined : versionProbe(o.env, o.node));
  const picked = chooseProgram(programs);
  const grok = picked && !o.uninstall ? withVersion(picked, probe) : picked;
  const file = grokHooksFile(o.env, home);
  const installed = existsSync(file);

  if (o.uninstall) {
    if (!installed) {
      o.out("Rewake isn't set up in Grok Build: nothing to remove.\n");
      return 0;
    }
    o.out(`Agent Rewake will delete its hooks file:\n  ${file}\n`);
  } else {
    if (!grok) {
      o.out("Grok Build wasn't found on this computer, so there's nothing to set up for it.\n");
      return 1;
    }
    if (grok.version && compareVersions(grok.version, MIN_GROK) < 0) {
      o.out(
        `Grok Build ${grok.version} is too old for Rewake (it needs ${MIN_GROK} or newer). Update it with "grok update", then run "${rewake("install --only grok")}" again.\n`,
      );
      return 1;
    }
    o.out(
      [
        `Agent Rewake (preview) will ${installed ? "update" : "add"} its hooks file for Grok Build${grok.version ? ` (version ${grok.version} found)` : ""}:`,
        `  ${file}`,
        "",
        `It adds ${GROK_EVENTS.length} hooks that note when a session starts, ends, gets a message or hits Grok's weekly usage limit. At a usage limit, type "/rewake" in the session to continue after the reset, choose a time, or cancel. Rewake doesn't resume after a spending cap. Nothing else in Grok's settings changes.`,
        "",
      ].join("\n"),
    );
  }
  if (!o.uninstall && grok && !grok.version)
    o.out(unknownVersionText("Grok Build", MIN_GROK, "grok update", "grok"));
  if (!o.uninstall && grok?.version && newerThanTested("grok", grok.version))
    o.out(`${untestedText("grok", grok.version)}\n`);
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
    o.out("Done. Rewake is out of Grok Build.\n");
    return 0;
  }
  const launcher = ensureLauncher(o.stateDir, o.bundle) ?? launcherPath(o.stateDir);
  writeFileAtomic(
    ensurePrivateDir(join(grokHome(o.env, home), "hooks")),
    "agent-rewake.json",
    grokHooksJson(o.node, launcher),
  );
  o.out(
    "\nDone.\nNext, start a new Grok Build session; sessions that are open don't load new hooks.\n",
  );
  const off = hooksTurnedOff("grok", o.env, home);
  if (off)
    o.out(
      "But Grok Build has its hooks turned off, so Rewake won't see its usage limits until you turn them back on.\n",
    );
  return 0;
}
