import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  chooseProgram,
  compareVersions,
  type Program,
  qwenPrograms,
} from "../../install/detect.js";
import {
  unknownVersionText,
  type VersionProbe,
  versionProbe,
  withVersion,
} from "../../install/probe.js";
import { applyPlan, edit, type FileChange, type Plan, parseJsonc } from "../../install.js";
import { ensureLauncher, launcherPath } from "../../timers/launcher.js";
import { rewake } from "../../util/command.js";
import { hookCommand } from "../hook-command.js";
import { newerThanTested, untestedText, versionOf } from "../versions.js";

/**
 * `agent-rewake install --only qwen-code` (a preview, never tried against a real Qwen Code limit):
 * Qwen Code reads Claude-style hooks from the `hooks` key of its user settings file,
 * `<QWEN_HOME or ~/.qwen>/settings.json` (hooks.md and settings.md of QwenLM/qwen-code at 6788c03,
 * v0.25.0). Rewake adds its own entries there and keeps everything else in the file, comments and
 * formatting too; uninstall removes only those entries. Qwen reads hooks when a session starts; an open
 * session may pick them up only when the person opens `/hooks` (hooks.md).
 *
 *   SessionStart, SessionEnd  note when a session opens and closes
 *   UserPromptSubmit          `/rewake` in the prompt: continue, list or cancel, blocked from the
 *                             model; anything else cancels a pending resume (the person carried on)
 *   Stop                      a turn ended well: the person carried on after any limit
 *   StopFailure               matcher `rate_limit|billing_error`: the limit, or a billing error
 *
 * `timeout` is in seconds (a value of 1000 or more would be read as milliseconds).
 */

export const MIN_QWEN = versionOf("qwen-code").min;
export const QWEN_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

/** Qwen's global folder: `QWEN_HOME` (`~` expanded, relative to the current folder) or `~/.qwen`. */
export function qwenHome(env: NodeJS.ProcessEnv, home: string): string {
  const set = env.QWEN_HOME;
  if (!set) return join(home, ".qwen");
  if (set === "~") return home;
  if (/^~[\\/]/.test(set)) return join(home, set.slice(2));
  return isAbsolute(set) ? set : resolve(set);
}

export function qwenSettingsFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(qwenHome(env, home), "settings.json");
}

const OURS = /\bhook qwen-code\b/;
type Entry = Record<string, unknown>;
const isRecord = (v: unknown): v is Entry =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isOurs = (h: unknown) => isRecord(h) && OURS.test(String(h.command ?? ""));

/** A matcher group without Rewake's hooks; undefined when nothing else was in it. */
function withoutOurs(group: unknown): unknown {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return group;
  const rest = group.hooks.filter((h) => !isOurs(h));
  if (rest.length === group.hooks.length) return group;
  return rest.length > 0 ? { ...group, hooks: rest } : undefined;
}

function readSettings(env: NodeJS.ProcessEnv, home: string): Entry | undefined {
  try {
    const v = parseJsonc(readFileSync(qwenSettingsFile(env, home), "utf8")).value;
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Whether Rewake's entries are in Qwen Code's user settings. */
export function qwenInstalled(env: NodeJS.ProcessEnv, home: string): boolean {
  const hooks = readSettings(env, home)?.hooks;
  if (!isRecord(hooks)) return false;
  return Object.values(hooks).some(
    (list) =>
      Array.isArray(list) &&
      list.some((g) => isRecord(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs)),
  );
}

/** Whether the user's settings turn every hook off (`disableAllHooks`, hooks.md). */
export function qwenHooksOff(env: NodeJS.ProcessEnv, home: string): boolean {
  return readSettings(env, home)?.disableAllHooks === true;
}

/**
 * Rewake's group for one event. On Windows the command runs in PowerShell (the `shell` field, which
 * hooks.md lists as "bash" or "powershell"); elsewhere Qwen's default shell is left alone. Windows
 * was not tried.
 */
export function ourGroup(
  event: string,
  node: string,
  launcher: string,
  platform: NodeJS.Platform = process.platform,
): Entry {
  const windows = platform === "win32";
  return {
    ...(event === "StopFailure" && { matcher: "rate_limit|billing_error" }),
    hooks: [
      {
        type: "command",
        name: `Agent Rewake (${event})`,
        command: hookCommand(
          node,
          launcher,
          `hook qwen-code ${event}`,
          windows ? "powershell" : "posix",
        ),
        ...(windows && { shell: "powershell" }),
        timeout: 5,
      },
    ],
  };
}

/** The change to settings.json: Rewake's entries replaced or added (or removed), the rest kept. */
export function planQwen(
  file: string,
  node: string,
  launcher: string,
  uninstall: boolean,
  platform: NodeJS.Platform = process.platform,
): Plan | { error: string } {
  if (`${node}${launcher}`.includes('"'))
    return {
      error: `Rewake couldn't set up Qwen Code: the path to Node.js or to Rewake contains a double quote (${node}, ${launcher}). Rewake didn't change anything.`,
    };
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8").replace(/^﻿/, "") : "";
  const parsed = existed ? parseJsonc(before) : { value: {} };
  if (parsed.error || !isRecord(parsed.value))
    return {
      error: `Rewake couldn't set up Qwen Code: its settings file (${file}) isn't valid JSON. Rewake didn't change it. Fix or remove the file, then run this again.`,
    };
  const settings = parsed.value;
  if (settings.hooks !== undefined && !isRecord(settings.hooks))
    return {
      error: `Rewake couldn't set up Qwen Code: "hooks" in its settings file (${file}) isn't an object. Rewake didn't change it.`,
    };
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const base = existed ? before : "{}\n";
  let text = base;
  // Rewake's own entries come out of every event, then the current ones go back.
  const events = new Set<string>([...Object.keys(hooks), ...(uninstall ? [] : QWEN_EVENTS)]);
  for (const event of events) {
    const had = hooks[event];
    if (had !== undefined && !Array.isArray(had)) {
      if (!uninstall && (QWEN_EVENTS as readonly string[]).includes(event))
        return {
          error: `Rewake couldn't set up Qwen Code: "hooks.${event}" in its settings file (${file}) isn't a list. Rewake didn't change it.`,
        };
      continue;
    }
    const kept = (had ?? []).map(withoutOurs).filter((g) => g !== undefined);
    const want =
      uninstall || !(QWEN_EVENTS as readonly string[]).includes(event)
        ? kept
        : [...kept, ourGroup(event, node, launcher, platform)];
    if (JSON.stringify(want) === JSON.stringify(had ?? [])) continue;
    text = edit(text, ["hooks", event], want.length > 0 ? want : undefined);
  }
  if (text === base) return { changes: [], notes: [] };
  // Nothing of the person's left under "hooks": the key Rewake's entries made goes too.
  const left = (parseJsonc(text).value as Entry | undefined)?.hooks;
  if (uninstall && isRecord(left) && Object.keys(left).length === 0)
    text = edit(text, ["hooks"], undefined);
  const summary = [
    uninstall ? "Remove Rewake's hooks from Qwen Code" : "Add Rewake's hooks to Qwen Code",
  ];
  const change: FileChange = { file, existed, before, after: text, summary };
  return { changes: [change], notes: [] };
}

export interface QwenInstallOptions {
  uninstall: boolean;
  yes: boolean;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  node: string;
  bundle: string;
  interactive: boolean;
  out: (text: string) => void;
  ask: (question: string) => Promise<boolean>;
  home?: string;
  programs?: Program[];
  /** Reads a version detection missed (tests: none). */
  probe?: VersionProbe;
}

export async function runQwenInstall(o: QwenInstallOptions): Promise<number> {
  const home = o.home ?? (o.env.HOME || o.env.USERPROFILE || homedir());
  const file = qwenSettingsFile(o.env, home);
  const programs = o.programs ?? qwenPrograms({ env: o.env, home, platform: process.platform });
  const probe = o.probe ?? (o.programs ? () => undefined : versionProbe(o.env, o.node));
  const picked = chooseProgram(programs);
  const qwen = picked && !o.uninstall ? withVersion(picked, probe) : picked;
  if (!o.uninstall) {
    if (!qwen) {
      o.out("Qwen Code wasn't found on this computer, so there's nothing to set up for it.\n");
      return 1;
    }
    if (qwen.version && compareVersions(qwen.version, MIN_QWEN) < 0) {
      o.out(
        `Qwen Code ${qwen.version} is too old for Rewake (it needs ${MIN_QWEN} or newer). Update it with "npm install -g @qwen-code/qwen-code@latest", then run "${rewake("install --only qwen-code")}" again.\n`,
      );
      return 1;
    }
  }
  const launcher = o.dryRun
    ? launcherPath(o.stateDir)
    : (ensureLauncher(o.stateDir, o.bundle) ?? launcherPath(o.stateDir));
  const plan = planQwen(file, o.node, launcher, o.uninstall);
  if ("error" in plan) {
    o.out(`${plan.error}\n`);
    return 1;
  }
  if (plan.changes.length === 0) {
    o.out(
      o.uninstall
        ? "Rewake isn't set up in Qwen Code: nothing to remove.\n"
        : "Rewake is already set up in Qwen Code: nothing to change.\n",
    );
    return 0;
  }
  o.out(
    o.uninstall
      ? `Agent Rewake will remove its hooks from Qwen Code's settings:\n  ${file}\nYour own settings and hooks stay. Rewake keeps a backup of the file.\n`
      : [
          `Agent Rewake (preview, not tried) will add its hooks to Qwen Code's settings${qwen?.version ? ` (version ${qwen.version} found)` : ""}:`,
          `  ${file}`,
          "",
          `It adds ${QWEN_EVENTS.length} hooks that note when a session starts, ends, carries on or stops at a usage limit. At a usage limit, type "/rewake" in the session to continue after the reset, choose a time, or cancel. Rewake doesn't resume after a billing error. Your own settings and hooks stay; Rewake keeps a backup of the file.`,
          "",
        ].join("\n"),
  );
  if (!o.uninstall && qwen && !qwen.version)
    o.out(
      unknownVersionText(
        "Qwen Code",
        MIN_QWEN,
        "npm install -g @qwen-code/qwen-code@latest",
        "qwen-code",
      ),
    );
  if (!o.uninstall && qwen?.version && newerThanTested("qwen-code", qwen.version))
    o.out(`${untestedText("qwen-code", qwen.version)}\n`);
  if (o.dryRun) {
    o.out("Dry run: nothing was changed.\n");
    return 0;
  }
  if (!o.yes) {
    if (!o.interactive) {
      o.out("Not a terminal, so nothing was changed. Run again with --yes to apply.\n");
      return 1;
    }
    if (!(await o.ask("\nApply these changes? [y/N] "))) {
      o.out("Nothing was changed.\n");
      return 1;
    }
  }
  applyPlan(plan);
  if (o.uninstall) {
    o.out("Done. Rewake is out of Qwen Code.\n");
    return 0;
  }
  o.out(
    "\nDone.\nNext, start a new Qwen Code session. One that is open may pick the hooks up only when you open /hooks in it.\n",
  );
  if (qwenHooksOff(o.env, home))
    o.out(
      "But Qwen Code has its hooks turned off (disableAllHooks), so Rewake won't see its usage limits until you turn them back on.\n",
    );
  return 0;
}
