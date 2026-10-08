import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureNodeShim, ephemeralNode, nodeShimPath } from "../src/timers/node-shim.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-shim-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The shim's own run of `-p`: what it prints is the Node.js it found. */
const run = (shim: string, env: NodeJS.ProcessEnv) =>
  spawnSync(shim, ["-p", "process.execPath + ' ' + process.argv.length"], {
    encoding: "utf8",
    env,
  });

describe.skipIf(process.platform === "win32")("the Node.js finder", () => {
  it("runs the recorded Node.js with the same arguments while it exists", () => {
    const shim = ensureNodeShim(dir, process.execPath, "linux");
    expect(shim).toBe(nodeShimPath(dir));
    const r = run(shim ?? "", { PATH: "/nowhere", HOME: dir });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(new RegExp(`^${process.execPath.replace(/[/.]/g, "\\$&")} `));
  });

  it("finds another Node.js when the recorded one has been removed", () => {
    const gone = join(dir, "removed", "bin", "node");
    const shim = ensureNodeShim(dir, process.execPath, "linux") ?? "";
    // Pretend the Node.js it was installed with was uninstalled.
    writeFileSync(shim, readFileSync(shim, "utf8").replace(process.execPath, gone));
    chmodSync(shim, 0o700);
    // A working Node.js on PATH (a copy standing in for the person's other install).
    const bin = join(dir, "other", "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    chmodSync(join(bin, "node"), 0o755);
    const r = run(shim, { PATH: `${bin}:/usr/bin:/bin`, HOME: join(dir, "nohome") });
    // Some working Node.js ran (a standard location, or the one on PATH), not the removed one.
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/node/);
    expect(r.stdout).not.toContain(gone);
  });

  it("says so when there is no Node.js 22 or newer at all", () => {
    const shim = ensureNodeShim(dir, process.execPath, "linux") ?? "";
    writeFileSync(shim, readFileSync(shim, "utf8").replace(process.execPath, join(dir, "x")));
    chmodSync(shim, 0o700);
    const r = run(shim, { PATH: "/nowhere", HOME: join(dir, "nohome") });
    // Homebrew, /usr/local and /usr/bin may hold one on this computer: only an empty search fails.
    if (r.status !== 0) {
      expect(r.status).toBe(127);
      expect(r.stderr).toContain("no Node.js 22 or newer found");
    }
  });

  it("keeps the recorded Node.js while it works, and never records a short-lived one", () => {
    ensureNodeShim(dir, process.execPath, "linux");
    const before = readFileSync(nodeShimPath(dir), "utf8");
    ensureNodeShim(dir, "/somewhere/else/node", "linux");
    expect(readFileSync(nodeShimPath(dir), "utf8")).toBe(before);
    const fresh = mkdtempSync(join(tmpdir(), "rewake-shim2-"));
    try {
      ensureNodeShim(fresh, "/run/user/1000/fnm_multishells/123_456/bin/node", "linux");
      expect(readFileSync(nodeShimPath(fresh), "utf8")).not.toContain("RECORDED=");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
    expect(ephemeralNode("/home/me/.local/state/fnm_multishells/1_2/bin/node")).toBe(true);
    expect(ephemeralNode("/opt/homebrew/bin/node")).toBe(false);
  });

  it("isn't used on Windows", () => {
    expect(ensureNodeShim(dir, process.execPath, "win32")).toBeUndefined();
    expect(existsSync(nodeShimPath(dir))).toBe(false);
  });
});
