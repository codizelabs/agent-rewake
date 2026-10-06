#!/usr/bin/env node
// A stand-in for the `copilot` CLI in tests. `--resume=<id> -p <text> … --output-format json`
// prints JSONL events like Copilot CLI 1.0.92 (research note §B.3.3) and records its arguments,
// working folder and Rewake's marker in $FAKE_COPILOT_LOG.
//   FAKE_COPILOT = ok | limited | fail
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_COPILOT_LOG)
  appendFileSync(
    process.env.FAKE_COPILOT_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), fire: process.env.AGENT_REWAKE_FIRE ?? null })}\n`,
  );
const outcome = process.env.FAKE_COPILOT ?? "ok";
process.stdout.write(`${JSON.stringify({ type: "session.start", data: {} })}\n`);
if (outcome === "limited") {
  process.stdout.write(
    `${JSON.stringify({ type: "session.error", data: { errorType: "rate_limit", errorCode: "user_weekly_rate_limited", message: "You've reached your weekly rate limit." } })}\n`,
  );
  process.exit(1);
}
if (outcome === "fail") process.exit(2);
process.stdout.write(`${JSON.stringify({ type: "assistant.message", data: { content: "ok" } })}\n`);
