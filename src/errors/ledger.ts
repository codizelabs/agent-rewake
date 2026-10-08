import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/store.js";
import { readJsonFile } from "../util/fs.js";
import { ensurePrivateDir } from "../util/paths.js";

/**
 * A local, owner-only record of every error Rewake has seen, whether or not reporting is on
 * (AGENTS.md: "Always write each error to a local, owner-only (0600) ledger … so doctor/a future
 * report can show them"). Bounded to the last 200 entries. `writeFileAtomic` already writes with
 * mode 0600 (src/core/store.ts).
 */
export interface LedgerEntry {
  t: string;
  name: string;
  type: string;
  message: string;
  sent: boolean;
}

const LEDGER_FILE = "error-ledger.json";
const MAX_ENTRIES = 200;

export function readLedger(stateDir: string): LedgerEntry[] {
  try {
    const value = readJsonFile(join(stateDir, LEDGER_FILE));
    return Array.isArray(value) ? (value as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

export function appendLedger(stateDir: string, entry: LedgerEntry): void {
  try {
    const entries = [...readLedger(stateDir), entry].slice(-MAX_ENTRIES);
    writeFileAtomic(
      ensurePrivateDir(stateDir),
      LEDGER_FILE,
      `${JSON.stringify(entries, null, 2)}\n`,
    );
  } catch {
    // The ledger is a convenience for doctor/report; never let it break the caller.
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Delete log files under `<stateDir>/logs` older than 14 days (nothing did this before). */
export function cleanOldLogs(stateDir: string, now: number = Date.now(), maxAgeDays = 14): void {
  const dir = join(stateDir, "logs");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeDays * DAY_MS) rmSync(path, { force: true });
    } catch {
      // A file that can't be stat'd or removed is left; this is best-effort housekeeping.
    }
  }
}
