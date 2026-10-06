// Bundles Agent Rewake's own code into one ESM file. The Claude adapter, and through it Anthropic's
// SDK, stays external and is installed by npm: it is never bundled.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/agent-rewake.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Prefer ESM builds: jsonc-parser's UMD build loads its parts with a dynamic require.
  mainFields: ["module", "main"],
  // Only the Claude adapter stays external: it is installed by npm and must never be bundled.
  // Small, permissively licensed helpers (jsonc-parser) are bundled into the single file.
  external: ["@agentclientprotocol/claude-agent-acp", "@anthropic-ai/*"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
