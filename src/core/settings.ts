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
  /**
   * Send Rewake's own errors to its maintainer, opt-in: "off" (the default; unset means off too)
   * or "on". Never turned on by an install that isn't interactive, and always off when
   * AGENT_REWAKE_ERROR_REPORTS=0, DO_NOT_TRACK=1 or CI is set (src/errors/consent.ts).
   */
  errorReports: ErrorReports;
  /**
   * A resume outside Zed whose project (git commit or uncommitted changes) changed while it
   * waited: "tell" (the default) only tells the person, "note" also adds a fixed line to the
   * message telling the agent to re-read files, "hold" sends nothing and tells the person, "off"
   * does nothing.
   */
  workspaceChanged: WorkspaceChanged;
  /**
   * Claude Code plugin and Codex: a warning at 80% and 95% of a usage window, and when the pace would reach
   * the limit within 45 minutes: "on" (the default) or "off".
   */
  usageWarnings: UsageWarnings;
}

export type NewThreads = "ask" | "on" | "off";
export type KeepAwake = "plugged-in" | "always" | "never";
export type ErrorReports = "on" | "off";
export type WorkspaceChanged = "tell" | "note" | "hold" | "off";
export type UsageWarnings = "on" | "off";

/** The values each choice takes: the rules Zed's Settings form and `agent-rewake settings` share. */
export const CLOCKS: readonly Clock[] = ["12h", "24h"];
export const NEW_THREADS_VALUES: readonly NewThreads[] = ["ask", "on", "off"];
export const KEEP_AWAKE_VALUES: readonly KeepAwake[] = ["plugged-in", "always", "never"];
export const WORKSPACE_CHANGED_VALUES: readonly WorkspaceChanged[] = [
  "tell",
  "note",
  "hold",
  "off",
];
export const USAGE_WARNINGS_VALUES: readonly UsageWarnings[] = ["on", "off"];
/** The longest resume message kept (a longer one falls back to Rewake's own). */
export const MAX_RESUME_PROMPT = 16_384;

/** What Rewake says once keep-awake is changed, wherever it was changed. */
export const KEEP_AWAKE_SAVED: Record<KeepAwake, string> = {
  "plugged-in":
    "Rewake keeps this computer awake for resumes and scheduled messages while it's plugged in.",
  always: "Rewake keeps this computer awake for resumes and scheduled messages, also on battery.",
  never: "Rewake lets this computer sleep, even with messages scheduled.",
};

/** A resume message Rewake keeps: some text, not too long. */
export function validResumePrompt(text: string): boolean {
  return text.trim() !== "" && text.length <= MAX_RESUME_PROMPT;
}

export const DEFAULT_SETTINGS: Settings = {
  clock: "12h",
  newThreads: "ask",
  autoWhenPromptsSkipped: true,
  keepAwake: "plugged-in",
  errorReports: "off",
  workspaceChanged: "tell",
  usageWarnings: "on",
};

export function loadSettings(stateDir: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const clock = CLOCKS.find((c) => c === raw.clock) ?? DEFAULT_SETTINGS.clock;
    const newThreads = NEW_THREADS_VALUES.find((v) => v === raw.newThreads) ?? "ask";
    const resumePrompt =
      typeof raw.resumePrompt === "string" && validResumePrompt(raw.resumePrompt)
        ? raw.resumePrompt
        : undefined;
    const autoWhenPromptsSkipped = raw.autoWhenPromptsSkipped !== false;
    const keepAwake =
      KEEP_AWAKE_VALUES.find((v) => v === raw.keepAwake) ?? DEFAULT_SETTINGS.keepAwake;
    const errorReports = raw.errorReports === "on" ? "on" : DEFAULT_SETTINGS.errorReports;
    const workspaceChanged =
      WORKSPACE_CHANGED_VALUES.find((v) => v === raw.workspaceChanged) ??
      DEFAULT_SETTINGS.workspaceChanged;
    const usageWarnings = raw.usageWarnings === "off" ? "off" : DEFAULT_SETTINGS.usageWarnings;
    return {
      clock,
      newThreads,
      autoWhenPromptsSkipped,
      keepAwake,
      errorReports,
      workspaceChanged,
      usageWarnings,
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
