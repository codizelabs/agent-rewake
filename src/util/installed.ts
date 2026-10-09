import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/store.js";
import { ensurePrivateDir } from "./paths.js";

/**
 * When this version of Rewake was set up, kept in Rewake's own folder (`installed.json`), so
 * `doctor` can say how old the installed version is without any network check.
 */
export interface InstalledRecord {
  version: string;
  /** Milliseconds since 1970 of the first install of this version. */
  at: number;
}

const FILE = "installed.json";

export function readInstalled(stateDir: string): InstalledRecord | undefined {
  try {
    const v = JSON.parse(readFileSync(join(stateDir, FILE), "utf8")) as Partial<InstalledRecord>;
    return typeof v.version === "string" && typeof v.at === "number" && Number.isFinite(v.at)
      ? { version: v.version, at: v.at }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Note that `version` was installed now. Running `install` again for the same version keeps the
 * first time: the age is how long since this version was put in, not since the last command.
 */
export function recordInstall(stateDir: string, version: string, now: number): void {
  if (readInstalled(stateDir)?.version === version) return;
  try {
    writeFileAtomic(
      ensurePrivateDir(stateDir),
      FILE,
      `${JSON.stringify({ version, at: now } satisfies InstalledRecord)}\n`,
    );
  } catch {
    // A note for `doctor`; an install that worked mustn't fail because it couldn't be written.
  }
}
