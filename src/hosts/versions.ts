import { compareVersions, type PlaceId } from "../install/detect.js";
import { rewake } from "../util/command.js";

/**
 * The agent versions each preview works with. `min` is the oldest Rewake supports (the hooks or
 * mod API it needs); `tested` is the version its contract tests run against (test/agents/
 * package.json, kept equal by test/versions.test.ts), absent where no real program is tested yet.
 */
export interface AgentVersions {
  name: string;
  min: string;
  tested?: string;
  update: string;
}

export const AGENT_VERSIONS: Partial<Record<PlaceId, AgentVersions>> = {
  "claude-code": {
    name: "Claude Code",
    min: "2.1.287",
    tested: "2.1.292",
    update: "claude update (or brew upgrade claude-code@latest)",
  },
  codex: {
    name: "Codex",
    min: "0.149.0",
    tested: "0.160.1",
    update: "npm install -g @openai/codex@latest (or brew upgrade --cask codex)",
  },
  "copilot-cli": {
    name: "GitHub Copilot CLI",
    min: "1.0.92",
    update: "copilot update (or npm install -g @github/copilot@latest)",
  },
  "gemini-cli": {
    name: "Gemini CLI",
    min: "0.62.0",
    tested: "0.62.0",
    update: "npm install -g @google/gemini-cli@latest",
  },
  grok: { name: "Grok Build", min: "1.0.46", tested: "1.0.46", update: "grok update" },
};

export function versionOf(id: PlaceId): AgentVersions {
  const v = AGENT_VERSIONS[id];
  if (!v) throw new Error(`no version table entry for ${id}`);
  return v;
}

/** Whether `found` is older than Rewake supports for `id`. Unknown versions aren't. */
export function tooOld(id: PlaceId, found: string | undefined): boolean {
  const v = AGENT_VERSIONS[id];
  return v !== undefined && found !== undefined && compareVersions(found, v.min) < 0;
}

/** Whether `found` is newer than the version Rewake was tested with for `id`. */
export function newerThanTested(id: PlaceId, found: string | undefined): boolean {
  const v = AGENT_VERSIONS[id];
  return v?.tested !== undefined && found !== undefined && compareVersions(found, v.tested) > 0;
}

/** Said at install, and in `doctor`, for a version newer than the one tested. */
export function untestedText(id: PlaceId, found: string): string {
  const v = versionOf(id);
  return `${v.name} ${found} is newer than the versions Rewake was tested with (up to ${v.tested}). It should still work; if Rewake misses a usage limit there, report it with ${rewake("doctor --details")}.`;
}
