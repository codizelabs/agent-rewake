import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatAt } from "../../core/time.js";
import { levelText, paceText, type UsageState, usageStep } from "../../core/usage-warn.js";
import { replaceFileExclusive } from "../../util/fs.js";
import { ensurePrivateDir } from "../../util/paths.js";
import { lastWindows, readTail } from "./rollout.js";

/**
 * Warnings before a usage limit in Codex (src/core/usage-warn.ts has the rules). Codex lets a hook
 * show the person a warning only through `{"systemMessage": …}` on stdout; plain text there would
 * go to the model. The figures are the ones Codex wrote to the thread's session file after its
 * previous reply, so a warning comes with the next prompt, one turn after the figure.
 *
 * What was already said is kept in `codex-usage.json` in Rewake's state folder:
 * `{ <Codex home>: { <window kind>: UsageState } }`. The limits belong to the account, which is the
 * Codex home (the folder above `sessions/`), so another thread or a restart doesn't repeat a
 * warning.
 */

const FILE = "codex-usage.json";

type Stored = Record<string, Record<string, UsageState>>;

function load(file: string): Stored {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Stored) : {};
  } catch {
    return {};
  }
}

/** The Codex home a rollout belongs to: the path above `sessions/YYYY/MM/DD/`. */
const homeOf = (rollout: string): string => dirname(dirname(dirname(dirname(dirname(rollout)))));

/**
 * The line to print for this prompt, or undefined. Never throws: a warning is never worth failing
 * the person's prompt for.
 */
export function usageWarning(stateDir: string, rollout: string, now: number): string | undefined {
  try {
    const windows = lastWindows(readTail(rollout));
    if (windows.length === 0) return undefined;
    const file = join(stateDir, FILE);
    const all = load(file);
    const home = homeOf(rollout);
    const kept = { ...all[home] };
    const texts: string[] = [];
    for (const w of windows) {
      const step = usageStep(kept[w.kind], w, now);
      if (!step) continue;
      kept[w.kind] = step.next;
      const reset = formatAt(step.next.resetsAt, now);
      if (step.level !== undefined) texts.push(levelText(w.kind, w.percentUsed, reset));
      else if (step.pace) texts.push(paceText(w.kind, step.pace, reset));
    }
    // Saved before showing: a failure after this must not make the same warning come back.
    ensurePrivateDir(stateDir);
    replaceFileExclusive(file, `${JSON.stringify({ ...all, [home]: kept })}\n`, 0o600);
    return texts.length > 0
      ? JSON.stringify({ systemMessage: `Rewake: ${texts.join(" ")}` })
      : undefined;
  } catch {
    return undefined;
  }
}
