import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../util/paths.js";
import { writeFileAtomic } from "./store.js";
import { type Clock, setClock } from "./time.js";

/**
 * Rewake's settings, shared by every Rewake process, the schedules page and the
 * agent's tool server: one file, `settings.json`, in the state directory. Unknown or invalid values
 * fall back to the defaults.
 */
export interface Settings {
  /** How times are shown: "12h" (3:19 PM, the default) or "24h" (15:19). */
  clock: Clock;
  /**
   * Automatic resume after usage limits in new threads: "ask" when a new thread
   * opens (the default), "on" without asking, or "off" (never ask).
   */
  newThreads: NewThreads;
  /** The resume message for new threads that "on" turns automatic resume on for. */
  resumePrompt?: string;
  /**
   * Automatic resume also in threads whose mode skips permission prompts (Claude's "bypass
   * permissions", Codex's full access…). On by default.
   */
  autoWhenPromptsSkipped: boolean;
  /**
   * Keep the computer from idling to sleep while a message is due within a few hours or a
   * scheduled reply runs: "plugged-in" (the default: only on mains power), "always", or "never".
   */
  keepAwake: KeepAwake;
}

export type NewThreads = "ask" | "on" | "off";
export type KeepAwake = "plugged-in" | "always" | "never";

export const DEFAULT_SETTINGS: Settings = {
  clock: "12h",
  newThreads: "ask",
  autoWhenPromptsSkipped: true,
  keepAwake: "plugged-in",
};

export function loadSettings(stateDir: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const clock = raw.clock === "12h" || raw.clock === "24h" ? raw.clock : DEFAULT_SETTINGS.clock;
    const newThreads = raw.newThreads === "on" || raw.newThreads === "off" ? raw.newThreads : "ask";
    const resumePrompt =
      typeof raw.resumePrompt === "string" &&
      raw.resumePrompt.trim() &&
      raw.resumePrompt.length <= 16_384
        ? raw.resumePrompt
        : undefined;
    const autoWhenPromptsSkipped = raw.autoWhenPromptsSkipped !== false;
    const keepAwake =
      raw.keepAwake === "always" || raw.keepAwake === "never"
        ? raw.keepAwake
        : DEFAULT_SETTINGS.keepAwake;
    return {
      clock,
      newThreads,
      autoWhenPromptsSkipped,
      keepAwake,
      ...(resumePrompt && { resumePrompt }),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(stateDir: string, settings: Settings): void {
  writeFileAtomic(
    ensurePrivateDir(stateDir, { tighten: true }),
    "settings.json",
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

/** Read the settings and apply them to this process (the clock used by every time display). */
export function applySettings(stateDir: string): Settings {
  const s = loadSettings(stateDir);
  setClock(s.clock);
  return s;
}
