#!/usr/bin/env node
import { main } from "./cli.js";

/** Exit once stdout has flushed, so the last protocol message is never cut off. */
function exitAfterFlush(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

main(process.argv.slice(2)).then(exitAfterFlush, (err: unknown) => {
  process.stderr.write(`agent-rewake: ${err instanceof Error ? err.message : String(err)}\n`);
  exitAfterFlush(1);
});
