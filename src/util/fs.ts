import { closeSync, fsyncSync, openSync, readFileSync, renameSync } from "node:fs";

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
