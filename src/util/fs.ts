import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * File operations that behave the same on every OS.
 */

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * rename() that rides out Windows' brief locks: antivirus, the search indexer or a sync client can
 * hold a file for a moment, and replacing it fails with EPERM, EACCES or EBUSY until they let go
 *. Retries with backoff for up to about 2 s, on Windows only;
 * elsewhere those errors are real and are thrown at once.
 */
export function renameWithRetry(
  from: string,
  to: string,
  p: NodeJS.Platform = process.platform,
  rename: (a: string, b: string) => void = renameSync,
  sleep: (ms: number) => void = sleepSync,
): void {
  let delay = 10;
  for (let waited = 0; ; ) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (p !== "win32" || !RETRYABLE.has(code) || waited >= 2000) throw err;
      sleep(delay);
      waited += delay;
      delay = Math.min(delay * 2, 250);
    }
  }
}

/** fsync a directory after a rename, where the OS supports it; a failure here never loses data. */
export function fsyncDir(dir: string, p: NodeJS.Platform = process.platform): void {
  if (p === "win32") return; // Windows can't fsync a directory handle
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (err) {
    // Some filesystems (network, FUSE, WSL drives) refuse directory fsync. The file itself was
    // already synced and renamed, so the write stands.
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP", "EBADF", "EACCES"].includes(code)) throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Text without a leading UTF-8 byte-order mark, which some Windows editors add. */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/** Read a file as text, without a byte-order mark. */
export const readText = (file: string): string => stripBom(readFileSync(file, "utf8"));

/** JSON.parse a file, tolerating a byte-order mark (JSON.parse rejects one). */
export const readJsonFile = (file: string): unknown => JSON.parse(readText(file));

/**
 * A new file next to `target`, created exclusively with `mode`, holding `data` and synced to disk.
 * Returns its path, for the caller to rename over `target`.
 *
 * The name carries random bytes and the file is opened with "wx", so it is always this process
 * that creates it. A predictable temp name opened with "w" can be pre-empted: another user (or
 * any program running as this one) plants a symlink there first, and the write lands wherever
 * that symlink points, with contents Rewake chose. Renaming the finished file over `target`
 * replaces `target` itself and never writes through a symlink standing in its place.
 */
export function writeTempExclusive(target: string, data: string, mode: number): string {
  const tmp = join(
    dirname(target),
    `.${basename(target)}.agent-rewake.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  return tmp;
}

/**
 * Replace `target` with `data`, atomically and without following a symlink at the temp path
 * (`writeTempExclusive`). The file keeps `mode`; a crash leaves the old file or the new one.
 */
export function replaceFileExclusive(target: string, data: string, mode: number): void {
  const tmp = writeTempExclusive(target, data, mode);
  try {
    renameWithRetry(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * A file holding text no other user may read: 0600, inside a directory of its own made with a
 * random name and owner-only permissions. Used for a scheduled message an agent's CLI can only
 * take as a file path — a path is visible in `ps`, its contents are not. `remove()` deletes the
 * directory and the file with it, and never throws.
 */
export function privateTempFile(prefix: string, name: string, data: string): PrivateTempFile {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, name);
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  return {
    path,
    remove: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // The run is over; a temp file left behind is not worth failing for.
      }
    },
  };
}

export interface PrivateTempFile {
  path: string;
  remove: () => void;
}
