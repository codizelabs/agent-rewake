import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../doctor.js";
import type { PlaceId } from "../install/detect.js";
import { launcherPath } from "../timers/launcher.js";
import { nodeShimPath } from "../timers/node-shim.js";
import { rewake } from "../util/command.js";

/**
 * `doctor`'s checks that the pieces hooks and timers run still exist and work (G26): the helper
 * files in Rewake's folder, the Node.js finder, and an agent that is set up but that Rewake has
 * never seen run. Offline; says no folders.
 */
export interface HealthFacts {
  stateDir: string;
  platform: NodeJS.Platform;
  /** The previews set up here (not Zed). */
  previews: { id: PlaceId; name: string }[];
  /** Tests replace these. */
  exists?: (path: string) => boolean;
  run?: (command: string, args: string[]) => { status: number | null };
  sessionFiles?: (id: string) => number;
}

/** Agents whose sessions Rewake records itself (the others keep their records elsewhere). */
const RECORDED = new Set<PlaceId>(["copilot-cli", "grok", "gemini-cli", "antigravity", "cursor"]);

function recordsOf(stateDir: string, id: string): number {
  try {
    return readdirSync(join(stateDir, "hosts", id, "sessions")).length;
  } catch {
    return 0;
  }
}

export function diagnoseHealth(f: HealthFacts): Finding[] {
  const out: Finding[] = [];
  const add = (x: Omit<Finding, "area">) => out.push({ area: "Outside Zed", ...x });
  if (f.previews.length === 0) return out;
  const exists = f.exists ?? existsSync;
  const names = f.previews.map((p) => p.name).join(", ");
  const only = f.previews.map((p) => p.id).join(",");
  const reinstall = `Run ${rewake(`install --only ${only}`)} again to put it back.`;

  if (!exists(launcherPath(f.stateDir))) {
    add({
      level: "problem",
      text: `Rewake's helper file is missing, so the hooks and timers of ${names} can't run.`,
      fix: reinstall,
    });
    return out;
  }
  if (f.platform === "win32") return out;
  const shim = nodeShimPath(f.stateDir);
  if (!exists(shim)) {
    add({
      level: "problem",
      text: `Rewake's Node.js finder is missing, so the hooks and timers of ${names} may not start.`,
      fix: reinstall,
    });
  } else {
    const run =
      f.run ??
      ((command: string, args: string[]) =>
        spawnSync(command, args, { timeout: 5000, stdio: "ignore" }));
    if (run(shim, ["--version"]).status !== 0)
      add({
        level: "problem",
        text: `Rewake can't find a Node.js 22 or newer, so the hooks and timers of ${names} can't run.`,
        fix: `Install Node.js (nodejs.org), then run ${rewake("doctor")} again.`,
      });
  }

  const count = f.sessionFiles ?? ((id: string) => recordsOf(f.stateDir, id));
  for (const p of f.previews)
    if (RECORDED.has(p.id) && count(p.id) === 0)
      add({
        level: "info",
        text: `${p.name} is set up, but Rewake hasn't seen it run yet.`,
        fix: `Start a new ${p.name} session: one that was already open doesn't load Rewake. If this stays, run ${rewake("doctor --details")}.`,
      });
  return out;
}
