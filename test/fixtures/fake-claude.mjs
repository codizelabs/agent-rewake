#!/usr/bin/env node
// A stand-in for the `claude` CLI in tests (never the real one: no model, no sign-in, no ~/.claude).
// `--resume <id> -p --output-format json …` with the prompt on stdin prints one result object like
// Claude Code 2.1.282 (docs: code.claude.com/docs/en/headless) and records its arguments, working
// folder, stdin, Rewake's marker and the variables a resume must carry in $FAKE_CLAUDE_LOG.
//   FAKE_CLAUDE = ok | limited | signedout | gone | fail; FAKE_CLAUDE_ERROR: the limit's message
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);

/** Everything on stdin, or "" when it is closed. */
async function readStdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  try {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    return text;
  }
  return text;
}

const stdin = await readStdin();
if (process.env.FAKE_CLAUDE_LOG)
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({
      args,
      cwd: process.cwd(),
      stdin,
      fire: process.env.AGENT_REWAKE_FIRE ?? null,
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
      hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
    })}\n`,
  );
const outcome = process.env.FAKE_CLAUDE ?? "ok";
const result = (is_error, text) =>
  process.stdout.write(
    `${JSON.stringify({ type: "result", subtype: "success", is_error, result: text, session_id: args[1] ?? "" })}\n`,
  );
if (outcome === "limited") {
  result(true, process.env.FAKE_CLAUDE_ERROR ?? "You've hit your session limit");
  process.exit(1);
}
if (outcome === "signedout") {
  result(true, "Not logged in · Please run /login");
  process.exit(1);
}
if (outcome === "gone") {
  process.stderr.write(`No conversation found with session ID: ${args[1] ?? ""}\n`);
  process.exit(1);
}
if (outcome === "fail") process.exit(2);
result(false, "ok");
