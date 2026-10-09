import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultTimerHost, timerEnv } from "../src/timers/timers.js";

const posix = process.platform !== "win32";
let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-timer-env-"));
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(dir, { recursive: true, force: true });
});

describe("the environment timer commands get", () => {
  it("keeps only what a timer needs, and never a secret-looking name", () => {
    const out = timerEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      USER: "me",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      TMPDIR: "/tmp",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      AGENT_REWAKE_STATE_DIR: "/state",
      GEMINI_API_KEY: "secret-1",
      GH_TOKEN: "secret-2",
      ANTHROPIC_API_KEY: "secret-3",
      XDG_SECRET_THING: "secret-4",
      AGENT_REWAKE_API_TOKEN: "secret-5",
      SSH_AUTH_SOCK: "/tmp/agent",
      NODE_OPTIONS: "--require x",
    });
    expect(Object.keys(out).sort()).toEqual([
      "AGENT_REWAKE_STATE_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TMPDIR",
      "USER",
      "XDG_RUNTIME_DIR",
    ]);
  });

  it.runIf(posix)(
    "reaches `at` and the detached waiter without the arming session's keys",
    async () => {
      // This one runs the real timer host against fake `at` and waiter programs in a temp folder
      // (nothing real is created), so it opts out of the switch that keeps tests off OS jobs.
      delete process.env.AGENT_REWAKE_TEST_NO_OS_TIMERS;
      // A fake `at` and a fake waiter that write the environment they were given to a file.
      const bin = join(dir, "bin");
      const script = (name: string) => {
        const p = join(bin, name);
        writeFileSync(p, `#!/bin/sh\nenv > "${join(dir, name)}.env"\necho "job 1 at x" >&2\n`);
        chmodSync(p, 0o755);
        return p;
      };
      mkdirSync(bin);
      script("at");
      const waiter = script("fake-waiter");
      process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
      process.env.GEMINI_API_KEY = "must-not-leak";
      process.env.GH_TOKEN = "must-not-leak";
      process.env.AGENT_REWAKE_STATE_DIR = "/keep/me";
      const h = defaultTimerHost(dir, "/n", "/c");
      h.run("at", ["-t", "202601010000"], "x\n");
      h.detached(waiter, []);
      // The shell creates the file empty before `env` fills it: wait for content, not existence.
      const filled = (name: string) =>
        existsSync(join(dir, name)) && readFileSync(join(dir, name), "utf8").length > 0;
      for (let i = 0; i < 200 && !filled("fake-waiter.env"); i++)
        await new Promise((r) => setTimeout(r, 50));
      for (const name of ["at", "fake-waiter"]) {
        const text = readFileSync(join(dir, `${name}.env`), "utf8");
        expect(text).not.toContain("must-not-leak");
        expect(text).not.toContain("GEMINI_API_KEY");
        expect(text).toContain("AGENT_REWAKE_STATE_DIR=/keep/me");
        expect(text).toContain("PATH=");
      }
    },
  );
});
