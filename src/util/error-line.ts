import { homedir } from "node:os";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** Terminal escape sequences: colours and cursor moves (CSI), and links or titles (OSC). */
const ESCAPES = [
  new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"),
  new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g"),
];
/** Every other control character (but not the line breaks the lines are split on). */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);

/** What looks like a secret, with the part to keep (if any) in the first group. */
const SECRETS: [RegExp, string][] = [
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "…"],
  [/\b(sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xai|xoxb|xoxp|AIza)[-_A-Za-z0-9]{8,}/g, "…"],
  [/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 …"],
  [
    /\b([A-Za-z0-9_-]*(?:key|secret|password|passwd|pwd|token|credential)[A-Za-z0-9_-]*)\s*[=:]\s*\S+/gi,
    "$1=…",
  ],
  [/\b(Bearer|token|key)[=: ]+\S+/gi, "$1 …"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "…"],
  [/[A-Za-z0-9_-]{32,}/g, "…"],
];

/**
 * The line a person needs from an agent run that failed: the last non-empty line of its error
 * output, without terminal colours, with the home folder shown as `~` and anything that looks like a
 * key, token or email address cut out, at most 200 characters. Undefined when the output says nothing.
 */
export function errorLine(output: string, home: string = homedir()): string | undefined {
  const clean = ESCAPES.reduce((t, e) => t.replace(e, ""), output).replace(CONTROL, "");
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^at\s|^Node\.js v\d|^\^+$/.test(l));
  let line = lines.at(-1);
  if (line === undefined) return undefined;
  if (home) line = line.split(home).join("~");
  for (const [pattern, to] of SECRETS) line = line.replace(pattern, to);
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
