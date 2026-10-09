import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPromptError, parseResetText } from "../../adapters/claude/limits.js";
import { claudePrograms } from "../../install/detect.js";
import type { ClosedHost } from "../closed.js";
import { codexProgram as nodeAware } from "../codex/cli.js";
import { resumeDeadline, type SendResult, sendPromptOnStdin, withMessage } from "../host.js";
import { type SessionRecord, safeSessionId } from "../sessions.js";

/**
 * Claude Code in a terminal or an editor panel, continued after it was closed. While Claude Code
 * is open, Rewake's plugin inside it handles the limit (mod/hooks/register.js). The plugin also
 * keeps a copy of each session's record where Rewake reads it (`SessionRecord`: the session, its
 * folder, the limit and its reset, the Claude Code process that has it open, the settings
 * variables it ran with). When that process is gone and the limit was never answered, Rewake
 * treats the session like any other closed one (src/hosts/closed.ts): `agent-rewake continue`
 * lists it, and `fire` resumes it headless:
 *
 *   claude --resume <session-id> -p --output-format json --permission-prompts none
 *
 * in the session's folder, with the message on its stdin, never as an argument
 * (sendPromptOnStdin). Sources, checked against Claude Code 2.1.282's `claude --help` and the
 * published docs (code.claude.com/docs/en/cli-reference, /headless, /env-vars, /claude-directory)
 * on 2026-10-08:
 *   - `--resume <id>` continues that session, `-p` runs it without the interface, and `claude -p`
 *     with no prompt argument reads the prompt from piped stdin (the docs pipe a diff into it).
 *   - `--output-format json` prints one result object with `result` and `is_error`.
 *   - `--permission-prompts none` (2.1.259 or later): a tool call that would ask is denied, so a
 *     run nobody watches never waits for an answer. No `--permission-mode` is passed, and never a
 *     skip-permissions flag, so the run has the permissions the person's own settings give it.
 *   - `--continue` isn't used: it takes the newest conversation in the folder, which may not be
 *     this one.
 *   - A session's transcript is `<config dir>/projects/<project>/<session-id>.jsonl`; the config
 *     dir is `~/.claude`, or CLAUDE_CONFIG_DIR.
 * Not tried against a real usage limit: the exact output and exit code of a limited `-p` run are
 * read from reports of other tools' runs (research note community-research/claude-code.md), not
 * from this code's own run.
 */

export const CLAUDE_CODE_ID = "claude-code";

/**
 * Settings variables a resume needs as the session had them (the plugin copies exactly these, from
 * its own list in mod/hooks/logic.js; test/claude-closed.test.ts compares the two). Names from the
 * published environment-variables page.
 */
export const CLAUDE_SETTINGS_VARS = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Only whether each is set is recorded: a run without one that the session had would fail or bill another account. */
export const CLAUDE_KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/**
 * Claude Code appends its own limit message to the transcript just after the plugin sees the
 * limit; a change that soon after is that, not the person.
 */
export const TRANSCRIPT_GRACE_MS = 2 * 60_000;

/** Claude Code's folder for its own files. */
function configDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || env.USERPROFILE || homedir(), ".claude");
}

/** The session's transcript: `projects/<project>/<id>.jsonl`, in whichever project folder has it. */
export function findTranscript(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!safeSessionId(sessionId)) return undefined;
  const root = join(configDir(env), "projects");
  const fixed = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CODE_PROJECT_DIR_NAME : undefined;
  let projects: string[];
  try {
    projects = fixed ? [fixed] : readdirSync(root);
  } catch {
    return undefined;
  }
  let newest: { path: string; at: number } | undefined;
  for (const p of projects) {
    const path = join(root, p, `${sessionId}.jsonl`);
    try {
      const at = statSync(path).mtimeMs;
      if (!newest || at > newest.at) newest = { path, at };
    } catch {
      // Not in this project.
    }
  }
  return newest?.path;
}

/** Whether the session's transcript was written after `since` (plus the grace after the limit). */
export function transcriptChanged(
  r: SessionRecord,
  since: number,
  env: NodeJS.ProcessEnv,
): boolean {
  const path = findTranscript(r.sessionId, env);
  if (!path) return false;
  try {
    return statSync(path).mtimeMs > since + TRANSCRIPT_GRACE_MS;
  } catch {
    return false;
  }
}

/** Claude Code's own words when nobody is signed in. */
const SIGNED_OUT = /not logged in|please run \/login|invalid api key|authentication required/i;
/** `claude --resume <id>` for a session Claude Code has no transcript of. */
const NO_CONVERSATION = /no conversation found with session id/i;

/** A limit in a headless run's output: undefined when the run didn't end at one. */
export function limitInRun(
  text: string,
  now: number,
): { billing: boolean; resetsAt?: number } | undefined {
  // Only what the run reported as its error is read, with the same rules as for Zed's Claude
  // adapter (src/adapters/claude/limits.ts): the model's own prose can hold the same words.
  const c = classifyPromptError(
    { code: -32603, message: text.slice(0, 16_000), data: { errorKind: "rate_limit" } },
    undefined,
  );
  if (c.kind === "not_recoverable" && c.reason === "billing") return { billing: true };
  if (c.kind !== "usage_limit") return undefined;
  const resetsAt = parseResetText(text, now)?.resetAt;
  return { billing: false, ...(resetsAt !== undefined && { resetsAt }) };
}

/** Run `claude --resume …` with the message on stdin, and read its result for a limit. */
export function resumeClaude(
  r: SessionRecord,
  text: string,
  env: NodeJS.ProcessEnv,
  node: string = process.execPath,
): Promise<SendResult> {
  const found =
    r.program ??
    claudePrograms({
      env,
      home: env.HOME || env.USERPROFILE || homedir(),
      platform: process.platform,
    })[0]?.path;
  if (!found)
    return Promise.resolve({ ok: false, reason: "unsupported", detail: "no Claude Code found" });
  const program = nodeAware(found, node);
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn(
      program.command,
      [
        ...program.args,
        "--resume",
        r.sessionId,
        "-p",
        "--output-format",
        "json",
        "--permission-prompts",
        "none",
      ],
      { cwd: r.cwd || undefined, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    sendPromptOnStdin(child, text);
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 1 << 20) out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 1 << 16) err += d.toString("utf8");
    });
    const timedOut = resumeDeadline(child);
    child.on("error", () => resolve({ ok: false, reason: "failed", detail: "spawn" }));
    child.on("exit", (code) => {
      if (timedOut()) return resolve({ ok: false, reason: "failed", detail: "timeout" });
      let result: { is_error?: unknown; result?: unknown } | undefined;
      try {
        result = JSON.parse(out.trim().split("\n").at(-1) ?? "") as typeof result;
      } catch {
        // Not a result object: the error text is whatever it printed.
      }
      const failed = code !== 0 || result?.is_error === true;
      if (!failed) return resolve({ ok: true });
      const said = typeof result?.result === "string" ? result.result : out || err;
      const limit = limitInRun(said, Date.now());
      if (limit && !limit.billing)
        return resolve({
          ok: false,
          reason: "limited",
          ...(limit.resetsAt !== undefined && { resetsAt: limit.resetsAt }),
        });
      if (SIGNED_OUT.test(said))
        return resolve({ ok: false, reason: "failed", detail: "signed-out" });
      if (NO_CONVERSATION.test(`${said}\n${err}`))
        return resolve({ ok: false, reason: "closed", detail: "deleted" });
      resolve({
        ok: false,
        reason: "failed",
        detail: `exit ${code ?? "signal"}`,
        ...withMessage(said || err),
      });
    });
  });
}

export const claudeCodeHost: ClosedHost = {
  id: CLAUDE_CODE_ID,
  name: "Claude Code",
  reopen: 'resume the session with "claude --resume"',
  resume: (r, text, env) => resumeClaude(r, text, env),
  changedSince: transcriptChanged,
  settingsVars: CLAUDE_SETTINGS_VARS,
  keyVars: CLAUDE_KEY_VARS,
};
