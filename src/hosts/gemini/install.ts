import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { writeFileAtomic } from "../../core/store.js";
import { compareVersions, geminiPrograms, type Program } from "../../install/detect.js";
import {
  unknownVersionText,
  type VersionProbe,
  versionProbe,
  withVersion,
} from "../../install/probe.js";
import { ensureLauncher, launcherPath } from "../../timers/launcher.js";
import { ensurePrivateDir } from "../../util/paths.js";
import { VERSION } from "../../version.js";
import { codexProgram as nodeAware } from "../codex/cli.js";
import { newerThanTested, untestedText, versionOf } from "../versions.js";
import { REWAKE_MARKER } from "./host.js";

/**
 * `agent-rewake install --only gemini-cli` (a preview, until GG-G1/GG-G3 are checked with a real
 * account): a Gemini CLI extension in Rewake's own folder, linked with Gemini's own command so
 * updating Rewake updates it:
 *
 *   gemini extensions link <stateDir>/hosts/gemini-extension
 *
 * run with the terminal attached and without --consent, so the person answers Gemini's own
 * security question about hooks. Gemini runs extension hooks only when its `hooksConfig.enabled`
 * setting is on; install checks that first. Uninstall: `gemini extensions uninstall agent-rewake`.
 */

export const MIN_GEMINI = versionOf("gemini-cli").min;
export const GEMINI_EVENTS = ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent"] as const;

export function extensionDir(stateDir: string): string {
  return join(stateDir, "hosts", "gemini-extension");
}

/** Gemini CLI's own folder: `${GEMINI_CLI_HOME:-$HOME}/.gemini`. */
export function geminiSettingsFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.GEMINI_CLI_HOME || home, ".gemini", "settings.json");
}

interface GeminiSettings {
  hooksConfig?: { enabled?: unknown };
  security?: { auth?: { selectedType?: unknown } };
  selectedAuthType?: unknown;
}

function readGeminiSettings(env: NodeJS.ProcessEnv, home: string): GeminiSettings | undefined {
  try {
    return parse(readFileSync(geminiSettingsFile(env, home), "utf8")) as GeminiSettings;
  } catch {
    return undefined;
  }
}

/**
 * Whether Gemini CLI runs extension hooks, read-only. `hooksConfig.enabled` defaults to on
 * (Gemini CLI settingsSchema.ts, research DG-X9): only an explicit `false` turns them off.
 */
export function geminiHooksOn(env: NodeJS.ProcessEnv, home: string): boolean {
  return readGeminiSettings(env, home)?.hooksConfig?.enabled !== false;
}

/** Whether Gemini CLI signs in with an API key (whose daily quota resets at midnight Pacific). */
export function geminiApiKeyAuth(env: NodeJS.ProcessEnv, home: string): boolean {
  const s = readGeminiSettings(env, home);
  return (s?.security?.auth?.selectedType ?? s?.selectedAuthType) === "gemini-api-key";
}

export function geminiHooksJson(node: string, launcher: string): string {
  const hooks = Object.fromEntries(
    GEMINI_EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            {
              type: "command",
              name: `agent-rewake-${event.replace(/[A-Z]/g, (c, i) => (i ? "-" : "") + c.toLowerCase())}`,
              command: `"${node}" "${launcher}" hook gemini-cli ${event}`,
              timeout: 5000,
            },
          ],
        },
      ],
    ]),
  );
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

export function writeExtension(stateDir: string, node: string, launcher: string): string {
  const dir = ensurePrivateDir(extensionDir(stateDir));
  writeFileAtomic(
    dir,
    "gemini-extension.json",
    `${JSON.stringify({ name: "agent-rewake", version: VERSION }, null, 2)}\n`,
  );
  writeFileAtomic(
    ensurePrivateDir(join(dir, "hooks")),
    "hooks.json",
    geminiHooksJson(node, launcher),
  );
  // `/rewake`: its marker prompt is answered by the BeforeAgent hook, never by the model.
  writeFileAtomic(
    ensurePrivateDir(join(dir, "commands")),
    "rewake.toml",
    `description = "Agent Rewake: continue after the usage limit resets. Also: /rewake 3:30pm, /rewake cancel, /rewake help"\nprompt = "${REWAKE_MARKER} {{args}}"\n`,
  );
  return dir;
}

export interface GeminiInstallOptions {
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
  /** Run gemini with the terminal attached; returns its exit status. */
  run?: (program: string, args: string[]) => number | null;
  installed?: () => boolean;
}

export async function runGeminiInstall(o: GeminiInstallOptions): Promise<number> {
  const home = o.env.HOME || o.env.USERPROFILE || homedir();
  const programs = o.programs ?? geminiPrograms({ env: o.env, home, platform: process.platform });
  const probe = o.probe ?? (o.programs ? () => undefined : versionProbe(o.env, o.node));
  const picked = [...programs].sort((a, b) =>
    compareVersions(b.version ?? "0", a.version ?? "0"),
  )[0];
  const gemini = picked && !o.uninstall ? withVersion(picked, probe) : picked;
  const run =
    o.run ??
    ((program: string, args: string[]) => {
      const p = nodeAware(program, o.node);
      return spawnSync(p.command, [...p.args, ...args], { stdio: "inherit", env: o.env }).status;
    });
  const installed = o.installed?.() ?? existsSync(extensionDir(o.stateDir));
  if (!gemini) {
    o.out(
      o.uninstall
        ? "Gemini CLI wasn't found on this computer.\n"
        : "Gemini CLI wasn't found on this computer, so there's nothing to set up for it.\n",
    );
    return o.uninstall ? 0 : 1;
  }

  if (o.uninstall) {
    if (!installed) {
      o.out("Rewake isn't set up in Gemini CLI: nothing to remove.\n");
      return 0;
    }
    o.out(
      "Agent Rewake will remove its extension from Gemini CLI, with Gemini's own command:\n  gemini extensions uninstall agent-rewake\n",
    );
  } else {
    if (gemini.version && compareVersions(gemini.version, MIN_GEMINI) < 0) {
      o.out(
        `Gemini CLI ${gemini.version} is too old for Rewake (it needs ${MIN_GEMINI} or newer). Update it with "npm install -g @google/gemini-cli@latest", then run "agent-rewake install --only gemini-cli" again.\n`,
      );
      return 1;
    }
    if (!geminiHooksOn(o.env, home)) {
      o.out(
        `Gemini CLI's hooks are turned off ("hooksConfig": { "enabled": false } in ${geminiSettingsFile(o.env, home)}), and Rewake needs them. Nothing was changed. To use Rewake, change false to true there (this turns all Gemini CLI hooks back on, including any of your own), then run "agent-rewake install --only gemini-cli" again.\n`,
      );
      return 1;
    }
    o.out(
      [
        `Agent Rewake (preview) will add its extension to Gemini CLI${gemini.version ? ` (version ${gemini.version} found)` : ""}, with Gemini's own command:`,
        `  gemini extensions link "${extensionDir(o.stateDir)}"`,
        "",
        `It adds ${GEMINI_EVENTS.length} hooks that note when a session starts, ends, gets a message or stops at a usage limit. Gemini CLI asks you to confirm them.`,
        "",
      ].join("\n"),
    );
  }
  if (!o.uninstall && gemini && !gemini.version)
    o.out(
      unknownVersionText(
        "Gemini CLI",
        MIN_GEMINI,
        "npm install -g @google/gemini-cli@latest",
        "gemini-cli",
      ),
    );
  if (!o.uninstall && gemini?.version && newerThanTested("gemini-cli", gemini.version))
    o.out(`${untestedText("gemini-cli", gemini.version)}\n`);
  if (o.dryRun) {
    o.out("Dry run: nothing was changed.\n");
    return 0;
  }
  if (!o.interactive) {
    // Gemini asks its own question, which needs a terminal: never answered for the person.
    o.out(
      o.uninstall
        ? "Not a terminal, so nothing was changed. Run this in a terminal: gemini extensions uninstall agent-rewake\n"
        : `Not a terminal, so nothing was changed. Run "agent-rewake install --only gemini-cli" in a terminal; Gemini CLI asks you to confirm.\n`,
    );
    return 1;
  }
  if (!o.yes && !(await o.ask("\nApply these changes? [y/N] "))) {
    o.out("Nothing was changed.\n");
    return 1;
  }

  if (o.uninstall) {
    const status = run(gemini.path, ["extensions", "uninstall", "agent-rewake"]);
    rmSync(extensionDir(o.stateDir), { recursive: true, force: true });
    o.out(
      status === 0
        ? "Done. Rewake is out of Gemini CLI.\n"
        : "Gemini CLI couldn't remove the extension. Try: gemini extensions uninstall agent-rewake\n",
    );
    return status === 0 ? 0 : 1;
  }
  const launcher = ensureLauncher(o.stateDir, o.bundle) ?? launcherPath(o.stateDir);
  const dir = writeExtension(o.stateDir, o.node, launcher);
  const status = run(gemini.path, ["extensions", "link", dir]);
  if (status === 41) {
    rmSync(dir, { recursive: true, force: true });
    o.out(
      "Sign in to Gemini CLI first (run gemini once), then run this again. Nothing was changed.\n",
    );
    return 1;
  }
  if (status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    o.out("Gemini CLI didn't add the extension, so nothing was changed.\n");
    return 1;
  }
  o.out(
    "\nDone.\nNext, start a new Gemini CLI session; sessions that are open don't load new hooks.\n",
  );
  return 0;
}
