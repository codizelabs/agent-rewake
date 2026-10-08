import { homedir } from "node:os";

/** Terminal colour and cursor codes (ESC [ … letter). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/**
 * The line a person needs from an agent run that failed: the last non-empty line of its error
 * output, without terminal colours, with the home folder shown as `~` and anything that looks like a
 * key, token or email address cut out, at most 200 characters. Undefined when the output says nothing.
 */
export function errorLine(output: string, home: string = homedir()): string | undefined {
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^at\s|^Node\.js v\d|^\^+$/.test(l));
  let line = lines.at(-1);
  if (line === undefined) return undefined;
  if (home) line = line.split(home).join("~");
  line = line
    .replace(/\b(sk|ghp|gho|ghs|xai|AIza)[-_A-Za-z0-9]{8,}/g, "…")
    .replace(/\b(Bearer|token|key)[=: ]+\S+/gi, "$1 …")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "…")
    .replace(/[A-Za-z0-9_-]{32,}/g, "…");
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
