import { basename } from "node:path";
import { errorLine } from "../util/error-line.js";

/**
 * The allow-list for what an error report may carry (AGENTS.md: "Allow-list, never block-list").
 * Nothing here sends message or prompt text, agent output, file contents, environment values,
 * tokens, session ids, usernames, hostnames or full paths. `errorLine` (src/util/error-line.ts)
 * already does this for a single line of output; this module applies the same scrubbing to error
 * messages and stack frames before they ever reach a payload.
 */

/** A message produced by Rewake's own code or by Node, with paths, tokens and emails cut out. */
export function scrubMessage(message: string, home: string): string {
  return errorLine(message, home) ?? "";
}

export interface ScrubbedFrame {
  /** The file's basename only (never a full path, never anything outside Rewake's own bundle). */
  file?: string;
  function?: string;
  lineno?: number;
}

/**
 * One V8 stack line ("    at functionName (/abs/path/to/file.js:12:34)") reduced to a basename,
 * a function name and a line number. Frames outside Rewake's own bundle (node_modules, node:
 * internals under a different project) still keep only the basename: never a full path, whatever
 * it points to.
 */
const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(?:([^()]+?)):(\d+):(\d+)\)?$/;

export function scrubFrame(line: string): ScrubbedFrame | undefined {
  const m = FRAME.exec(line);
  if (!m) return undefined;
  const [, fn, file, lineno] = m;
  const result: ScrubbedFrame = {};
  if (file && !file.startsWith("node:")) result.file = basename(file);
  else if (file) result.file = file;
  if (fn) result.function = fn;
  if (lineno) result.lineno = Number(lineno);
  return result;
}

/** A full stack trace (`error.stack`), as the handful of frames Sentry's payload wants. */
export function scrubStack(stack: string | undefined, max = 15): ScrubbedFrame[] {
  if (!stack) return [];
  return stack
    .split(/\r?\n/)
    .slice(1, max + 1)
    .map(scrubFrame)
    .filter((f): f is ScrubbedFrame => f !== undefined);
}
