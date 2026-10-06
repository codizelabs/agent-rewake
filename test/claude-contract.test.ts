import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeRunner, modInstalled, runClaudeInstall } from "../src/hosts/claude-code/install.js";

/**
 * Against a real Claude Code CLI (plan §9.1.5): the mod passes `claude plugin validate --strict`
 * and its own `claude plugin test` cases, and Rewake's install and uninstall work with Claude
 * Code's plugin commands in a temporary config folder. Runs only with REWAKE_CLAUDE_BIN set (the
 * `contracts` CI job installs the pinned version, CLAUDE_CODE_VERSION) and after a build.
 */
const bin = process.env.REWAKE_CLAUDE_BIN;
const root = fileURLToPath(new URL("..", import.meta.url));

describe.runIf(bin)("Claude Code contract (real CLI)", () => {
  const sandbox = () => {
    const dir = mkdtempSync(join(tmpdir(), "rewake-claude-contract-"));
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    };
    return { dir, home, env, run: claudeRunner(bin ?? "", env, process.execPath) };
  };

  it("validates the mod strictly and passes its own tests", async () => {
    const s = sandbox();
    try {
      const mod = join(root, "src", "hosts", "claude-code", "mod");
      const validate = await s.run(["plugin", "validate", mod, "--strict"]);
      expect(validate.stdout + validate.stderr).toContain("Validation passed");
      const test = await s.run(["plugin", "test", mod]);
      expect(test.status).toBe(0);
      expect(test.stdout + test.stderr).toMatch(/\b0 fail\b/);
    } finally {
      rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);

  it("installs and removes the mod with Claude Code's own commands", async () => {
    const s = sandbox();
    try {
      const state = join(s.dir, "state");
      const opts = {
        yes: true,
        dryRun: false,
        env: s.env,
        stateDir: state,
        node: process.execPath,
        bundle: join(root, "dist", "agent-rewake.js"),
        interactive: false,
        out: () => {},
        ask: async () => true,
        programs: [{ path: bin ?? "", surface: "terminal", version: "9.9.9" }],
      };
      expect(await runClaudeInstall({ ...opts, uninstall: false })).toBe(0);
      expect(modInstalled(s.env, s.home)).toBe(true);
      const settings = JSON.parse(readFileSync(join(s.home, ".claude", "settings.json"), "utf8"));
      expect(settings.enabledPlugins).toEqual({ "rewake@agent-rewake": true });
      expect(settings.extraKnownMarketplaces["agent-rewake"].source.source).toBe("directory");
      const list = await s.run(["plugin", "list", "--json"]);
      expect(JSON.parse(list.stdout)[0]).toMatchObject({
        id: "rewake@agent-rewake",
        enabled: true,
      });

      expect(await runClaudeInstall({ ...opts, uninstall: true })).toBe(0);
      expect(modInstalled(s.env, s.home)).toBe(false);
    } finally {
      rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 180_000);
});
