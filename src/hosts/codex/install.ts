import { homedir } from "node:os";
import { codexPrograms, compareVersions, type Program as Found } from "../../install/detect.js";
import { ensureLauncher, launcherPath } from "../../timers/launcher.js";
import { codexProgram } from "./cli.js";
import {
  CODEX_HOOK_EVENTS,
  installPlugin,
  marketplaceDir,
  pluginInstalled,
  uninstallPlugin,
  writeMarketplace,
} from "./plugin.js";

/**
 * `agent-rewake install --only codex` and `uninstall --only codex` (a preview: Codex is installed
 * only when named, until the real-account checks of plan §9.2.5 pass).
 *
 * Codex's own plugin commands do the install; Codex records it in its own settings. The one thing
 * the person does is trust Rewake's hooks in Codex: Rewake never does that for them.
 */

/** `codex queue` arrived in 0.149.0 (2026-08-20); hooks and hook trust are older. */
export const MIN_CODEX = "0.149.0";

export interface CodexInstallOptions {
  uninstall: boolean;
  yes: boolean;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  node: string;
  /** The running Rewake, copied to the stable launcher the hooks run. */
  bundle: string;
  interactive: boolean;
  out: (text: string) => void;
  ask: (question: string) => Promise<boolean>;
  /** Overridable for tests. */
  programs?: Found[];
  install?: typeof installPlugin;
  uninstall_?: typeof uninstallPlugin;
}

/** The Codex to install with: the newest CLI, else the copy inside the ChatGPT app. */
export function pickCodex(programs: Found[]): Found | undefined {
  const byVersion = (a: Found, b: Found) => compareVersions(b.version ?? "0", a.version ?? "0");
  const cli = programs.filter((p) => p.surface === "terminal").sort(byVersion);
  return cli[0] ?? [...programs].sort(byVersion)[0];
}

export async function runCodexInstall(o: CodexInstallOptions): Promise<number> {
  const home = o.env.HOME || o.env.USERPROFILE || homedir();
  const programs = o.programs ?? codexPrograms({ env: o.env, home, platform: process.platform });
  const codex = pickCodex(programs);
  if (!codex) {
    o.out("Codex wasn't found on this computer, so there's nothing to set up for it.\n");
    return 1;
  }
  const label = `Codex${codex.version ? ` ${codex.version}` : ""}`;
  const program = codexProgram(codex.path, o.node);
  const installed = pluginInstalled(o.env, home);

  if (o.uninstall) {
    if (!installed) {
      o.out("Rewake isn't set up in Codex: nothing to remove.\n");
      return 0;
    }
    o.out(
      `Agent Rewake will remove its plugin from ${label}, with Codex's own commands:\n  codex plugin remove agent-rewake@agent-rewake\n  codex plugin marketplace remove agent-rewake\n`,
    );
  } else {
    if (codex.version && compareVersions(codex.version, MIN_CODEX) < 0) {
      o.out(
        `${label} is too old for Rewake (it needs ${MIN_CODEX} or newer). Update Codex, then run this again: npm install -g @openai/codex@latest (or brew upgrade --cask codex).\n`,
      );
      return 1;
    }
    o.out(
      [
        `Agent Rewake (preview) will ${installed ? "update its plugin in" : "add its plugin to"} ${label}, with Codex's own commands:`,
        `  codex plugin marketplace add "${marketplaceDir(o.stateDir)}"`,
        "  codex plugin add agent-rewake@agent-rewake",
        "",
        "Codex records this in its own settings; Rewake doesn't edit them.",
        `The plugin has ${CODEX_HOOK_EVENTS.length} hooks. Codex runs them only after you trust them.`,
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
    const r = await (o.uninstall_ ?? uninstallPlugin)(program, o.stateDir, o.env);
    if (!r.ok) {
      o.out(`Codex couldn't remove the plugin: ${r.detail ?? "unknown error"}\n`);
      return 1;
    }
    o.out("Done. Rewake is out of Codex.\n");
    return 0;
  }

  const launcher = ensureLauncher(o.stateDir, o.bundle) ?? launcherPath(o.stateDir);
  const dir = writeMarketplace(o.stateDir, o.node, launcher);
  const r = await (o.install ?? installPlugin)(program, dir, o.env);
  if (!r.ok) {
    o.out(`Codex couldn't add the plugin, so nothing was changed. ${r.detail ?? ""}\n`);
    return 1;
  }
  o.out(
    [
      "",
      "Done.",
      'Next, open Codex. It shows "Hooks need review": choose Review hooks and trust the Agent Rewake hooks.',
      'Then, when a thread hits its usage limit, type "rewake" in it. Rewake continues the thread when the limit resets.',
      "",
    ].join("\n"),
  );
  return 0;
}
