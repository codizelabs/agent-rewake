import { describe, expect, it } from "vitest";
import { absoluteDir, type Host, stateDir, zedConfigDir, zedDataDir } from "../src/util/paths.js";

// Every OS's rule runs on every OS.
const mac = (env: NodeJS.ProcessEnv = {}): Host => ({ platform: "darwin", home: "/Users/me", env });
const linux = (env: NodeJS.ProcessEnv = {}): Host => ({ platform: "linux", home: "/home/me", env });
const win = (env: NodeJS.ProcessEnv = {}): Host => ({
  platform: "win32",
  home: "C:\\Users\\me",
  env,
});
const none = () => false;

describe("Zed's configuration directory, by Zed's own rule", () => {
  it("macOS: ~/.config/zed, ignoring XDG_CONFIG_HOME as Zed does", () => {
    const env = { XDG_CONFIG_HOME: "/Users/me/xdg" };
    expect(zedConfigDir(env, mac(env), none)).toBe("/Users/me/.config/zed");
  });

  it("Linux: Flatpak's directory first, then an absolute XDG_CONFIG_HOME, then ~/.config", () => {
    const flatpak = {
      FLATPAK_XDG_CONFIG_HOME: "/home/me/.var/app/dev.zed.Zed/config",
      XDG_CONFIG_HOME: "/x",
    };
    expect(zedConfigDir(flatpak, linux(flatpak), none)).toBe(
      "/home/me/.var/app/dev.zed.Zed/config/zed",
    );
    const xdg = { XDG_CONFIG_HOME: "/home/me/cfg" };
    expect(zedConfigDir(xdg, linux(xdg), none)).toBe("/home/me/cfg/zed");
    expect(zedConfigDir({}, linux(), none)).toBe("/home/me/.config/zed");
  });

  it("Linux: an empty or relative XDG value is ignored, never used as a relative path", () => {
    for (const XDG_CONFIG_HOME of ["", "relative/cfg"]) {
      const env = { XDG_CONFIG_HOME };
      expect(zedConfigDir(env, linux(env), none)).toBe("/home/me/.config/zed");
    }
  });

  it("Linux from a host terminal: uses Flatpak Zed's configuration when that's the only one", () => {
    const sandboxed = "/home/me/.var/app/dev.zed.Zed/config/zed";
    expect(zedConfigDir({}, linux(), (p) => p === sandboxed)).toBe(sandboxed);
    expect(zedConfigDir({}, linux(), () => true)).toBe("/home/me/.config/zed"); // both: standard
  });

  it("Windows: %APPDATA%\\Zed, or the roaming profile when APPDATA is unusable", () => {
    const env = { APPDATA: "D:\\Profiles\\me\\Roaming" };
    expect(zedConfigDir(env, win(env), none)).toBe("D:\\Profiles\\me\\Roaming\\Zed");
    const bad = { APPDATA: "" };
    expect(zedConfigDir(bad, win(bad), none)).toBe("C:\\Users\\me\\AppData\\Roaming\\Zed");
  });

  it("AGENT_REWAKE_ZED_CONFIG_DIR wins everywhere", () => {
    const env = { AGENT_REWAKE_ZED_CONFIG_DIR: "/custom" };
    for (const host of [mac(env), linux(env), win(env)])
      expect(zedConfigDir(env, host, none)).toBe("/custom");
  });
});

describe("Zed's data directory", () => {
  it("follows Zed per OS, including Flatpak", () => {
    expect(zedDataDir({}, mac(), none)).toBe("/Users/me/Library/Application Support/Zed");
    expect(zedDataDir({}, linux(), none)).toBe("/home/me/.local/share/zed");
    const flatpak = { FLATPAK_XDG_DATA_HOME: "/home/me/.var/app/dev.zed.Zed/data" };
    expect(zedDataDir(flatpak, linux(flatpak), none)).toBe(
      "/home/me/.var/app/dev.zed.Zed/data/zed",
    );
    expect(zedDataDir({}, linux(), (p) => p.includes("dev.zed.Zed"))).toBe(
      "/home/me/.var/app/dev.zed.Zed/data/zed",
    );
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    expect(zedDataDir(env, win(env), none)).toBe("C:\\Users\\me\\AppData\\Local\\Zed");
  });
});

describe("Rewake's state directory", () => {
  it("is per-user on each OS, and never relative", () => {
    expect(stateDir({}, mac())).toBe("/Users/me/Library/Application Support/agent-rewake");
    expect(stateDir({}, linux())).toBe("/home/me/.local/state/agent-rewake");
    const empty = { XDG_STATE_HOME: "" };
    expect(stateDir(empty, linux(empty))).toBe("/home/me/.local/state/agent-rewake");
    const xdg = { XDG_STATE_HOME: "/var/state" };
    expect(stateDir(xdg, linux(xdg))).toBe("/var/state/agent-rewake");
    expect(stateDir({}, win())).toBe("C:\\Users\\me\\AppData\\Local\\agent-rewake");
  });
});

describe("absoluteDir", () => {
  it("accepts only absolute paths for the platform", () => {
    expect(absoluteDir("C:\\x", "win32")).toBe("C:\\x");
    expect(absoluteDir("x\\y", "win32")).toBeUndefined();
    expect(absoluteDir("/x", "linux")).toBe("/x");
    expect(absoluteDir("", "linux")).toBeUndefined();
    expect(absoluteDir(undefined, "darwin")).toBeUndefined();
  });
});

describe("restart instructions", () => {
  it("name the right way to quit Zed on each OS", async () => {
    const { quitZed } = await import("../src/install.js");
    expect(quitZed("darwin")).toBe("quit Zed completely (Cmd+Q)");
    expect(quitZed("linux")).toBe("quit Zed completely (Ctrl+Q)");
    expect(quitZed("win32")).toBe("close every Zed window so Zed exits");
  });
});

describe("doctor's check of Zed's agent entries", () => {
  it("finds Node or Rewake paths that no longer exist", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { missingLaunchFiles } = await import("../src/install.js");
    const dir = mkdtempSync(join(tmpdir(), "rewake-doctor-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        agent_servers: {
          "claude-acp": {
            type: "custom",
            command: "/old/Cellar/node/22.1.0/bin/node",
            args: ["/opt/rewake/agent-rewake.js", "--wrap-registry", "claude-acp"],
          },
          mine: { type: "custom", command: "my-agent" },
        },
      }),
    );
    const missing = missingLaunchFiles(dir, (p) => p === "/opt/rewake/agent-rewake.js");
    expect(missing).toEqual([{ id: "claude-acp", path: "/old/Cellar/node/22.1.0/bin/node" }]);
    rmSync(dir, { recursive: true, force: true });
  });
});
