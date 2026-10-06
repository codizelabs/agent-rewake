// Fails if the npm tarball would contain anything beyond Agent Rewake's own files. In particular,
// Anthropic's SDK and Claude Code binaries must never be bundled or shipped.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// npm as `node npm-cli.js`: on Windows npm is npm.cmd, which Node won't start without a shell.
const bin = dirname(process.execPath);
const npmCli = [
  join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
].find((p) => existsSync(p));
const [command, args] = npmCli
  ? [process.execPath, [npmCli, "pack", "--dry-run", "--json"]]
  : ["npm", ["pack", "--dry-run", "--json"]];
const [pack] = JSON.parse(execFileSync(command, args, { encoding: "utf8" }));
const files = pack.files.map((f) => f.path);
// Rewake's bundle, and each host's own files under dist/hosts/ (the Claude Code mod).
const allowed =
  /^(dist\/agent-rewake\.js|dist\/hosts\/claude-code\/(\.claude-plugin\/(plugin|marketplace)\.json|hooks\/(hooks\.json|register\.js|logic\.js))|LICENSE|README\.md|package\.json)$/;
const unexpected = files.filter((f) => !allowed.test(f));
const forbidden = files.filter((f) => /anthropic|claude-agent-sdk|claude\.exe/i.test(f));

if (unexpected.length || forbidden.length) {
  console.error("Unexpected files in the npm package:", [
    ...new Set([...unexpected, ...forbidden]),
  ]);
  process.exit(1);
}
console.log(`npm package contents OK (${files.length} files): ${files.join(", ")}`);
