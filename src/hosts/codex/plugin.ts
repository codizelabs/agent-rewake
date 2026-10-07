import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../core/store.js";
import { ensurePrivateDir } from "../../util/paths.js";
import { REPO_URL, VERSION } from "../../version.js";
import { codexCommand, type Program } from "./cli.js";

/**
 * Rewake as a Codex plugin, from a local marketplace in Rewake's own folder (observed on 0.160.1:
 * `codex plugin marketplace add <dir>` then `codex plugin add agent-rewake@agent-rewake`; Codex
 * writes its own config.toml entries, research note §2.1).
 *
 * The hooks run `"<node>" "<stateDir>/bin/agent-rewake.mjs" hook codex <Event>`. Codex runs a hook
 * only after the person trusts it, and keys that trust on the command text, so the text uses the
 * stable launcher (src/timers/launcher.ts) and never a version: updates keep the trust. Rewake
 * never writes the trust record itself.
 */

export const PLUGIN_ID = "agent-rewake@agent-rewake";
export const MARKETPLACE = "agent-rewake";
export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd"] as const;

export function marketplaceDir(stateDir: string): string {
  return join(stateDir, "hosts", "codex-marketplace");
}

const q = (s: string) => `"${s}"`;

/** hooks/hooks.json: the exact command text Codex hashes for trust. */
export function hooksJson(node: string, launcher: string): string {
  const hook = (event: string, timeout: number) => [
    {
      hooks: [
        { type: "command", command: `${q(node)} ${q(launcher)} hook codex ${event}`, timeout },
      ],
    },
  ];
  return `${JSON.stringify(
    {
      description:
        'Agent Rewake: continues this thread after a usage limit, when you ask. Blocks only the prompt "rewake", which it handles itself.',
      hooks: {
        SessionStart: hook("SessionStart", 5),
        UserPromptSubmit: hook("UserPromptSubmit", 5),
        SessionEnd: hook("SessionEnd", 3),
      },
    },
    null,
    2,
  )}\n`;
}

/** Write (or update) the marketplace folder. Returns its path. */
export function writeMarketplace(stateDir: string, node: string, launcher: string): string {
  const root = ensurePrivateDir(marketplaceDir(stateDir));
  const plugin = ensurePrivateDir(join(root, "plugins", "agent-rewake"));
  writeFileAtomic(
    ensurePrivateDir(join(root, ".agents", "plugins")),
    "marketplace.json",
    `${JSON.stringify(
      {
        name: MARKETPLACE,
        interface: { displayName: "Agent Rewake" },
        plugins: [
          {
            name: "agent-rewake",
            source: { source: "local", path: "./plugins/agent-rewake" },
            category: "Productivity",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileAtomic(
    ensurePrivateDir(join(plugin, ".codex-plugin")),
    "plugin.json",
    `${JSON.stringify(
      {
        name: "agent-rewake",
        version: VERSION,
        description: "Continues this thread after a usage limit resets, when you ask.",
        hooks: "./hooks/hooks.json",
        interface: {
          displayName: "Agent Rewake",
          shortDescription: "Continue this thread when your usage limit resets",
          developerName: "Codize Labs",
          category: "Productivity",
          websiteURL: REPO_URL,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileAtomic(ensurePrivateDir(join(plugin, "hooks")), "hooks.json", hooksJson(node, launcher));
  return root;
}

/** Codex's settings folder: CODEX_HOME when set, else ~/.codex. */
export function codexHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.CODEX_HOME || join(home, ".codex");
}

/** Whether Codex's config lists Rewake's plugin (read-only; Codex writes this line itself). */
export function pluginInstalled(env: NodeJS.ProcessEnv, home: string): boolean {
  const file = join(codexHome(env, home), "config.toml");
  if (!existsSync(file)) return false;
  try {
    return readFileSync(file, "utf8").includes(`[plugins."${PLUGIN_ID}"]`);
  } catch {
    return false;
  }
}

export interface StepResult {
  ok: boolean;
  /** The command that failed and its error, for the person and the log. */
  detail?: string;
}

/** Add the marketplace and the plugin with Codex's own commands. */
export async function installPlugin(
  codex: Program,
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<StepResult> {
  const steps = [
    ["plugin", "marketplace", "add", dir, "--json"],
    ["plugin", "add", PLUGIN_ID, "--json"],
  ];
  for (const [i, args] of steps.entries()) {
    const r = await codexCommand(codex, args, env);
    if (r.status !== 0) {
      // Undo the marketplace if the plugin itself couldn't be added, so nothing is left half done.
      if (i > 0) await codexCommand(codex, ["plugin", "marketplace", "remove", MARKETPLACE], env);
      return { ok: false, detail: `codex ${args.join(" ")}: ${r.stderr.trim().slice(0, 300)}` };
    }
  }
  return { ok: true };
}

/** Remove the plugin and the marketplace with Codex's own commands, then Rewake's folder. */
export async function uninstallPlugin(
  codex: Program,
  stateDir: string,
  env: NodeJS.ProcessEnv,
): Promise<StepResult> {
  const remove = await codexCommand(codex, ["plugin", "remove", PLUGIN_ID], env);
  const market = await codexCommand(codex, ["plugin", "marketplace", "remove", MARKETPLACE], env);
  rmSync(marketplaceDir(stateDir), { recursive: true, force: true });
  if (remove.status !== 0 && market.status !== 0)
    return { ok: false, detail: remove.stderr.trim().slice(0, 300) };
  return { ok: true };
}
