import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGrokInstall } from "../src/hosts/grok/install.js";
import { parseVersion, withVersion } from "../src/install/probe.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-probe-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reading an agent's version from --version", () => {
  it("finds the version in each agent's own words", () => {
    expect(parseVersion("2.1.292 (Claude Code)\n")).toBe("2.1.292");
    expect(parseVersion("codex-cli 0.160.1\n")).toBe("0.160.1");
    expect(parseVersion("GitHub Copilot CLI 1.0.92-beta.1\n")).toBe("1.0.92");
    expect(parseVersion("no version here")).toBeUndefined();
  });

  it("asks only when detection found none", () => {
    const asked: string[] = [];
    const probe = (p: string) => {
      asked.push(p);
      return "1.2.3";
    };
    expect(withVersion({ path: "/a", version: "9.9.9" }, probe).version).toBe("9.9.9");
    const b: { path: string; version?: string } = { path: "/b" };
    expect(withVersion(b, probe).version).toBe("1.2.3");
    expect(asked).toEqual(["/b"]);
  });
});

describe("install with a version only --version knows", () => {
  const install = (probe: (p: string) => string | undefined) => {
    let out = "";
    const env = { HOME: dir, GROK_HOME: join(dir, ".grok") };
    return runGrokInstall({
      uninstall: false,
      yes: true,
      dryRun: true,
      env,
      stateDir: join(dir, "state"),
      node: "/n",
      bundle: join(dir, "x.js"),
      interactive: false,
      out: (t) => {
        out += t;
      },
      ask: async () => true,
      programs: [{ path: "/usr/local/bin/grok", surface: "terminal" }],
      probe,
    }).then((code) => ({ code, out }));
  };

  it("refuses a version that's too old, which was skipped before", async () => {
    const r = await install(() => "1.0.20");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Grok Build 1.0.20 is too old for Rewake");
  });

  it("goes on when the version can't be read, and says what to check", async () => {
    const r = await install(() => undefined);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      'Rewake couldn\'t tell which version of Grok Build you have. It needs 1.0.46 or newer: if Rewake doesn\'t respond in Grok Build, update it with "grok update", then run "agent-rewake install --only grok" again.',
    );
  });
});
