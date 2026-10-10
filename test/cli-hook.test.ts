import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { readStdin } from "../src/hosts/hook.js";
import { hookHandler } from "../src/hosts/index.js";
import { SessionRecords } from "../src/hosts/sessions.js";

/**
 * `agent-rewake hook <host> <event>`, run in this process: the command every installed agent hook
 * runs (src/cli.ts runHookCommand). The agents' own tests drive their handlers directly; these pin
 * the way in: the host id names the right handler, the event comes from stdin, and a hook never
 * fails or prints anything it shouldn't. The OS-timer switch (test/setup.ts) stays on.
 */

const SID = "8a3c1f2e-0b5d-4c7a-9e21-3f6b8d0c4a17";
const LIMIT =
  "You've reached your weekly rate limit. Please wait for your limit to reset in 3 hours or switch to auto model to continue.";

let dir: string;
let state: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-hook-cmd-"));
  state = join(dir, "state");
  mkdirSync(join(dir, "work"));
  env = { AGENT_REWAKE_STATE_DIR: state, HOME: dir, USERPROFILE: dir, PATH: process.env.PATH };
  // Nothing here may touch the real home folder.
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Run `agent-rewake hook …` with `input` on stdin; what it printed and its exit status. */
async function hook(args: string[], input: string, extra: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from([Buffer.from(input)]) as unknown as typeof process.stdin,
  );
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  const code = await main(["hook", ...args], { ...env, ...extra });
  vi.restoreAllMocks();
  return { code, out: out.join("") };
}

const limitEvent = () =>
  JSON.stringify({
    sessionId: SID,
    timestamp: Date.now(),
    cwd: join(dir, "work"),
    error: { message: LIMIT, name: "Error" },
    errorContext: "model_call",
    recoverable: false,
  });
const record = () => new SessionRecords(state, "copilot-cli").get(SID);

describe("agent-rewake hook", () => {
  it("reads the event from stdin and records the limit for that agent's session", async () => {
    const r = await hook(["copilot-cli", "errorOccurred"], limitEvent());
    expect(r).toEqual({ code: 0, out: "" });
    expect(record()).toMatchObject({ limit: { kind: "weekly", billing: false } });
  });

  it("does nothing, and still exits 0, for an unknown agent, bad input or Zed's own session", async () => {
    expect(await hook(["no-such-agent", "errorOccurred"], limitEvent())).toEqual({
      code: 0,
      out: "",
    });
    expect(await hook(["copilot-cli", "errorOccurred"], "{ not json")).toEqual({
      code: 0,
      out: "",
    });
    // Started by Rewake's Zed add-on: that add-on owns the session.
    expect(
      await hook(["copilot-cli", "errorOccurred"], limitEvent(), { AGENT_REWAKE_OWNER: "acp" }),
    ).toEqual({ code: 0, out: "" });
    expect(record()).toBeUndefined();
  });

  it("ignores input too large to be a hook event", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
    expect(await readStdin(Readable.from([big]))).toBe("");
    expect(await readStdin(Readable.from([Buffer.from('{"a":1}')]))).toBe('{"a":1}');
  });

  it("has a handler for every agent whose installer writes `hook <id>` commands", () => {
    const deps = {
      arm: () => true,
      disarm: () => {},
      notify: () => {},
      codexPath: () => undefined,
      closed: () => {
        throw new Error("not called");
      },
      program: () => undefined,
    };
    for (const id of [
      "codex",
      "copilot-cli",
      "grok",
      "gemini-cli",
      "qwen-code",
      "opencode",
      "cursor",
      "antigravity",
    ])
      expect(hookHandler(id, deps), id).toBeDefined();
  });
});
