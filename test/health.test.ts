import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnoseHealth } from "../src/hosts/health.js";
import { launcherPath } from "../src/timers/launcher.js";
import { nodeShimPath } from "../src/timers/node-shim.js";
import { setRewakeCommand } from "../src/util/command.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-health-"));
  setRewakeCommand("agent-rewake");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const copilot = { id: "copilot-cli" as const, name: "GitHub Copilot CLI" };
const put = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
};

describe("doctor: the pieces hooks and timers run", () => {
  it("says nothing when no preview is set up", () => {
    expect(diagnoseHealth({ stateDir: dir, platform: "linux", previews: [] })).toEqual([]);
  });

  it("says when the helper file is gone, with the command that puts it back", () => {
    const f = diagnoseHealth({ stateDir: dir, platform: "linux", previews: [copilot] });
    expect(f).toEqual([
      {
        area: "Outside Zed",
        level: "problem",
        text: "Rewake's helper file is missing, so the hooks and timers of GitHub Copilot CLI can't run.",
        fix: "Run agent-rewake install --only copilot-cli again to put it back.",
      },
    ]);
  });

  it("says when the Node.js finder is missing, or finds no Node.js 22 or newer", () => {
    put(launcherPath(dir));
    const missing = diagnoseHealth({ stateDir: dir, platform: "linux", previews: [copilot] });
    expect(missing[0]?.text).toContain("Node.js finder is missing");
    put(nodeShimPath(dir));
    const none = diagnoseHealth({
      stateDir: dir,
      platform: "linux",
      previews: [copilot],
      run: () => ({ status: 127 }),
      sessionFiles: () => 1,
    });
    expect(none).toEqual([
      {
        area: "Outside Zed",
        level: "problem",
        text: "Rewake can't find a Node.js 22 or newer, so the hooks and timers of GitHub Copilot CLI can't run.",
        fix: "Install Node.js (nodejs.org), then run agent-rewake doctor again.",
      },
    ]);
  });

  it("is quiet when all works, and notes an agent that was never seen running", () => {
    put(launcherPath(dir));
    put(nodeShimPath(dir));
    const facts = {
      stateDir: dir,
      platform: "linux" as const,
      previews: [copilot],
      run: () => ({ status: 0 }),
    };
    expect(diagnoseHealth({ ...facts, sessionFiles: () => 2 })).toEqual([]);
    const note = diagnoseHealth({ ...facts, sessionFiles: () => 0 });
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({
      level: "info",
      text: "GitHub Copilot CLI is set up, but Rewake hasn't seen it run yet.",
    });
  });

  it("doesn't look for the Node.js finder on Windows", () => {
    put(launcherPath(dir));
    expect(diagnoseHealth({ stateDir: dir, platform: "win32", previews: [copilot] })).toEqual([]);
  });
});
