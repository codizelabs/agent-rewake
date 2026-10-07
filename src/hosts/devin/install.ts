import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyPlan, type FileChange, type LaunchCommand, type Plan } from "../../install.js";
import { VERSION } from "../../version.js";
import { WRAP_REGISTRY } from "../../wrap.js";

/**
 * `agent-rewake install --only devin-desktop` (a preview): Devin Desktop (formerly Windsurf) runs
 * custom ACP agents listed in `~/.windsurf/acp/registry.json` (Devin Desktop Next:
 * `~/.windsurf-next/…`; Windows: `%USERPROFILE%\AppData\Roaming\Code\User\acp\registry.json`), in
 * the ACP registry's format (docs.devin.ai/desktop/acp, read 2026-10-07; research
 * ide-surfaces-2026-10-07 §4). Rewake adds its own two agents, which run Claude Agent and Codex
 * behind Rewake's ACP add-on, as in Zed; nothing else in the file changes.
 *
 * UNTESTED in Devin Desktop (experiment E-W1): the documented example names an `archive` URL beside
 * `cmd`; whether a local command needs one is unknown, so the entries give none.
 */

export const DEVIN_AGENTS: Record<string, { name: string; registry: string }> = {
  "claude-acp-with-rewake": { name: "Claude Agent (with Rewake)", registry: "claude-acp" },
  "codex-acp-with-rewake": { name: "Codex (with Rewake)", registry: "codex-acp" },
};

/** The registry file, per OS (and Devin Desktop Next's beside it, when that's what's installed). */
export function devinFile(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string {
  if (platform === "win32")
    return join(
      env.USERPROFILE || home,
      "AppData",
      "Roaming",
      "Code",
      "User",
      "acp",
      "registry.json",
    );
  const next = join(home, ".windsurf-next");
  const dir =
    existsSync(join(home, ".windsurf")) || !existsSync(next) ? ".windsurf" : ".windsurf-next";
  return join(home, dir, "acp", "registry.json");
}

/** Devin Desktop (or Windsurf before it) on this computer: its own folder. */
export function devinFound(home: string): boolean {
  return existsSync(join(home, ".windsurf")) || existsSync(join(home, ".windsurf-next"));
}

/** The ACP registry's platform keys. */
function platformKey(platform: NodeJS.Platform, arch: string): string {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  return `${os}-${arch === "arm64" ? "aarch64" : "x86_64"}`;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function devinInstalled(file: string): boolean {
  const agents = readJson(file)?.agents;
  return (
    Array.isArray(agents) &&
    agents.some((a) => {
      const id = (a as { id?: unknown } | null)?.id;
      return typeof id === "string" && id in DEVIN_AGENTS;
    })
  );
}

/** The change to registry.json: Rewake's agents added or updated (or removed), nothing else. */
export function planDevin(
  file: string,
  launch: LaunchCommand,
  uninstall: boolean,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Plan | { error: string } {
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  const parsed = existed ? readJson(file) : { version: "1.0.0", agents: [], extensions: [] };
  if (!parsed)
    return {
      error: `Rewake couldn't set up Devin Desktop: its agent registry file (${file}) isn't valid JSON. Rewake didn't change it. Fix or remove the file, then run this again.`,
    };
  const agents = Array.isArray(parsed.agents)
    ? [...(parsed.agents as Record<string, unknown>[])]
    : [];
  const summary: string[] = [];
  for (const [id, a] of Object.entries(DEVIN_AGENTS)) {
    const at = agents.findIndex((x) => x?.id === id);
    if (uninstall) {
      if (at !== -1) {
        agents.splice(at, 1);
        summary.push(`Remove the agent "${a.name}"`);
      }
      continue;
    }
    const want = {
      id,
      name: a.name,
      version: VERSION,
      description: `${a.registry === "claude-acp" ? "Claude Agent" : "Codex"}, continued after usage limits by Agent Rewake`,
      authors: ["Agent Rewake"],
      license: "Apache-2.0",
      distribution: {
        binary: {
          [platformKey(platform, arch)]: {
            cmd: launch.command,
            args: [...launch.args, WRAP_REGISTRY, a.registry],
          },
        },
      },
    };
    if (at !== -1 && JSON.stringify(agents[at]) === JSON.stringify(want)) continue;
    if (at === -1) agents.push(want);
    else agents[at] = want;
    summary.push(`${at === -1 ? "Add" : "Update"} the agent "${a.name}"`);
  }
  if (summary.length === 0) return { changes: [], notes: [] };
  const after = `${JSON.stringify({ ...parsed, agents }, null, 2)}\n`;
  const change: FileChange = { file, existed, before, after, summary };
  return { changes: [change], notes: [] };
}

export interface DevinInstallOptions {
  uninstall: boolean;
  yes: boolean;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  launch: LaunchCommand;
  interactive: boolean;
  out: (text: string) => void;
  ask: (question: string) => Promise<boolean>;
  home?: string;
  /** Whether Devin Desktop is here (tests). */
  found?: boolean;
}

export async function runDevinInstall(o: DevinInstallOptions): Promise<number> {
  const home = o.home ?? (o.env.HOME || o.env.USERPROFILE || homedir());
  const file = devinFile(o.env, home, process.platform);
  if (!o.uninstall && !(o.found ?? devinFound(home))) {
    o.out(
      "Devin Desktop (formerly Windsurf) wasn't found on this computer. Install it, then run this again.\n",
    );
    return 1;
  }
  const plan = planDevin(file, o.launch, o.uninstall);
  if ("error" in plan) {
    o.out(`${plan.error}\n`);
    return 1;
  }
  if (plan.changes.length === 0) {
    o.out(
      o.uninstall
        ? "Rewake isn't set up in Devin Desktop: nothing to remove.\n"
        : "Rewake is already set up in Devin Desktop: nothing to change.\n",
    );
    return 0;
  }
  o.out(
    [
      o.uninstall
        ? "Agent Rewake will remove its two agents from Devin Desktop:"
        : "Agent Rewake (preview) will add two agents to Devin Desktop:",
      ...Object.values(DEVIN_AGENTS).map((a) => `  - ${a.name}`),
      "Your other agents stay as they are. Rewake keeps a backup of the settings file it changes.",
      "",
    ].join("\n"),
  );
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
  applyPlan(plan);
  o.out(
    o.uninstall
      ? "Done. Rewake is out of Devin Desktop. Restart Devin Desktop to see the change.\n"
      : '\nDone.\nNext, restart Devin Desktop, then pick "Claude Agent (with Rewake)" or "Codex (with Rewake)" in the agent selector when you start a new conversation.\n',
  );
  return 0;
}
