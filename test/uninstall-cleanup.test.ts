import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hooksFile as copilotHooksFile } from "../src/hosts/copilot/install.js";
import {
  findBackups,
  finishUninstall,
  leftoverText,
  removeHelpers,
} from "../src/install/cleanup.js";
import { launcherPath } from "../src/timers/launcher.js";
import { nodeShimPath } from "../src/timers/node-shim.js";
import type { RunResult, TimerHost } from "../src/timers/timers.js";

const ID = "0f6c3a1e-6b1d-4d7a-9a51-2b8c4f1e9d10";
let root: string;
let home: string;
let state: string;
let zed: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rewake-uninstall-"));
  home = join(root, "home");
  state = join(root, "state");
  zed = join(root, "zed");
  for (const d of [home, state, zed]) mkdirSync(d);
  env = {
    HOME: home,
    AGENT_REWAKE_STATE_DIR: state,
    AGENT_REWAKE_ZED_CONFIG_DIR: zed,
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (path: string, text = "x") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};

/** What Rewake writes into its folder while a place that runs hooks is set up, plus the person's data. */
function populate(o: { timers?: boolean } = {}) {
  const made = {
    launcher: file(launcherPath(state), "// launcher"),
    version: file(join(state, "bin", "agent-rewake.version"), "0.3.1\n"),
    shim: file(nodeShimPath(state), "#!/bin/sh\n"),
    ...(o.timers && { timer: file(join(state, "timers", `${ID}.systemd`), "") }),
    lock: file(join(state, "locks", "abc.lock"), "{}"),
    marker: file(join(state, ".pruned"), "1\n"),
  };
  const mine = {
    schedule: file(join(state, "schedules", `${ID}.json`), "{}"),
    settings: file(join(state, "settings.json"), "{}"),
    log: file(join(state, "logs", "rewake-2026-10-01.jsonl"), "{}\n"),
    agent: file(join(state, "agents", "tool", "bin"), "binary"),
    // Not Rewake's: it must stay, and so must the folder it is in.
    other: file(join(state, "bin", "my-own-script.sh"), "echo hi"),
  };
  return { made, mine };
}

function fakeHost(): { h: TimerHost; calls: string[][] } {
  const calls: string[][] = [];
  const h: TimerHost = {
    platform: "linux",
    stateDir: state,
    node: "/n",
    cli: "/c.mjs",
    run: (command, args) => {
      calls.push([command, ...args]);
      return {
        status: 0,
        stdout: args.includes("is-system-running") ? "running\n" : "",
        stderr: "",
      } satisfies RunResult;
    },
    detached: () => {},
    exists: (p) => p === "/run/systemd/system",
    uid: () => 1000,
  };
  return { h, calls };
}

describe("removing what hooks and timers ran", () => {
  it("cancels every timer through the system, then removes the timer files, launcher and Node.js finder", () => {
    const { made } = populate({ timers: true });
    const { h, calls } = fakeHost();

    removeHelpers(state, h);

    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "stop",
      `codizelabs-agent-rewake-${ID}.timer`,
    ]);
    for (const f of Object.values(made)) expect(existsSync(f), f).toBe(false);
    expect(existsSync(join(state, "timers"))).toBe(false);
  });

  it("never deletes the person's data, or a file of theirs in Rewake's bin folder", () => {
    const { mine } = populate();
    removeHelpers(state, fakeHost().h);
    for (const f of Object.values(mine)) expect(existsSync(f), f).toBe(true);
    expect(readdirSync(join(state, "bin"))).toEqual(["my-own-script.sh"]);
  });

  it("removes the bin folder itself when nothing else is in it", () => {
    populate();
    rmSync(join(state, "bin", "my-own-script.sh"));
    removeHelpers(state, fakeHost().h);
    expect(existsSync(join(state, "bin"))).toBe(false);
  });
});

describe("finishing an uninstall", () => {
  it("leaves everything alone while a place still has Rewake, and says which", () => {
    const { made, mine } = populate();
    file(copilotHooksFile(env, home), '{ "version": 1, "hooks": {} }');

    const done = finishUninstall({ env, home, platform: process.platform, chosen: ["codex"] });

    expect(done.remains).toBe(true);
    for (const f of [...Object.values(made), ...Object.values(mine)])
      expect(existsSync(f), f).toBe(true);
    expect(done.text).toContain("Rewake is still set up in GitHub Copilot CLI");
    expect(done.text).toContain("deleting them would break it");
    expect(done.text).toContain("agent-rewake uninstall");
  });

  it("counts Zed's entries as a place too", () => {
    const { made } = populate();
    file(
      join(zed, "settings.json"),
      JSON.stringify({
        agent_servers: {
          "claude-acp": {
            type: "custom",
            command: process.execPath,
            args: [join(root, "agent-rewake.js"), "--wrap-registry", "claude-acp"],
          },
        },
      }),
    );

    const done = finishUninstall({
      env,
      home,
      platform: process.platform,
      chosen: ["claude-code"],
    });

    expect(done.remains).toBe(true);
    expect(done.text).toContain("still set up in Zed");
    expect(existsSync(made.launcher)).toBe(true);
  });

  it("removes the helpers once no place has Rewake, and lists exactly what stays", () => {
    const { made, mine } = populate();
    const backup = file(join(zed, "settings.json.agent-rewake-backup-20261008-120000"));
    file(join(zed, "settings.json"), "{}");

    const done = finishUninstall({ env, home, platform: process.platform, chosen: ["codex"] });

    expect(done.remains).toBe(false);
    for (const f of Object.values(made)) expect(existsSync(f), f).toBe(false);
    for (const f of [...Object.values(mine), backup, join(zed, "settings.json")])
      expect(existsSync(f), f).toBe(true);
    expect(done.text).toBe(
      `\nRewake is out of every place, and its timers, login item and helper files are removed. Still on your computer, because they're yours:\n` +
        `  Rewake's folder, with your scheduled messages, your settings, logs (no message text) and agents Rewake downloaded: ${state}\n` +
        `  A copy Rewake made of a file before changing it: ${backup}\n` +
        `  Codex's own note that it trusted Rewake's hooks (Codex keeps it; Rewake can't remove it)\n` +
        `Nothing runs from that folder any more, so you can delete it, and the copies, when you don't need them.\n`,
    );
  });

  it("has nothing to say where Rewake never wrote a folder", () => {
    rmSync(state, { recursive: true });
    const done = finishUninstall({ env, home, platform: process.platform, chosen: ["zed"] });
    expect(done).toEqual({ text: undefined, remains: false });
    expect(existsSync(state)).toBe(false);
  });
});

describe("what stays", () => {
  it("finds the copies Rewake made next to the files it changed", () => {
    const a = file(join(zed, "settings.json.agent-rewake-backup-20261008-120000"));
    const b = file(join(zed, "tasks.json.agent-rewake-backup-20261008-120000"));
    file(join(zed, "settings.json"));
    expect(findBackups([zed, join(root, "nowhere")])).toEqual([a, b]);
  });

  it("names only what exists", () => {
    file(join(state, "settings.json"), "{}");
    expect(leftoverText({ stateDir: state, stillIn: [], backups: [], codex: false })).toContain(
      `Rewake's folder, with your settings: ${state}`,
    );
    rmSync(join(state, "settings.json"));
    expect(
      leftoverText({ stateDir: state, stillIn: [], backups: [], codex: false }),
    ).toBeUndefined();
  });
});
