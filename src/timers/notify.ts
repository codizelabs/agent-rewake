import { spawnSync } from "node:child_process";

/**
 * A desktop notification, for the times Rewake can't continue on its own (the session is open
 * elsewhere, the reset passed long ago, or the agent is limited again until much later). Plain
 * text only: never message text, folders or account details.
 *
 *   - macOS: `osascript -e 'display notification …'` (the text is an AppleScript string literal).
 *   - Linux: `notify-send`, when a desktop is running.
 *   - Windows: not shown yet (no toast without a helper app); `doctor` and the schedules page still
 *     show the resume as needing attention.
 */
export type Notifier = (title: string, body: string) => boolean;

/** An AppleScript string literal: backslashes and quotes escaped, line breaks as spaces. */
export function appleString(s: string): string {
  return `"${s
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

export function osNotifier(
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: string[]) => number | null = (c, a) =>
    spawnSync(c, a, { stdio: "ignore", timeout: 5000, windowsHide: true }).status,
): Notifier {
  return (title, body) => {
    if (platform === "darwin")
      return (
        run("osascript", [
          "-e",
          `display notification ${appleString(body)} with title ${appleString(title)}`,
        ]) === 0
      );
    if (platform === "linux")
      return run("notify-send", ["--app-name=Agent Rewake", title, body]) === 0;
    return false;
  };
}
