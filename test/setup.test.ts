import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelKey } from "../src/install.js";
import { agentName, detectSetup } from "../src/setup.js";

let dir: string;
let zed: string;
let state: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-setup-"));
  zed = join(dir, "zed");
  state = join(dir, "state");
  mkdirSync(zed);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settings = (text: string) => writeFileSync(join(zed, "settings.json"), text);
const wrapped = {
  type: "custom",
  command: "node",
  args: ["/x/agent-rewake.js", "--wrap-registry", "claude-acp"],
};

describe("detectSetup", () => {
  it("reports a missing settings file without guessing", () => {
    const s = detectSetup(zed, state);
    expect(s).toMatchObject({ settings: "missing", agents: [], withRewake: [], aiOff: false });
    expect(s.lastStart).toBeUndefined();
  });

  it("reads settings with comments and trailing commas, like Zed", () => {
    settings(
      `// mine\n{ "agent_servers": { "claude-acp": ${JSON.stringify(wrapped)}, "codex-acp": { "type": "registry" }, }, }`,
    );
    const s = detectSetup(zed, state);
    expect(s.settings).toBe("ok");
    expect(s.agents).toEqual(["claude-acp", "codex-acp"]);
    expect(s.withRewake).toEqual(["claude-acp"]);
  });

  it("leaves out Rewake's earlier separate agent", () => {
    settings(JSON.stringify({ agent_servers: { "Agent Rewake": wrapped } }));
    expect(detectSetup(zed, state).agents).toEqual([]);
  });

  it("sees when Zed's AI features or its agent are off", () => {
    settings(JSON.stringify({ disable_ai: true }));
    expect(detectSetup(zed, state).aiOff).toBe(true);
    settings(JSON.stringify({ agent: { enabled: false } }));
    expect(detectSetup(zed, state)).toMatchObject({ aiOff: false, agentOff: true });
  });

  it("sees a model picked for Zed's own agent", () => {
    settings(JSON.stringify({ agent: { default_model: { provider: "zed.dev", model: "x" } } }));
    expect(detectSetup(zed, state).usesZedAgent).toBe(true);
    settings(JSON.stringify({ agent: { dock: "right" } }));
    expect(detectSetup(zed, state).usesZedAgent).toBe(false);
  });

  it("calls a file it can't parse invalid", () => {
    settings('{ "agent_servers": ');
    expect(detectSetup(zed, state).settings).toBe("invalid");
  });

  it("finds the last time Zed started Rewake in its own logs", () => {
    mkdirSync(join(state, "logs"), { recursive: true });
    writeFileSync(
      join(state, "logs", "rewake-2026-10-05.jsonl"),
      `${JSON.stringify({ t: "2026-10-05T09:00:00Z", event: "proxy.start", agent: "codex-acp" })}\n`,
    );
    writeFileSync(
      join(state, "logs", "rewake-2026-10-06.jsonl"),
      `${JSON.stringify({ t: "2026-10-06T08:00:00Z", event: "proxy.start", agent: "claude-acp" })}\n{torn`,
    );
    expect(detectSetup(zed, state).lastStart).toEqual({
      at: Date.parse("2026-10-06T08:00:00Z"),
      agent: "claude-acp",
    });
  });
});

describe("names and keys people see", () => {
  it("names Claude Agent even without Zed's registry copy", () => {
    const env = { AGENT_REWAKE_ZED_DATA_DIR: join(dir, "no-data") };
    expect(agentName("claude-acp", env)).toBe("Claude Agent");
    expect(agentName("my-agent", env)).toBe("my-agent");
  });

  it("gives the Agent Panel shortcut for each system (Zed 1.22.0 keymaps)", () => {
    expect(agentPanelKey("darwin")).toBe("Cmd+?");
    expect(agentPanelKey("linux")).toBe("Ctrl+?");
    expect(agentPanelKey("win32")).toBe("Ctrl+Shift+/");
  });
});
