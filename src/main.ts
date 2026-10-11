#!/usr/bin/env node
import { oldNodeMessage } from "./node-check.js";

/**
 * Commands that don't own stdout for a protocol and aren't on a hook's or a timer's time budget:
 * safe to spend up to a few seconds flushing queued error reports after they finish. Proxy mode
 * (no args, `--wrap-*`, `-- <cmd>`), `mcp`, `hook`, `fire`, `sweep`, `wait` and `ui` are excluded
 * (AGENTS.md "Reliability rules": never await the network from a hook, and proxy mode owns stdout).
 */
const FLUSH_AFTER = new Set([
  "doctor",
  "install",
  "uninstall",
  "continue",
  "errors",
  "schedules",
  "setup",
]);

/** Exit once stdout has flushed, so the last protocol message is never cut off. */
function exitAfterFlush(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

// Checked before the rest of Rewake loads (it is imported below), so an old Node.js gets a plain
// message and not a stack trace from code it can't run.
const tooOld = oldNodeMessage(process.versions.node);
if (tooOld) {
  process.stderr.write(tooOld);
  process.exit(1);
}

Promise.all([import("./cli.js"), import("./errors/report.js"), import("./util/paths.js")]).then(
  ([{ main }, { flushPendingReports, reportError }, { stateDir }]) => {
    /** An uncaught exception or rejection, wherever it escaped from: ledgered, queued if opted in. */
    function reportCrash(name: string, error: unknown): void {
      try {
        reportError(stateDir(process.env), { name, error, tags: { place: "cli" } });
      } catch {
        // Observability must never crash the crash handler.
      }
    }

    // Belt and braces: a bug anywhere in a command that escapes as a truly uncaught exception or
    // rejection is recorded before the process exits, instead of being lost. Node's default
    // behaviour (exit non-zero) is preserved: a handler here suppresses that default, so each one
    // reports (fast, local, synchronous fs only — never the network) and then exits itself.
    process.on("uncaughtException", (err) => {
      reportCrash("process.uncaughtException", err);
      process.stderr.write(`agent-rewake: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      reportCrash("process.unhandledRejection", reason);
      process.stderr.write(
        `agent-rewake: ${reason instanceof Error ? reason.message : String(reason)}\n`,
      );
      process.exit(1);
    });

    async function run(): Promise<number> {
      const argv = process.argv.slice(2);
      const code = await main(argv);
      if (FLUSH_AFTER.has(argv[0] ?? "")) await flushPendingReports(stateDir(process.env));
      return code;
    }

    return run().then(exitAfterFlush, (err: unknown) => {
      reportCrash("cli.main_rejected", err);
      process.stderr.write(`agent-rewake: ${err instanceof Error ? err.message : String(err)}\n`);
      exitAfterFlush(1);
    });
  },
  (err: unknown) => {
    process.stderr.write(`agent-rewake: ${err instanceof Error ? err.message : String(err)}\n`);
    exitAfterFlush(1);
  },
);
