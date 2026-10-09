import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import type { PlaceId } from "../install/detect.js";
import { claudeConfigDir } from "./claude-code/install.js";
import { copilotHome } from "./copilot/install.js";
import { geminiHooksOn } from "./gemini/install.js";
import { grokHome } from "./grok/host.js";
import { qwenHooksOff } from "./qwen/install.js";

/**
 * Whether an agent's own settings turn Rewake's hooks off, read from files only (no agent is run):
 *
 *   - GitHub Copilot CLI: `"disableAllHooks": true` in its user settings (research impl-claude-
 *     copilot B.5; a repository's own setting is seen only when its sessions record nothing).
 *   - Grok Build: Rewake's hooks named in `$GROK_HOME/disabled-hooks` (research §2.2, trust.rs).
 *   - Gemini CLI: `"hooksConfig": { "enabled": false }` (on by default, DG-X9).
 *   - Qwen Code: `"disableAllHooks": true` in its user settings (hooks.md).
 *
 * Returns where it's turned off, in words for the person, or undefined.
 */
export function hooksTurnedOff(
  place: PlaceId,
  env: NodeJS.ProcessEnv,
  home: string,
): string | undefined {
  if (place === "copilot-cli") {
    const file = join(copilotHome(env, home), "settings.json");
    try {
      const s = parse(readFileSync(file, "utf8")) as { disableAllHooks?: unknown } | undefined;
      return s?.disableAllHooks === true
        ? `"disableAllHooks": true in GitHub Copilot CLI's settings`
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (place === "grok") {
    try {
      const text = readFileSync(join(grokHome(env, home), "disabled-hooks"), "utf8");
      return /agent-rewake/.test(text) ? "Grok Build's list of turned-off hooks" : undefined;
    } catch {
      return undefined;
    }
  }
  if (place === "gemini-cli")
    return geminiHooksOn(env, home)
      ? undefined
      : `"hooksConfig": { "enabled": false } in Gemini CLI's settings`;
  if (place === "qwen-code")
    return qwenHooksOff(env, home) ? `"disableAllHooks": true in Qwen Code's settings` : undefined;
  return undefined;
}

/**
 * Claude Code settings that make it keep retrying a rate-limited request instead of ending the
 * turn, so the `StopFailure` hook Rewake listens to never fires:
 *
 *   - `CLAUDE_CODE_RETRY_WATCHDOG`: a boolean in Claude Code 2.1.282 (its strings). It switches
 *     the 429 retry path to waiting, with 300 retries by default instead of 10;
 *   - `CLAUDE_CODE_MAX_RETRIES` of 10 or more.
 *
 * The cux wrapper (inulute/cux, internal/wrapper/claudeenv.go) warns about the same two for the
 * same reason. Read from the environment Claude Code is started with and from `env` in its user
 * `settings.json`; nothing is run. Whether a subscription usage limit goes through that retry
 * path is not established here, so the wording says "may".
 */
export interface RetrySetting {
  name: "CLAUDE_CODE_RETRY_WATCHDOG" | "CLAUDE_CODE_MAX_RETRIES";
  /** Where it is set, in words for the person. */
  where: string;
}

const OFF = new Set(["", "0", "false", "no", "off"]);

function keepsRetrying(name: RetrySetting["name"], value: unknown): boolean {
  if (value === true) return name === "CLAUDE_CODE_RETRY_WATCHDOG";
  const v = typeof value === "number" ? String(value) : value;
  if (typeof v !== "string") return false;
  const t = v.trim().toLowerCase();
  if (name === "CLAUDE_CODE_RETRY_WATCHDOG") return !OFF.has(t);
  return /^\d+$/.test(t) && Number(t) >= 10;
}

export function claudeRetrySettings(env: NodeJS.ProcessEnv, home: string): RetrySetting[] {
  let inFile: Record<string, unknown> = {};
  try {
    const s = parse(readFileSync(join(claudeConfigDir(env, home), "settings.json"), "utf8")) as
      | { env?: unknown }
      | undefined;
    if (s?.env && typeof s.env === "object") inFile = s.env as Record<string, unknown>;
  } catch {
    // No settings file, or one that isn't JSON: nothing to read.
  }
  const out: RetrySetting[] = [];
  for (const name of ["CLAUDE_CODE_RETRY_WATCHDOG", "CLAUDE_CODE_MAX_RETRIES"] as const) {
    if (keepsRetrying(name, env[name])) out.push({ name, where: "in this terminal's environment" });
    else if (keepsRetrying(name, inFile[name]))
      out.push({ name, where: "in the env section of Claude Code's settings.json" });
  }
  return out;
}
