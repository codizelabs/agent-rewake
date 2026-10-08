import { existsSync } from "node:fs";
import type { PlaceId } from "../install/detect.js";
import { pluginDir as antigravityPluginDir } from "./antigravity/install.js";
import { modInstalled } from "./claude-code/install.js";
import { pluginInstalled } from "./codex/plugin.js";
import { hooksFile as copilotHooksFile } from "./copilot/install.js";
import { cursorInstalled } from "./cursor/install.js";
import { devinFile, devinInstalled } from "./devin/install.js";
import { extensionDir as geminiExtensionDir } from "./gemini/install.js";
import { grokHooksFile } from "./grok/install.js";
import { jetbrainsInstalled } from "./jetbrains/install.js";

/**
 * Which previews (`install --only <place>`) are set up on this computer, read-only, so `install`
 * and `doctor` say where Rewake works instead of only "in Zed's Agent Panel". Each name says
 * what the preview covers: Codex's covers its terminal, not its desktop app.
 */
export const PREVIEW_NAMES: Partial<Record<PlaceId, string>> = {
  "claude-code": "Claude Code (terminal)",
  codex: "Codex (terminal)",
  "copilot-cli": "GitHub Copilot CLI",
  grok: "Grok Build",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity CLI",
  jetbrains: "JetBrains IDEs (AI Assistant)",
  "devin-desktop": "Devin Desktop (formerly Windsurf)",
  cursor: "Cursor (its own agent)",
};

export function installedPreviews(
  env: NodeJS.ProcessEnv,
  home: string,
  stateDir: string,
): PlaceId[] {
  const checks: [PlaceId, () => boolean][] = [
    ["claude-code", () => modInstalled(env, home)],
    ["codex", () => pluginInstalled(env, home)],
    ["copilot-cli", () => existsSync(copilotHooksFile(env, home))],
    ["grok", () => existsSync(grokHooksFile(env, home))],
    ["gemini-cli", () => existsSync(geminiExtensionDir(stateDir))],
    ["antigravity", () => existsSync(antigravityPluginDir(env, home))],
    ["jetbrains", () => jetbrainsInstalled(env, home)],
    ["devin-desktop", () => devinInstalled(devinFile(env, home, process.platform))],
    ["cursor", () => cursorInstalled(home)],
  ];
  return checks.filter(([, on]) => on()).map(([id]) => id);
}
