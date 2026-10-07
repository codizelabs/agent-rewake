import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import type { PlaceId } from "../install/detect.js";
import { copilotHome } from "./copilot/install.js";
import { geminiHooksOn } from "./gemini/install.js";
import { grokHome } from "./grok/host.js";

/**
 * Whether an agent's own settings turn Rewake's hooks off, read from files only (no agent is run):
 *
 *   - GitHub Copilot CLI: `"disableAllHooks": true` in its user settings (research impl-claude-
 *     copilot B.5; a repository's own setting is seen only when its sessions record nothing).
 *   - Grok Build: Rewake's hooks named in `$GROK_HOME/disabled-hooks` (research §2.2, trust.rs).
 *   - Gemini CLI: `"hooksConfig": { "enabled": false }` (on by default, DG-X9).
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
  return undefined;
}
