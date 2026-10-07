// The package as people get it (plan §10A.3 tarball-smoke): `npm pack`, install the .tgz alone in
// an empty folder, then run the installed program: --version, doctor, and a dry-run install for
// every place. Each run must finish without a crash (exit 0, or 1 for "something to do"); no agent
// needs to be present. Usage: node scripts/tarball-smoke.mjs <empty work folder>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const work = resolve(process.argv[2] ?? "tarball-smoke");
mkdirSync(work, { recursive: true });

// npm as `node npm-cli.js`: on Windows npm is npm.cmd, which Node won't start without a shell.
const bin = dirname(process.execPath);
const npmCli = [
  join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
].find((p) => existsSync(p));
const npm = (args, cwd) =>
  npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8" })
    : execFileSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });

const [{ filename }] = JSON.parse(npm(["pack", "--json", "--pack-destination", work], "."));
const tgz = join(work, filename);
const app = join(work, "app");
mkdirSync(app, { recursive: true });
npm(["init", "-y"], app);
npm(["install", "--no-audit", "--no-fund", tgz], app);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const entry = join(app, "node_modules", ...pkg.name.split("/"), pkg.bin["agent-rewake"]);
// A scratch home and state folder: the runs never see or change the real ones.
const home = join(work, "home");
mkdirSync(home, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  AGENT_REWAKE_STATE_DIR: join(home, "rewake-state"),
};
const run = (args, ok = [0, 1]) => {
  const r = spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(`$ agent-rewake ${args.join(" ")} → exit ${r.status}`);
  if (!ok.includes(r.status ?? -1) || /\n\s+at .+\(.+:\d+:\d+\)/.test(out)) {
    console.error(out);
    throw new Error(`agent-rewake ${args.join(" ")} failed`);
  }
  return out;
};

const version = run(["--version"], [0]).trim();
if (version !== pkg.version)
  throw new Error(`--version says ${version}, package.json ${pkg.version}`);
run(["--help"], [0]);
run(["doctor"]);
for (const place of [
  "zed",
  "claude-code",
  "codex",
  "copilot-cli",
  "grok",
  "gemini-cli",
  "antigravity",
])
  run(["install", "--dry-run", "--yes", "--only", place]);
console.log("tarball-smoke OK");
