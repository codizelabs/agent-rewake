import { spawnSync } from "node:child_process";
import { codexProgram } from "../hosts/codex/cli.js";
import { rewake } from "../util/command.js";

/**
 * An agent's version when its files don't say (Homebrew, apt, WinGet, copied binaries, standalone
 * installers): `<program> --version`, once, at install time only. Updaters are switched off, stdin
 * is closed and it gets five seconds. Without this, a version Rewake can't read skipped the
 * minimum-version check silently.
 */
export type VersionProbe = (path: string) => string | undefined;

const NO_UPDATES: NodeJS.ProcessEnv = {
  COPILOT_AUTO_UPDATE: "false",
  GROK_DISABLE_AUTOUPDATER: "1",
  DISABLE_AUTOUPDATER: "1",
  AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
};

export function versionProbe(env: NodeJS.ProcessEnv, node: string): VersionProbe {
  return (path) => {
    const p = codexProgram(path, node);
    const r = spawnSync(p.command, [...p.args, "--version"], {
      env: { ...env, ...NO_UPDATES },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      windowsHide: true,
    });
    return parseVersion(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  };
}

/** The first version number in `--version` output ("2.1.292 (Claude Code)", "codex-cli 0.160.1"). */
export function parseVersion(text: string): string | undefined {
  return /\b(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?\b/.exec(text)?.[1];
}

/** `p` with its version filled in by `probe` when detection didn't find one. */
export function withVersion<T extends { path: string; version?: string }>(
  p: T,
  probe: VersionProbe,
): T {
  if (p.version) return p;
  const version = probe(p.path);
  return version ? { ...p, version } : p;
}

/** Said when the version still can't be read: install goes on, and says what to check. */
export function unknownVersionText(
  agent: string,
  min: string,
  update: string,
  place: string,
): string {
  return `Rewake couldn't tell which version of ${agent} you have. It needs ${min} or newer: if Rewake doesn't respond in ${agent}, update it with "${update}", then run "${rewake(`install --only ${place}`)}" again.\n`;
}
