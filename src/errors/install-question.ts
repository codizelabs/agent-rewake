import { loadSettings, saveSettings } from "../core/settings.js";
import { canAskAboutErrorReports } from "./consent.js";

/**
 * `install` asks about error reports once, in plain words, default No (AGENTS.md "Consent"). Never
 * asked again once answered; never asked at all when the install isn't interactive (no TTY, CI,
 * DO_NOT_TRACK=1) — those installs simply leave reporting off.
 */
const QUESTION_TEXT = `
Agent Rewake can send a short error report to its maintainer when it hits a bug.
  Sent: the kind of error, which part of Rewake it was in, the place it ran (Zed,
  Claude Code, Codex, …), Rewake's version, your OS and Node version.
  Never sent: your messages, agent output, file contents, tokens, session ids,
  usernames, hostnames or full file paths.
You can turn this on or off any time: agent-rewake errors on|off. It's off by default.
`;

export async function maybeAskErrorReports(
  stateDir: string,
  env: NodeJS.ProcessEnv,
  interactive: boolean,
  ask: (question: string) => Promise<boolean>,
  out: (text: string) => void = (t) => process.stdout.write(t),
): Promise<void> {
  const settings = loadSettings(stateDir);
  if (settings.errorReportsAsked) return;
  if (!canAskAboutErrorReports(interactive, env)) return;
  out(QUESTION_TEXT);
  const yes = await ask("Send error reports? [y/N] ");
  saveSettings(stateDir, {
    ...settings,
    errorReports: yes ? "on" : "off",
    errorReportsAsked: true,
  });
  out(
    yes
      ? "Error reports: on. Change this any time with agent-rewake errors off.\n"
      : "Error reports: off.\n",
  );
}
