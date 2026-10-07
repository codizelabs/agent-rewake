import { spawnSync } from "node:child_process";

/**
 * A desktop notification, for the times Rewake can't continue on its own (the session is open
 * elsewhere, the reset passed long ago, or the agent is limited again until much later). Plain
 * text only: never message text, folders or account details.
 *
 *   - macOS: `osascript -e 'display notification …'` (the text is an AppleScript string literal).
 *   - Linux: `notify-send`, when a desktop is running.
 *   - Windows: a toast through Windows PowerShell's own app id (Windows.UI.Notifications), the
 *     script passed encoded, the text as single-quoted PowerShell strings. From Microsoft's
 *     documentation; not yet seen on a real desktop (research impl-codex-grok §5.3).
 */
export type Notifier = (title: string, body: string) => boolean;

/** An AppleScript string literal: backslashes and quotes escaped, line breaks as spaces. */
export function appleString(s: string): string {
  return `"${s
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

/** A PowerShell single-quoted string literal: quotes doubled, line breaks as spaces. */
export function psString(s: string): string {
  return `'${s.replace(/[\r\n]+/g, " ").replace(/'/g, "''")}'`;
}

/** Windows PowerShell's app id: toasts need a registered app, and every Windows has this one. */
const POWERSHELL_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** The arguments for `powershell.exe` that show one toast. */
export function toastArgs(title: string, body: string): string[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$n = $t.GetElementsByTagName('text')",
    `$n.Item(0).AppendChild($t.CreateTextNode(${psString(title)})) | Out-Null`,
    `$n.Item(1).AppendChild($t.CreateTextNode(${psString(body)})) | Out-Null`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psString(POWERSHELL_APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
  ].join("; ");
  return [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
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
    if (platform === "win32") return run("powershell.exe", toastArgs(title, body)) === 0;
    return false;
  };
}
