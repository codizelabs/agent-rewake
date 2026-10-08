#!/usr/bin/env node
// A stand-in for the `grok` CLI's headless resume in tests: records its arguments, folder and
// what `--prompt-file` pointed at (its contents, and the file's mode) in $FAKE_GROK_LOG.
//   FAKE_GROK = ok | limited | gone
import { appendFileSync, readFileSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const file = args[args.indexOf("--prompt-file") + 1];
let prompt = null;
let mode = null;
if (args.includes("--prompt-file") && file) {
  prompt = readFileSync(file, "utf8");
  mode = statSync(file).mode & 0o777;
}
if (process.env.FAKE_GROK_LOG)
  appendFileSync(
    process.env.FAKE_GROK_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), prompt, mode, file: file ?? null })}\n`,
  );
const outcome = process.env.FAKE_GROK ?? "ok";
if (outcome === "limited") {
  process.stderr.write("You have reached your weekly limit.\n");
  process.exit(1);
}
if (outcome === "gone") {
  process.stderr.write("Error: No session matched\n");
  process.exit(1);
}
const session = args[args.indexOf("-r") + 1] ?? "";
process.stdout.write(`${JSON.stringify({ type: "result", sessionId: session })}\n`);
