import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LoginHost,
  loginItem,
  loginItemPlanText,
  loginItemText,
  syncLoginItem,
} from "../src/timers/login.js";

let home: string;
let ran: string[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rewake-login-"));
  ran = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const host = (platform: NodeJS.Platform, systemd = true): LoginHost => ({
  platform,
  home,
  node: "/opt/node 24/bin/node",
  cli: `${home}/Library/Application Support/agent-rewake/bin/agent-rewake.mjs`,
  stateDir: `${home}/Library/Application Support/agent-rewake`,
  run: (cmd, args) => {
    ran.push([cmd, ...args].join(" "));
    return { status: 0 };
  },
  exists: (p) => (p === "/run/systemd/system" ? systemd : existsSync(p)),
});

describe("Rewake's login item", () => {
  it("macOS: a launch agent that runs sweep once at login", () => {
    const item = loginItem(host("darwin"));
    expect(item?.path).toBe(
      join(home, "Library", "LaunchAgents", "codizelabs.agent-rewake.sweep.plist"),
    );
    expect(item?.text).toContain("<key>RunAtLoad</key><true/>");
    expect(item?.text).toContain("<string>/opt/node 24/bin/node</string>");
    expect(item?.text).toContain("<string>sweep</string><string>--state-dir</string>");
    expect(item?.text).not.toContain("StartCalendarInterval");
  });

  it("Linux: a systemd user service, or an autostart entry without systemd; quoted paths", () => {
    const unit = loginItem(host("linux"));
    expect(unit?.path).toBe(join(home, ".config", "systemd", "user", "agent-rewake-sweep.service"));
    expect(unit?.text).toContain('ExecStart="/opt/node 24/bin/node" ');
    expect(unit?.text).toContain('"sweep" "--state-dir"');
    expect(unit?.text).toContain("WantedBy=default.target");
    const desktop = loginItem(host("linux", false));
    expect(desktop?.path).toBe(join(home, ".config", "autostart", "agent-rewake-sweep.desktop"));
    expect(desktop?.text).toContain('Exec="/opt/node 24/bin/node" ');
  });

  it("Windows needs none: its scheduled tasks survive a restart", () => {
    expect(loginItem(host("win32"))).toBeUndefined();
    expect(syncLoginItem(host("win32"), true)).toBe("unchanged");
  });

  it("is added once, kept, and removed when no longer wanted", () => {
    const h = host("linux");
    expect(syncLoginItem(h, true)).toBe("added");
    expect(ran).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable agent-rewake-sweep.service",
    ]);
    expect(syncLoginItem(h, true)).toBe("unchanged");
    const path = loginItem(h)?.path as string;
    expect(readFileSync(path, "utf8")).toContain("sweep");
    expect(syncLoginItem(h, false)).toBe("removed");
    expect(existsSync(path)).toBe(false);
    expect(ran).toContain("systemctl --user disable agent-rewake-sweep.service");
    expect(syncLoginItem(h, false)).toBe("unchanged");
  });

  it("says what was added, and how it shows on macOS", () => {
    expect(loginItemText("added", "darwin")).toBe(
      'Added a login item, so planned resumes are set again after a restart. macOS may show "Background Items Added"; it\'s listed as "node" (it runs Agent Rewake) under Login Items, Allow in the Background. It\'s removed when you uninstall the last of Codex, Copilot CLI, Gemini CLI, Grok Build and Antigravity CLI.\n',
    );
    expect(loginItemText("added", "linux")).not.toContain("macOS");
    expect(loginItemText("removed", "linux")).toBe(
      "Removed Rewake's login item: no remaining preview needs it.\n",
    );
    expect(loginItemPlanText("darwin")).toMatch(/^Rewake will also add a login item/);
  });
});
