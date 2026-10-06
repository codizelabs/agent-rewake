import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexProgram as nodeAware } from "../src/hosts/codex/cli.js";
import { writeExtension } from "../src/hosts/gemini/install.js";

/**
 * Against a real Gemini CLI (plan §9.5): Gemini links Rewake's extension from its folder and
 * removes it again. Gemini needs an auth setting even to list extensions, so the test sets a fake
 * API key (nothing is sent: no model call is made) and answers Gemini's question with --consent,
 * which Rewake itself never passes for a person. Runs only with REWAKE_GEMINI_BIN set.
 */
const bin = process.env.REWAKE_GEMINI_BIN;

describe.runIf(bin)("Gemini CLI contract (real CLI)", () => {
  it("links and removes Rewake's extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rewake-gemini-contract-"));
    try {
      mkdirSync(join(dir, ".gemini"), { recursive: true });
      writeFileSync(join(dir, ".gemini", "settings.json"), '{"hooksConfig":{"enabled":true}}');
      const env = {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        GEMINI_CLI_HOME: dir,
        GEMINI_API_KEY: "fake-key-for-offline-test",
        NO_BROWSER: "true",
      };
      const program = nodeAware(bin ?? "");
      const gemini = (args: string[]) =>
        new Promise<string>((resolve, reject) =>
          execFile(
            program.command,
            [...program.args, ...args],
            { env, timeout: 90_000 },
            (err, stdout, stderr) =>
              err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(`${stdout}${stderr}`),
          ),
        );
      const ext = writeExtension(
        join(dir, "state"),
        process.execPath,
        join(dir, "state", "bin", "agent-rewake.mjs"),
      );
      expect(await gemini(["extensions", "link", ext, "--consent"])).toContain(
        '"agent-rewake" linked successfully',
      );
      expect(await gemini(["extensions", "list"])).toContain("agent-rewake");
      expect(await gemini(["extensions", "uninstall", "agent-rewake"])).toContain(
        "successfully uninstalled",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 240_000);
});
