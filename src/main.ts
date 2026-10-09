#!/usr/bin/env node
import { oldNodeMessage } from "./node-check.js";

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

import("./cli.js")
  .then(({ main }) => main(process.argv.slice(2)))
  .then(exitAfterFlush, (err: unknown) => {
    process.stderr.write(`agent-rewake: ${err instanceof Error ? err.message : String(err)}\n`);
    exitAfterFlush(1);
  });
