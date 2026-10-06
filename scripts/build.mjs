// Bundles Agent Rewake's own code into one ESM file. The Claude adapter, and through it Anthropic's
// SDK, stays external and is installed by npm: it is never bundled.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

// The version is written into the bundle, so a copy of it (the stable launcher hooks and timers
// run, plan §3.6) knows its version without a package.json beside it.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

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
  define: { __REWAKE_VERSION__: JSON.stringify(version) },
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

// The Claude Code mod: plain, readable files (Claude Code's plugin directory asks for unminified
// code), copied as they are. Only the version is filled in. Its tests stay in the repository.
const mod = new URL("../dist/hosts/claude-code/", import.meta.url);
rmSync(mod, { recursive: true, force: true });
cpSync(new URL("../src/hosts/claude-code/mod/", import.meta.url), mod, {
  recursive: true,
  filter: (src) => !/[\\/]tests([\\/]|$)/.test(src),
});
const manifest = new URL(".claude-plugin/plugin.json", mod);
writeFileSync(
  manifest,
  `${JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }, null, 2)}\n`,
);
console.log(`  dist/hosts/claude-code (the Claude Code mod, ${version})`);
