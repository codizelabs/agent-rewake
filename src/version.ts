import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** Where the project lives. Shown only where the user looks for it: About, help, install. */
export const REPO_URL = "https://github.com/codizelabs/agent-rewake";

/** Where people can support the project. Shown next to REPO_URL, never on its own. */
export const SUPPORT_URL = "https://ko-fi.com/R5R31N7TP";

/** Agent Rewake's own package.json (works from src/ and from dist/). */
const pkg: { name?: string; version?: string } = (() => {
  try {
    const require = createRequire(import.meta.url);
    return JSON.parse(readFileSync(require.resolve("../package.json"), "utf8"));
  } catch {
    return {};
  }
})();

/** Set by the build (scripts/build.mjs); undefined when running from src/ in tests. */
declare const __REWAKE_VERSION__: string | undefined;

/** Agent Rewake's own version. */
export const VERSION: string =
  pkg.version ?? (typeof __REWAKE_VERSION__ === "string" ? __REWAKE_VERSION__ : "0.0.0");

/** The npm package name, for pinned `npx` launches. */
export const PACKAGE_NAME: string = pkg.name ?? "@codizelabs/agent-rewake";

/** True when running from source (no build stamp): error reports tag this as "development". */
export const FROM_SOURCE: boolean = typeof __REWAKE_VERSION__ !== "string";
