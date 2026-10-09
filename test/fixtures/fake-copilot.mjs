#!/usr/bin/env node
// A stand-in for the `copilot` CLI in tests. `--resume=<id> … --output-format json` with the
// prompt on stdin prints JSONL events like Copilot CLI 1.0.92 (research note §B.3.3) and records
// its arguments, working folder, stdin and Rewake's marker in $FAKE_COPILOT_LOG.
//   FAKE_COPILOT = ok | limited | fail | gone; FAKE_COPILOT_ERROR: the limit's message
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
if (process.env.FAKE_COPILOT_LOG)
  appendFileSync(
    process.env.FAKE_COPILOT_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), stdin, fire: process.env.AGENT_REWAKE_FIRE ?? null })}\n`,
  );
const outcome = process.env.FAKE_COPILOT ?? "ok";
process.stdout.write(`${JSON.stringify({ type: "session.start", data: {} })}\n`);
if (outcome === "limited") {
  process.stdout.write(
    `${JSON.stringify({ type: "session.error", data: { errorType: "rate_limit", errorCode: "user_weekly_rate_limited", message: process.env.FAKE_COPILOT_ERROR ?? "You've reached your weekly rate limit." } })}\n`,
  );
  process.exit(1);
}
if (outcome === "events") {
  // FAKE_COPILOT_EVENTS: a JSON array of the events to print, then exit 1.
  for (const e of JSON.parse(process.env.FAKE_COPILOT_EVENTS ?? "[]"))
    process.stdout.write(`${JSON.stringify(e)}\n`);
  process.exit(1);
}
if (outcome === "fail") process.exit(2);
if (outcome === "gone") {
  process.stderr.write(`Error: Session ${args[0]?.split("=")[1] ?? ""} not found\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ type: "assistant.message", data: { content: "ok" } })}\n`);
