// The existing tests were written with 24-hour times ("15:00 today"). The product default is
// 12-hour; tests that cover it switch the default back themselves. Likewise the command name
// (src/util/command.ts), which otherwise depends on this computer's PATH.
import { beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { setClock } from "../src/core/time.js";
import { setStagger } from "../src/timers/slots.js";
import { setRewakeCommand } from "../src/util/command.js";

beforeEach(() => {
  DEFAULT_SETTINGS.clock = "24h";
  setClock("24h");
  // Texts name the command as installed globally; tests of the npx form set it themselves.
  setRewakeCommand("agent-rewake");
  // Resumes that start one after another in a test don't wait for their turn (src/timers/slots.ts).
  setStagger(0);
});

// A test must never leave a real OS job (launchd, systemd, at, Task Scheduler) in the session of
// whoever runs the tests: the timers are off, except in the jobs that test them for real.
if (process.env.REWAKE_OS_TIMERS !== "1" && process.env.REWAKE_E2E !== "1")
  process.env.AGENT_REWAKE_TEST_NO_OS_TIMERS = "1";
