import { homedir } from "node:os";
import {
  type AgentProfile,
  agentProfiles,
  classifyLimit,
  classifyTurnEnd,
} from "./adapters/profiles.js";
import { recognise } from "./core/limits/recognise.js";
import { when } from "./doctor.js";
import { findCodexLimit } from "./hosts/codex/rollout.js";
import { errorLine } from "./util/error-line.js";
import { VERSION } from "./version.js";

/**
 * `agent-rewake doctor --limit-sample "<text>"`: a person's way to report a usage-limit message
 * Rewake didn't read. It runs the text through the same rules Rewake uses at a real limit and
 * prints how each agent's rules read it, plus a pre-filled link to a GitHub issue form. It sends
 * nothing and opens nothing: the person opens the link, reads the form and submits it themselves.
 */

/** The issue form the link opens (.github/ISSUE_TEMPLATE/limit_text.yml). */
const ISSUE_URL = "https://github.com/codizelabs/agent-rewake/issues/new";
const MAX_LINES = 5;
const MAX_INPUT = 4000;

const NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini CLI",
  qwen: "Qwen Code",
  qoder: "Qoder",
  kimi: "Kimi",
  glm: "Z.AI GLM",
  minimax: "MiniMax",
  auggie: "Auggie",
  codebuddy: "CodeBuddy",
  antigravity: "Antigravity",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  amp: "Amp",
  droid: "Factory Droid",
  goose: "goose",
  "fast-agent": "fast-agent",
  cortex: "Cortex Code",
  autohand: "Autohand",
  opencode: "OpenCode",
  cline: "Cline",
  vibe: "Mistral Vibe",
  junie: "Junie",
  devin: "Devin",
  grok: "Grok",
};

/** The text as Rewake would keep it: each line without colours, keys, emails or your home folder. */
export function redactSample(text: string, home: string = homedir()): string {
  return text
    .slice(0, MAX_INPUT)
    .split(/\r?\n/)
    .map((l) => errorLine(l, home))
    .filter((l): l is string => l !== undefined)
    .slice(0, MAX_LINES)
    .join("\n");
}

type Reading =
  | { read: "limit"; resetsAt?: number }
  | { read: "billing" }
  | { read: "short" }
  | { read: "none" };

const NOT_LIMIT: Reading = { read: "none" };

function fromClassification(c: ReturnType<typeof classifyLimit> | undefined): Reading {
  if (!c) return NOT_LIMIT;
  if (c.kind === "usage_limit")
    return { read: "limit", ...(c.resetAt !== undefined && { resetsAt: c.resetAt }) };
  if (c.kind === "not_recoverable" && c.reason === "billing") return { read: "billing" };
  if (c.kind === "transient") return { read: "short" };
  return NOT_LIMIT;
}

const CODEX_SHAPE =
  /hit your usage limit|hit your spend cap|workspace is out of credits|^Quota exceeded\.|upgrade to Plus: /i;

/** How each agent's rules read `text` (a dry run: nothing is stored or scheduled). */
export function readSample(text: string, now: number): Map<string, Reading> {
  const out = new Map<string, Reading>();
  const rank = (r: Reading) => ({ limit: 3, billing: 2, short: 1, none: 0 })[r.read];
  const put = (agent: string, r: Reading) => {
    const name = NAMES[agent] ?? agent;
    const old = out.get(name);
    if (!old || rank(r) > rank(old)) out.set(name, r);
  };
  for (const profile of agentProfiles() as AgentProfile[]) {
    if (profile === "codex") continue;
    // Claude's adapter reports a limit as a rate-limit error whose message is the text.
    const data = profile === "claude" ? { errorKind: "rate_limit" } : undefined;
    const c = fromClassification(
      classifyLimit(profile, { code: -32603, message: text, ...(data && { data }) }, now),
    );
    // That error kind is assumed, so only a limit or billing reading says anything about the text.
    if (profile !== "claude" || c.read === "limit" || c.read === "billing") put(profile, c);
    const prefix = profile === "cursor" ? "\n\nError: Error: " : "Error: ";
    const turn = classifyTurnEnd(profile, `${prefix}${text}`, "end_turn", now);
    if (turn) put(profile, fromClassification(turn));
  }
  // Codex: its session file records the message under one error kind.
  const rollout = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "task_complete",
      error: { codex_error_info: "usage_limit_exceeded", message: text },
      completed_at: Math.floor(now / 1000),
    },
  });
  const codex = findCodexLimit(rollout, now);
  // Codex gives the error kind, not the text, so only texts of Codex's shape are read this way.
  if (CODEX_SHAPE.test(text))
    put(
      "codex",
      codex.billing
        ? { read: "billing" }
        : { read: "limit", ...(codex.resetsAt !== undefined && { resetsAt: codex.resetsAt }) },
    );
  // The agents Rewake hears from through hooks and files, with their own rules.
  for (const [agent, code] of [
    ["copilot", undefined],
    ["gemini", undefined],
    ["antigravity", "error"],
    ["cursor", undefined],
    ["grok", "rate_limit"],
    ["qwen", "rate_limit"],
    ["opencode", undefined],
  ] as const) {
    const v = recognise({ agent, source: "hook", text, ...(code && { code }) }, now);
    if (v?.isBilling) put(agent, { read: "billing" });
    else if (v)
      put(agent, { read: "limit", ...(v.resetsAt !== undefined && { resetsAt: v.resetsAt }) });
  }
  return out;
}

function phrase(r: Reading, now: number): string {
  if (r.read === "limit")
    return r.resetsAt !== undefined
      ? `A usage limit that resets ${when(r.resetsAt, now)}`
      : "A usage limit with no reset time (you pick when to continue)";
  if (r.read === "billing") return "A credit or billing limit (waiting won't fix it; not resumed)";
  if (r.read === "short") return "A short wait the agent handles itself (not resumed)";
  return "Not a usage limit";
}

/** The pre-filled issue link. Only the redacted text and Rewake's reading go in it. */
export function issueUrl(redacted: string, summary: string): string {
  const q = new URLSearchParams({
    template: "limit_text.yml",
    title: "A limit text Rewake missed",
    version: VERSION,
    text: redacted,
    reading: summary,
  });
  return `${ISSUE_URL}?${q.toString()}`;
}

/** What `doctor --limit-sample` prints for `text`. */
export function renderSample(
  text: string,
  now: number = Date.now(),
  home: string = homedir(),
): string {
  const redacted = redactSample(text, home);
  if (redacted === "") return "";
  const readings = readSample(redacted, now);
  const groups = new Map<string, string[]>();
  for (const [name, r] of readings) {
    const key = phrase(r, now);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  const order = [...groups.entries()].sort(
    (a, b) => Number(a[0].startsWith("Not a usage")) - Number(b[0].startsWith("Not a usage")),
  );
  const anyLimit = [...readings.values()].some((r) => r.read === "limit" || r.read === "billing");
  const lines = [
    "Limit text check. It ran on this computer; nothing was sent anywhere.",
    "",
    "The text, with keys, email addresses and your home folder removed:",
    ...redacted.split("\n").map((l) => `  ${l}`),
    "",
    "How Rewake reads it:",
    ...order.map(([what, who]) => {
      const names = what.startsWith("Not a usage")
        ? who.length > 6
          ? `${who.length} other agents`
          : who.join(", ")
        : who.length > 8
          ? `${who.slice(0, 6).join(", ")} and ${who.length - 6} more`
          : who.join(", ");
      return `  ${what}: ${names}`;
    }),
    "",
    anyLimit
      ? "If a reading is wrong, open this link to tell Rewake's maintainers. You see the form first, and nothing is sent until you submit it:"
      : "Rewake doesn't read this as a usage limit. If it was one, open this link to tell Rewake's maintainers. You see the form first, and nothing is sent until you submit it:",
    `  ${issueUrl(redacted, order.map(([what, who]) => `${what}: ${who.join(", ")}`).join("\n"))}`,
  ];
  return `${lines.join("\n")}\n`;
}
