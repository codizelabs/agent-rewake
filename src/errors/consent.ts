import type { Settings } from "../core/settings.js";

/**
 * Whether error reports may be sent, opt-in and off unless turned on (AGENTS.md: "opt-in, never on
 * by default"). Environment overrides always win over the stored setting, and always turn it off:
 * there is no environment way to turn it on when the setting is "off".
 */
export function errorReportsEnabled(
  settings: Pick<Settings, "errorReports">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.AGENT_REWAKE_ERROR_REPORTS === "0") return false;
  if (env.DO_NOT_TRACK === "1") return false;
  if (env.CI === "true" || env.CI === "1") return false;
  return settings.errorReports === "on";
}

/** "production" normally; "development" when running from source (no built dist/ version stamp). */
export function reportingEnvironment(fromSource: boolean): "production" | "development" {
  return fromSource ? "development" : "production";
}

/** A non-interactive install (no TTY, or CI) must never turn error reports on. */
export function canAskAboutErrorReports(
  interactive: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!interactive) return false;
  if (env.CI === "true" || env.CI === "1") return false;
  if (env.DO_NOT_TRACK === "1") return false;
  return true;
}
