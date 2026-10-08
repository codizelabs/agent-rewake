// Bundles scripts/site-demos.ts with esbuild (already a dev dependency) and runs it.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const out = join(mkdtempSync(join(tmpdir(), "rewake-demos-")), "site-demos.mjs");
// The bundle runs from a temporary folder, where src/version.ts can't find package.json.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
await build({
  entryPoints: [new URL("./site-demos.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  logLevel: "warning",
  define: { __REWAKE_VERSION__: JSON.stringify(version) },
});
process.env.REWAKE_SITE_GENERATED = new URL("../site/src/generated/", import.meta.url).pathname;
try {
  await import(pathToFileURL(out).href);
} finally {
  rmSync(out, { force: true });
}
