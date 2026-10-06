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
