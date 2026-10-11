import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Builds the bundle once before any test file starts. The end-to-end tests run it (dist/), and
// several of them building into the same folder at the same time broke each other's builds.
export default function setup(): void {
  const root = join(import.meta.dirname, "..");
  execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], {
    cwd: root,
    stdio: "ignore",
  });
}
