import { chmodSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/store.js";
import { stableNode } from "../install.js";
import { ensurePrivateDir } from "../util/paths.js";

/**
 * A Node.js finder for hooks, timers and the login item (macOS and Linux).
 *
 * Every hook command, timer and the login item names one Node.js binary. With nvm, fnm or asdf that
 * is a versioned folder, so a routine `nvm uninstall` or upgrade made every hook and timer fail
 * without naming Rewake. They name this small script instead (`<stateDir>/bin/rewake-node`): it runs
 * the Node.js Rewake was installed with while that exists, else the first working Node.js 22 or
 * newer it finds (Homebrew, Volta, fnm, asdf, nvm, the system, PATH), with the same arguments. Its
 * path never changes, so the command text, which Codex keys its hook trust on, stays the same.
 * Windows installs of Node.js sit at stable paths, so it isn't used there.
 */
export function nodeShimPath(stateDir: string): string {
  return join(stateDir, "bin", "rewake-node");
}

/** Paths that vanish by themselves (fnm's per-shell folders, temporary folders): never recorded. */
export function ephemeralNode(path: string): boolean {
  return /fnm_multishells|[\\/]tmp[\\/]|[\\/]T[\\/]/.test(path);
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function nodeShimText(recorded: string | undefined): string {
  return `#!/bin/sh
# Agent Rewake's Node.js finder: runs a working Node.js 22 or newer with the arguments it was given,
# so removing or upgrading Node.js doesn't break Rewake's hooks and timers.
# Rewake writes this file; edits are lost.
${recorded ? `RECORDED=${sq(recorded)}\n[ -x "$RECORDED" ] && exec "$RECORDED" "$@"` : ""}
ok() { [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; }
for n in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME/.asdf/shims/node" /usr/bin/node; do
  if ok "$n"; then exec "$n" "$@"; fi
done
for n in $(ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -r); do
  if ok "$n"; then exec "$n" "$@"; fi
done
n=$(command -v node 2>/dev/null)
if [ -n "$n" ] && ok "$n"; then exec "$n" "$@"; fi
echo "Agent Rewake: no Node.js 22 or newer found. Install Node.js (nodejs.org), then run: npx @codizelabs/agent-rewake doctor" >&2
exit 127
`;
}

/** The Node.js path the shim on file prefers, when it names one. */
function recordedIn(file: string): string | undefined {
  try {
    const m = /^RECORDED='((?:[^']|'\\'')*)'$/m.exec(readFileSync(file, "utf8"));
    return m?.[1]?.replace(/'\\''/g, "'");
  } catch {
    return undefined;
  }
}

/**
 * Write the shim when it's missing or its recorded Node.js is gone, naming the Node.js that runs
 * this (unless that one is short-lived). Returns its path, or undefined on Windows or when it can't
 * be written.
 */
export function ensureNodeShim(
  stateDir: string,
  node: string = stableNode(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") return undefined;
  const file = nodeShimPath(stateDir);
  try {
    const had = recordedIn(file);
    // Keep the Node.js on file while it works: another Node.js running Rewake mustn't replace it.
    if (existsSync(file) && had && existsSync(had)) return file;
    let real: string | undefined;
    try {
      real = realpathSync(node);
    } catch {
      real = undefined;
    }
    const recorded = real && !ephemeralNode(node) && !ephemeralNode(real) ? node : undefined;
    const text = nodeShimText(recorded);
    if (existsSync(file) && readFileSync(file, "utf8") === text) return file;
    writeFileAtomic(ensurePrivateDir(join(stateDir, "bin")), "rewake-node", text);
    chmodSync(file, 0o700);
    return file;
  } catch {
    return undefined;
  }
}

/** What hooks, timers and the login item run as "node": the shim, else this Node.js itself. */
export function rewakeNode(stateDir: string): string {
  return ensureNodeShim(stateDir) ?? stableNode();
}
