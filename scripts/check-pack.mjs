// Fails if the npm tarball would contain anything beyond Agent Rewake's own files. In particular,
// Anthropic's SDK and Claude Code binaries must never be bundled or shipped. Also fails if the
// package would make npm download any runtime dependency beyond the pinned Claude adapter.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimeDependencyProblems } from "./runtime-deps.mjs";

// What npm installs with the package: only the pinned Claude adapter (scripts/runtime-deps.mjs).
const problems = runtimeDependencyProblems(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
);
if (problems.length) {
  console.error("Runtime dependencies the npm package may not have:", problems);
  process.exit(1);
}

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
// Size budget (plan §10A.3 bundle-budget): a near-zero-dependency bundle stays small, and the
// Claude Code mod stays readable. Raise these on purpose, never by accident.
// 780 KB from 768 KB: keep-awake for Linux and Windows (the commands and their messages).
// 800 KB from 780 KB: `agent-rewake settings` and cancelling one resume outside Zed (each
// setting's plain-words description and values are most of it).
const BUDGET = { bundle: 800 * 1024, mod: 64 * 1024 };
const size = (re) => pack.files.filter((f) => re.test(f.path)).reduce((n, f) => n + f.size, 0);
const bundle = size(/^dist\/agent-rewake\.js$/);
const mod = size(/^dist\/hosts\/claude-code\//);
if (bundle > BUDGET.bundle || mod > BUDGET.mod) {
  console.error(
    `Over the size budget: bundle ${bundle} bytes (max ${BUDGET.bundle}), Claude Code mod ${mod} bytes (max ${BUDGET.mod}).`,
  );
  process.exit(1);
}
console.log(`npm package contents OK (${files.length} files): ${files.join(", ")}`);
console.log("Runtime dependencies OK: only the pinned Claude adapter.");
console.log(
  `Size: bundle ${Math.round(bundle / 1024)} KB, Claude Code mod ${Math.round(mod / 1024)} KB.`,
);
