#!/usr/bin/env node
// A stand-in for the `codex` CLI in tests, answering the way Codex 0.160.1 does (texts and exit
// codes observed: research/impl-codex-grok-2026-10-06.md §3.1.3, §3.1.5). Every call is appended
// to $FAKE_CODEX_LOG as one JSON line.
//   FAKE_CODEX_USAGE = allowed | limited | unknown | signed-out | silent   (account/rateLimits/read)
//   FAKE_CODEX_QUEUE = ok | archived | deleted | daemon           (codex queue)
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = (entry) => {
  if (process.env.FAKE_CODEX_LOG)
    appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ args, ...entry })}\n`);
};

if (args[0] === "app-server") {
  log({});
  const usage = process.env.FAKE_CODEX_USAGE ?? "allowed";
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const m = JSON.parse(line);
    if (usage === "silent") return;
    if (m.method === "initialize")
      process.stdout.write(
        `${JSON.stringify({ id: m.id, result: { userAgent: "codex/0.160.1" } })}\n`,
      );
    if (m.method === "account/rateLimits/read") {
      if (usage === "signed-out")
        process.stdout.write(
          `${JSON.stringify({ id: m.id, error: { code: -32600, message: "codex account authentication required to read rate limits" } })}\n`,
        );
      else
        process.stdout.write(
          `${JSON.stringify({
            id: m.id,
            result: {
              ordinaryUsageAllowed: usage === "unknown" ? null : usage === "allowed",
              rateLimits: {
                primary: {
                  usedPercent: usage === "allowed" ? 3 : 100,
                  resetsAt: Number(process.env.FAKE_CODEX_RESETS_AT ?? 0),
                },
                secondary: null,
              },
            },
          })}\n`,
        );
    }
  });
} else if (args[0] === "queue" || (args[0] === "queue" && args[1] === "--remote")) {
  const thread = args[args.indexOf("--thread") + 1];
  const outcome = process.env.FAKE_CODEX_QUEUE ?? "ok";
  log({ thread, message: args[args.indexOf("--message") + 1] });
  if (outcome === "daemon" && !args.includes("--remote")) {
    process.stderr.write(
      "Error: cannot queue through an embedded app server while a local app-server daemon is running\n",
    );
    process.exit(1);
  }
  if (outcome === "archived") {
    process.stderr.write(
      `Error: thread ${thread} is archived. Run \`codex unarchive ${thread}\`\n`,
    );
    process.exit(1);
  }
  if (outcome === "deleted") {
    process.stderr.write(
      `Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id ${thread} (code -32603)\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Queued message 01a1127f-b96e-7062-bfc9-8578b97f25dc for thread ${thread}.\n`,
  );
} else {
  log({});
  const failAdd =
    process.env.FAKE_CODEX_PLUGIN === "fail-add" && args[0] === "plugin" && args[1] === "add";
  if (process.env.FAKE_CODEX_PLUGIN === "fail" || failAdd) {
    process.stderr.write("Error: plugin command failed\n");
    process.exit(1);
  }
  process.stdout.write("{}\n");
}
