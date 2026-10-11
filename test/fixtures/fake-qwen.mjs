#!/usr/bin/env node
// A stand-in for the `qwen` CLI's headless resume in tests: records its arguments, folder and
// whatever arrived on stdin in $FAKE_QWEN_LOG, and answers as FAKE_QWEN says:
//   ok | limited | gone | failed
// `limited` is the token-plan text Qwen Code gives (quotaErrorDetection.ts at 6788c03); how a real
// headless run words and exits on it is not known, so the exit code here is a guess.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);

/** Everything on stdin, or "" when it is a terminal. */
async function readStdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const stdin = await readStdin();
if (process.env.FAKE_QWEN_LOG)
  appendFileSync(
    process.env.FAKE_QWEN_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), stdin })}\n`,
  );
const outcome = process.env.FAKE_QWEN ?? "ok";
if (outcome === "limited") {
  process.stderr.write(
    "429 Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC.\n",
  );
  process.exit(1);
}
if (outcome === "gone") {
  process.stderr.write(
    "No saved session found with ID 6f1c2b3a. Run `qwen --resume` without an ID to choose from existing sessions.\n",
  );
  process.exit(1);
}
if (outcome === "failed") {
  process.stderr.write("Error: something else broke\n");
  process.exit(1);
}
process.stdout.write("Continuing from where I left off.\n");
