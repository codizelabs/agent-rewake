import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JETBRAINS_AGENTS,
  jetbrainsFile,
  jetbrainsFound,
  jetbrainsInstalled,
  runJetbrainsInstall,
} from "../src/hosts/jetbrains/install.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rewake-jetbrains-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const launch = { command: "/usr/local/bin/node", args: ["/x/agent-rewake.js"] };
const run = (uninstall: boolean, o: { found?: boolean } = {}) => {
  let out = "";
  return runJetbrainsInstall({
    uninstall,
    yes: true,
    dryRun: false,
    env: {},
    launch,
    interactive: false,
    out: (t) => {
      out += t;
    },
    ask: async () => true,
    home,
    found: o.found ?? true,
  }).then((code) => ({ code, out }));
};

describe("JetBrains IDEs: Rewake's agents in AI Assistant", () => {
  it("adds its two agents to acp.json and keeps everything else", async () => {
    const file = jetbrainsFile({}, home);
    mkdirSync(join(home, ".jetbrains"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ default_mcp_settings: { x: 1 }, agent_servers: { Mine: { command: "m" } } }),
    );
    const r = await run(false);
    expect(r.code).toBe(0);
    const v = JSON.parse(readFileSync(file, "utf8"));
    expect(v.default_mcp_settings).toEqual({ x: 1 });
    expect(v.agent_servers.Mine).toEqual({ command: "m" });
    expect(v.agent_servers["Claude Agent (with Rewake)"]).toEqual({
      command: "/usr/local/bin/node",
      args: ["/x/agent-rewake.js", "--wrap-registry", "claude-acp"],
    });
    expect(Object.keys(v.agent_servers)).toEqual(["Mine", ...Object.keys(JETBRAINS_AGENTS)]);
    expect(jetbrainsInstalled({}, home)).toBe(true);
    expect(r.out).toContain("restart your JetBrains IDE");
    // Again: nothing to change.
    expect((await run(false)).out).toContain("already set up");
    // Uninstall removes only Rewake's entries.
    expect((await run(true)).code).toBe(0);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(after.agent_servers)).toEqual(["Mine"]);
  });

  it("leaves a file it can't read alone, and says when no JetBrains IDE is here", async () => {
    mkdirSync(join(home, ".jetbrains"), { recursive: true });
    writeFileSync(jetbrainsFile({}, home), "{ not json");
    expect((await run(false)).out).toContain("isn't valid JSON. Rewake didn't change it.");
    rmSync(join(home, ".jetbrains"), { recursive: true });
    expect((await run(false, { found: false })).code).toBe(1);
    expect(existsSync(jetbrainsFile({}, home))).toBe(false);
  });

  it("finds JetBrains IDEs by their settings folder", () => {
    expect(jetbrainsFound({}, home, "darwin")).toBe(false);
    mkdirSync(join(home, "Library", "Application Support", "JetBrains"), { recursive: true });
    expect(jetbrainsFound({}, home, "darwin")).toBe(true);
  });
});
