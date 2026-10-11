#!/usr/bin/env node
// A stand-in for `opencode run --session <id>` in tests: records its arguments, folder and
// whatever arrived on stdin in $FAKE_OPENCODE_LOG, and answers as FAKE_OPENCODE says:
//   ok | gone | failed
// `gone` is run.ts's "Session not found" (UI.error, exit 1). A real run that meets a limit that
// still holds waits inside OpenCode's own retry loop, so there is no "limited" outcome here.
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
if (process.env.FAKE_OPENCODE_LOG)
  appendFileSync(
    process.env.FAKE_OPENCODE_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), stdin })}\n`,
  );
const outcome = process.env.FAKE_OPENCODE ?? "ok";
if (outcome === "gone") {
  process.stderr.write("Error: Session not found\n");
  process.exit(1);
}
if (outcome === "failed") {
  process.stderr.write("Error: something else broke\n");
  process.exit(1);
}
process.stdout.write("Continuing from where I left off.\n");
