import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  devinFile,
  devinInstalled,
  planDevin,
  runDevinInstall,
} from "../src/hosts/devin/install.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rewake-devin-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const launch = { command: "/usr/local/bin/node", args: ["/x/agent-rewake.js"] };

describe("Devin Desktop: Rewake's agents in its ACP registry file", () => {
  it("adds its agents in the registry format and keeps the person's", async () => {
    expect(devinFile({}, home, "darwin")).toBe(join(home, ".windsurf", "acp", "registry.json"));
    // The file and platform key install uses on the computer running the test.
    const file = devinFile({}, home, process.platform);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: "1.0.0",
        agents: [{ id: "mine" }],
        extensions: [],
      }),
    );
    const plan = planDevin(file, launch, false, "darwin", "arm64");
    expect("changes" in plan && plan.changes[0]?.summary).toEqual([
      'Add the agent "Claude Agent (with Rewake)"',
      'Add the agent "Codex (with Rewake)"',
    ]);
    const planned = JSON.parse(("changes" in plan && plan.changes[0]?.after) || "{}");
    expect(planned.agents[1].distribution.binary).toEqual({
      "darwin-aarch64": {
        cmd: "/usr/local/bin/node",
        args: ["/x/agent-rewake.js", "--wrap-registry", "claude-acp"],
      },
    });
    let out = "";
    expect(
      await runDevinInstall({
        uninstall: false,
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
        found: true,
      }),
    ).toBe(0);
    const v = JSON.parse(readFileSync(file, "utf8"));
    expect(v.agents[0]).toEqual({ id: "mine" });
    const os =
      process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    const key = `${os}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
    expect(v.agents[1].distribution.binary[key]).toEqual({
      cmd: "/usr/local/bin/node",
      args: ["/x/agent-rewake.js", "--wrap-registry", "claude-acp"],
    });
    expect(devinInstalled(file)).toBe(true);
    expect(out).toContain("restart Devin Desktop");
    // Uninstall removes only Rewake's agents.
    const back = planDevin(file, launch, true);
    expect("changes" in back && JSON.parse(back.changes[0]?.after ?? "{}").agents).toEqual([
      { id: "mine" },
    ]);
  });

  it("leaves an unreadable file alone", () => {
    mkdirSync(join(home, ".windsurf", "acp"), { recursive: true });
    const file = devinFile({}, home, "linux");
    writeFileSync(file, "{ nope");
    expect(planDevin(file, launch, false)).toMatchObject({
      error: expect.stringContaining("isn't valid JSON"),
    });
  });
});
