import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokHooksJson } from "../src/hosts/grok/install.js";

/**
 * Against a real Grok Build (plan §9.4.4): Grok loads Rewake's hooks file from `$GROK_HOME/hooks`
 * as user hooks, all four events, with the limit matcher. `grok inspect --json` runs offline.
 * Runs only with REWAKE_GROK_BIN set (the `contracts` CI job installs the pinned version).
 */
const bin = process.env.REWAKE_GROK_BIN;

describe.runIf(bin)("Grok contract (real CLI)", () => {
  it("loads Rewake's hooks as user hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rewake-grok-contract-"));
    try {
      const home = join(dir, ".grok");
      mkdirSync(join(home, "hooks"), { recursive: true });
      const launcher = join(dir, "state", "bin", "agent-rewake.mjs");
      writeFileSync(
        join(home, "hooks", "agent-rewake.json"),
        grokHooksJson(process.execPath, launcher),
      );
      const out = await new Promise<string>((resolve, reject) =>
        execFile(
          bin ?? "",
          ["inspect", "--json"],
          {
            cwd: dir,
            env: { ...process.env, HOME: dir, GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1" },
            timeout: 60_000,
          },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        ),
      );
      const hooks = (
        JSON.parse(out) as {
          hooks: {
            event: string;
            target: string;
            source: { type: string };
            matcher: string | null;
          }[];
        }
      ).hooks.filter((h) => h.target.includes("agent-rewake.mjs"));
      expect(hooks.map((h) => h.event).sort()).toEqual([
        "session_end",
        "session_start",
        "stop_failure",
        "user_prompt_submit",
      ]);
      for (const h of hooks) expect(h.source.type).toBe("user");
      expect(hooks.find((h) => h.event === "stop_failure")?.matcher).toBe(
        "rate_limit|invalid_request",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});
