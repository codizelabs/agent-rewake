import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whether this machine lets tests create symlinks. Windows needs Developer Mode or admin rights
 * for that; tests that need one are skipped without it.
 */
export const canSymlink: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "rewake-symlink-"));
  try {
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/**
 * Wait until `cond` holds, checking every `stepMs`: a test waits as long as the work takes, not a
 * fixed time that is too short on a slow runner and wasted on a fast one. Fails with `what` after
 * `ms`, which stays under the per-test timeout so the reason is reported instead of a bare timeout.
 */
export async function until(
  cond: () => boolean,
  what = "the condition",
  ms = 4_000,
  stepMs = 5,
): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
