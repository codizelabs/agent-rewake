import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * A fingerprint of a session's folder when it is a git work tree, so a resume that runs hours
 * after the limit can tell whether the project changed meanwhile. Local git commands only: the
 * commit id and the names-and-status summary of `git status --porcelain`, hashed. File contents
 * are never read, and no file name is kept: only the hash. Anything that goes wrong (no git, not a
 * work tree, a slow or failing command) gives no fingerprint, silently.
 */
export interface WorkspaceFingerprint {
  /** `git rev-parse HEAD`. */
  commit: string;
  /** SHA-256 over the sorted lines of `git status --porcelain --untracked-files=no`. */
  hash: string;
  /** There were uncommitted changes. */
  dirty: boolean;
}

/**
 * Both git commands share one deadline: a slow one means no fingerprint, never a slow hook (Codex's
 * session-end hook has 3 s, others 5 s). Planning a resume uses `ARM_BUDGET_MS`, `fire` more.
 */
export const ARM_BUDGET_MS = 1_000;
export const FIRE_BUDGET_MS = 2_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Git's own variables would point it at another repository than the folder's. */
function gitEnv(): NodeJS.ProcessEnv {
  const { GIT_DIR: _d, GIT_WORK_TREE: _w, GIT_INDEX_FILE: _i, ...rest } = process.env;
  return rest;
}

function git(cwd: string, args: string[], deadline: number): string | undefined {
  const left = deadline - Date.now();
  if (left <= 0) return undefined;
  try {
    // fsmonitor off: a repository's own configuration must not start a program.
    return execFileSync(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
      {
        encoding: "utf8",
        timeout: left,
        maxBuffer: MAX_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: gitEnv(),
      },
    );
  } catch {
    return undefined;
  }
}

/** Tracked files only (`--untracked-files=no`): .DS_Store, build output and logs don't count. */
export function fingerprintWorkspace(
  cwd: string | undefined,
  budgetMs = FIRE_BUDGET_MS,
): WorkspaceFingerprint | undefined {
  if (!cwd) return undefined;
  const deadline = Date.now() + budgetMs;
  const commit = git(cwd, ["rev-parse", "HEAD"], deadline)?.trim();
  if (!commit || !/^[0-9a-f]{40,64}$/.test(commit)) return undefined;
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=no"], deadline);
  if (status === undefined) return undefined;
  const lines = status.split("\n").filter(Boolean).sort();
  return {
    commit,
    hash: createHash("sha256").update(lines.join("\n")).digest("hex"),
    dirty: lines.length > 0,
  };
}

/**
 * Added to a resume's message when the project changed while it waited (setting
 * `workspace-changed`: note). Rewake's own words, the same every time: no model text, no paths,
 * branch names or file names.
 */
export const WORKSPACE_NOTE =
  "Note from Rewake: the project changed while this session waited for the usage limit to reset. Re-read any files before editing them.";

/** What differs between two fingerprints; undefined when nothing does. */
export function workspaceChange(
  before: WorkspaceFingerprint,
  after: WorkspaceFingerprint,
): { commit: boolean; changes: boolean } | undefined {
  const commit = before.commit !== after.commit;
  const changes = before.hash !== after.hash;
  return commit || changes ? { commit, changes } : undefined;
}

/** Whether a stored value is a fingerprint (a hand-edited file stays harmless). */
export function validFingerprint(w: unknown): boolean {
  if (typeof w !== "object" || w === null) return false;
  const x = w as Record<string, unknown>;
  return (
    typeof x.commit === "string" &&
    x.commit.length <= 64 &&
    typeof x.hash === "string" &&
    x.hash.length <= 64 &&
    typeof x.dirty === "boolean"
  );
}
