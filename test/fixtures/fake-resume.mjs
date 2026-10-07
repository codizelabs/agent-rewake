#!/usr/bin/env node
// A stand-in for `gemini` and `agy` resume runs in tests: records its arguments and folder in
// $FAKE_RESUME_LOG and answers like the real one (FAKE_RESUME = ok | limited | limited-stderr |
// silent). limited-stderr is Gemini CLI 0.62.0 with `-o json`: the error on stderr, exit 429 & 255.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_RESUME_LOG)
  appendFileSync(process.env.FAKE_RESUME_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
const outcome = process.env.FAKE_RESUME ?? "ok";
if (outcome === "limited") {
  process.stdout.write(
    `${JSON.stringify({ error: "RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h0m0s" })}\n`,
  );
  process.exit(1);
}
if (outcome === "limited-stderr") {
  process.stderr.write(
    `${JSON.stringify({ session_id: "s", error: { type: "Error", message: "Individual quota reached. Resets in 7200s.", code: 429 } }, null, 2)}\n`,
  );
  process.exit(173);
}
if (outcome === "silent") process.exit(0);
process.stdout.write(`${JSON.stringify({ response: "Continuing from where I left off." })}\n`);
