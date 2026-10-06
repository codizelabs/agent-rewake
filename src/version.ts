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

/** Agent Rewake's own version. */
export const VERSION: string = pkg.version ?? "0.0.0";

/** The npm package name, for pinned `npx` launches. */
export const PACKAGE_NAME: string = pkg.name ?? "@codizelabs/agent-rewake";
