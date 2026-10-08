import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { replaceFileExclusive } from "../util/fs.js";

/**
 * A login item that sets lost timers again after a restart. A resume's timer can be lost when the
 * computer restarts: macOS loads launch jobs from Rewake's own folder only while Rewake runs, and
 * Linux's systemd timers made with `systemd-run` are gone after a reboot. Without this, a resume due
 * after a restart waits until the person next opens an agent. The login item runs
 * `agent-rewake sweep` once at login, which re-arms (or runs) every planned resume (sweep.ts).
 *
 * Only while a preview that continues closed sessions is set up (Codex, Copilot CLI, Gemini CLI,
 * Grok Build, Antigravity CLI); removed with the last one. Windows needs none: its scheduled tasks
 * survive a restart.
 */
export interface LoginHost {
  platform: NodeJS.Platform;
  home: string;
  node: string;
  cli: string;
  stateDir: string;
  run: (cmd: string, args: string[]) => { status: number | null };
  exists: (path: string) => boolean;
}

export const LOGIN_LABEL = "codizelabs.agent-rewake.sweep";
const UNIT = "agent-rewake-sweep.service";

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A word for systemd's ExecStart and a desktop file's Exec: double-quoted, escapes inside. */
const dq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The login item's file and its text for this system; undefined where none is needed. */
export function loginItem(h: LoginHost): { path: string; text: string; kind: string } | undefined {
  const args = [h.node, h.cli, "sweep", "--state-dir", h.stateDir];
  if (h.platform === "darwin")
    return {
      kind: "launchd",
      path: join(h.home, "Library", "LaunchAgents", `${LOGIN_LABEL}.plist`),
      text: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LOGIN_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`,
    };
  if (h.platform === "linux") {
    if (h.exists("/run/systemd/system"))
      return {
        kind: "systemd",
        path: join(h.home, ".config", "systemd", "user", UNIT),
        text: `[Unit]
Description=Agent Rewake: set planned resumes again after a restart

[Service]
Type=oneshot
ExecStart=${args.map(dq).join(" ")}

[Install]
WantedBy=default.target
`,
      };
    return {
      kind: "autostart",
      path: join(h.home, ".config", "autostart", "agent-rewake-sweep.desktop"),
      text: `[Desktop Entry]
Type=Application
Name=Agent Rewake
Comment=Set planned resumes again after a restart
Exec=${args.map(dq).join(" ")}
NoDisplay=true
X-GNOME-Autostart-enabled=true
`,
    };
  }
  return undefined;
}

/** Add, keep or remove the login item. */
export function syncLoginItem(h: LoginHost, wanted: boolean): "added" | "removed" | "unchanged" {
  const item = loginItem(h);
  if (!item) return "unchanged";
  const had = existsSync(item.path);
  if (wanted) {
    const same = had && readFileSync(item.path, "utf8") === item.text;
    if (same) return "unchanged";
    mkdirSync(dirname(item.path), { recursive: true });
    // Atomically, through a temp file only this process can have created. The login item is code
    // the system runs at sign-in, so a write that could be redirected (a symlink planted at a
    // guessable temp path) or read half-written is worth ruling out.
    replaceFileExclusive(item.path, item.text, 0o644);
    if (item.kind === "systemd") {
      h.run("systemctl", ["--user", "daemon-reload"]);
      h.run("systemctl", ["--user", "enable", UNIT]);
    }
    return had ? "unchanged" : "added";
  }
  if (!had) return "unchanged";
  if (item.kind === "systemd") h.run("systemctl", ["--user", "disable", UNIT]);
  rmSync(item.path, { force: true });
  if (item.kind === "systemd") h.run("systemctl", ["--user", "daemon-reload"]);
  return "removed";
}

const WHO = "Codex, Copilot CLI, Gemini CLI, Grok Build and Antigravity CLI";
const NODE_NOTE =
  ' macOS may show "Background Items Added"; it\'s listed as "node" (it runs Agent Rewake) under Login Items, Allow in the Background.';

/** Said before the question, with the other changes, when installing would add it. */
export function loginItemPlanText(platform: NodeJS.Platform): string {
  return `Rewake will also add a login item, so planned resumes are set again after a restart.${
    platform === "darwin" ? NODE_NOTE : ""
  }\n`;
}

/** What install and uninstall say once it's done. */
export function loginItemText(change: "added" | "removed", platform: NodeJS.Platform): string {
  if (change === "removed") return "Removed Rewake's login item: no remaining preview needs it.\n";
  return `Added a login item, so planned resumes are set again after a restart.${
    platform === "darwin" ? NODE_NOTE : ""
  } It's removed when you uninstall the last of ${WHO}.\n`;
}
