import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { codexProgram } from "../src/hosts/codex/cli.js";
import {
  hooksJson,
  installPlugin,
  uninstallPlugin,
  writeMarketplace,
} from "../src/hosts/codex/plugin.js";

/**
 * Against a real Codex CLI (plan §10.2 L2): Codex's own plugin commands install Rewake's plugin
 * from its local marketplace, Codex lists exactly Rewake's hooks with the planned command text, as
 * untrusted (Rewake never trusts them for the person), and removal leaves Codex's config clean.
 * Runs only with REWAKE_CODEX_BIN set to a codex program (the `contracts` CI job installs the
 * version pinned in test/agents/package.json), in a temporary CODEX_HOME.
 */
const bin = process.env.REWAKE_CODEX_BIN;

function hooksList(codex: ReturnType<typeof codexProgram>, env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ command: string; trustStatus: string; source: string }[]>(
    (resolve, reject) => {
      const child = spawn(codex.command, [...codex.args, "app-server", "--listen", "stdio://"], {
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("hooks/list timed out"));
      }, 30_000);
      const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
      createInterface({ input: child.stdout }).on("line", (line) => {
        const m = JSON.parse(line) as { id?: number; result?: { data?: { hooks: never[] }[] } };
        if (m.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
        } else if (m.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(m.result?.data?.[0]?.hooks ?? []);
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "agent_rewake", title: "Agent Rewake", version: "0" } },
      });
    },
  );
}

describe.runIf(bin)("Codex contract (real CLI)", () => {
  it("installs Rewake's hooks as untrusted with the planned commands, and removes them cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rewake-codex-contract-"));
    try {
      const home = join(dir, "home");
      mkdirSync(join(home, ".codex"), { recursive: true });
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, ".codex"),
        NO_BROWSER: "true",
      };
      const codex = codexProgram(bin ?? "");
      const state = join(dir, "state");
      const launcher = join(state, "bin", "agent-rewake.mjs");
      const market = writeMarketplace(state, process.execPath, launcher);
      expect(await installPlugin(codex, market, env)).toEqual({ ok: true });
      const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
      expect(config).toContain('[plugins."agent-rewake@agent-rewake"]');
      expect(config).not.toContain("trusted_hash");

      const hooks = await hooksList(codex, env, dir);
      const planned = Object.values(
        JSON.parse(hooksJson(process.execPath, launcher)).hooks as Record<
          string,
          { hooks: { command: string }[] }[]
        >,
      ).map((g) => g[0]?.hooks[0]?.command);
      expect(hooks.map((h) => h.command).sort()).toEqual([...planned].sort());
      for (const h of hooks) expect([h.source, h.trustStatus]).toEqual(["plugin", "untrusted"]);

      expect(await uninstallPlugin(codex, state, env)).toEqual({ ok: true });
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).not.toContain(
        "agent-rewake@agent-rewake",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});
