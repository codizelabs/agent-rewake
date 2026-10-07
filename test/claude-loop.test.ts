import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Mock, startMock } from "./e2e/mock-llm.mjs";

/**
 * The whole loop in Zed's Agent Panel, offline (plan §10.2 L3; research testing-harness §2.1.4):
 * a client speaks ACP to the built bundle, which runs the real Claude adapter and Claude Code
 * (from npm ci) against a local mock of Anthropic's API. The mock answers with a subscriber's
 * session limit; Rewake offers to resume; "/schedule resume" schedules it; at the reset Rewake sends
 * its resume message and the same session continues, once.
 *
 * Offline by construction: the agent's only endpoint is the mock, and on macOS the run is wrapped in
 * sandbox-exec with all outbound network denied except to localhost. The credential is a made-up
 * string that only the mock ever sees. Slow (about a minute: Claude Code gives the reset to the
 * minute), so it runs only with REWAKE_E2E=1 (the e2e-hosts CI job).
 */
// The network guard exists on macOS only; elsewhere the test runs only when asked to run unguarded.
const enabled =
  process.env.REWAKE_E2E === "1" &&
  (process.platform === "darwin" || process.env.REWAKE_E2E_UNGUARDED === "1");
const root = join(import.meta.dirname, "..");
const bundle = join(root, "dist", "agent-rewake.js");

/** macOS's sandbox: no network except localhost (the guard fails the test if it can't run). */
const SANDBOX = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))`;

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };

function drive(env: NodeJS.ProcessEnv) {
  const [command, args] =
    process.platform === "darwin"
      ? ["/usr/bin/sandbox-exec", ["-p", SANDBOX, process.execPath, bundle]]
      : [process.execPath, [bundle]];
  const child = spawn(command, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const seen: Msg[] = [];
  const waiting = new Map<number, (m: Msg) => void>();
  let buf = "";
  let next = 1;
  child.stdout.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m: Msg;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      seen.push(m);
      if (m.id !== undefined && !m.method) waiting.get(m.id)?.(m);
      // Requests from the agent side: decline permissions, no file access.
      else if (m.id !== undefined && m.method)
        child.stdin.write(
          `${JSON.stringify(
            m.method === "session/request_permission"
              ? { jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "cancelled" } } }
              : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported" } },
          )}\n`,
        );
    }
  });
  const request = (method: string, params: unknown) =>
    new Promise<Msg>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  /** The agent's text shown in the thread so far, for one session. */
  const text = (sessionId: string) =>
    seen
      .filter((m) => m.method === "session/update" && m.params?.sessionId === sessionId)
      .map((m) => (m.params?.update as { content?: { text?: string } })?.content?.text ?? "")
      .join("");
  const until = async (ok: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
    return ok();
  };
  return { child, request, text, until };
}

describe.runIf(enabled)("Zed's Agent Panel, offline: limit → resume (Claude)", () => {
  it("offers to resume at the reset, then continues the same session once", async () => {
    const home = mkdtempSync(join(tmpdir(), "rewake-loop-"));
    const work = join(home, "work");
    mkdirSync(work);
    execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], {
      cwd: root,
      stdio: "ignore",
    });
    let mock: Mock | undefined;
    let d: ReturnType<typeof drive> | undefined;
    try {
      mock = await startMock();
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "",
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        AGENT_REWAKE_STATE_DIR: join(home, "state"),
        AGENT_REWAKE_TEST_TIMING: "margin=0,jitter=0,heartbeat=1000",
        ANTHROPIC_BASE_URL: mock.url,
        // A made-up subscriber token: it reaches only the mock (research §2.1.2).
        CLAUDE_CODE_OAUTH_TOKEN: "rewake-test-not-a-real-token",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
      };
      mock.set({ mode: "limit", until: Date.now() + 5_000, claim: "five_hour" });
      d = drive(env);
      await d.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      const created = await d.request("session/new", { cwd: work, mcpServers: [] });
      const sessionId = (created.result as { sessionId: string }).sessionId;
      expect(sessionId).toBeTruthy();
      await d.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "say hi" }] });
      // Rewake recognises the subscriber limit and offers to resume at the reset.
      expect(
        await d.until(
          () => /Resume this thread when it resets\?/.test(d?.text(sessionId) ?? ""),
          30_000,
        ),
      ).toBe(true);
      await d.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "/schedule resume" }],
      });
      expect(
        await d.until(
          () => /will resume when the limit resets/.test(d?.text(sessionId) ?? ""),
          15_000,
        ),
      ).toBe(true);
      // At the reset (to the minute), the resume goes into the same session and the agent answers.
      expect(await d.until(() => /RESUMED_OK/.test(d?.text(sessionId) ?? ""), 120_000)).toBe(true);
      expect(d.text(sessionId)).toMatch(/Agent Rewake sent this message after a usage limit reset/);
      // Once: one resume, no second send.
      await new Promise((r) => setTimeout(r, 3_000));
      expect(d.text(sessionId).match(/RESUMED_OK/g)).toHaveLength(1);
      // Every request went to the mock.
      expect(mock.requests().some((r) => r.startsWith("POST /v1/messages"))).toBe(true);
    } finally {
      d?.child.kill();
      await mock?.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 240_000);
});
