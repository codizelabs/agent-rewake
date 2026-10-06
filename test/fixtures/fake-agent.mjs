// A minimal scripted ACP agent for tests. It answers initialize, session/new and session/prompt,
// streams one update per prompt, sends one agent->client request, and echoes unknown requests.
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const out = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);

// Terminal-auth relaunch: the client re-runs the agent with the auth method's args.
if (process.argv.includes("--cli")) {
  process.stdout.write(`fake login: ${process.argv.slice(2).join(" ")}\n`);
  process.exit(0);
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (raw) => {
  const m = JSON.parse(raw);
  if (m.method === "initialize") {
    out({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-agent", version: "9.9.9" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        authMethods: [{ id: "login", name: "Log in", type: "terminal", args: ["--cli", "login"] }],
        _meta: { "fake/extra": 1 },
      },
    });
  } else if (m.method === "session/new") {
    const configOptions = process.env.FAKE_CONFIG_OPTIONS
      ? [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "a",
            options: [{ value: "a", name: "A" }],
          },
        ]
      : undefined;
    out({ id: m.id, result: { sessionId: "s-1", ...(configOptions && { configOptions }) } });
  } else if (m.method === "session/resume") {
    out({ id: m.id, result: {} });
  } else if (
    m.method === "session/prompt" &&
    m.params.prompt?.[0]?.text === "crash" &&
    process.env.FAKE_CRASH_FLAG &&
    !existsSync(process.env.FAKE_CRASH_FLAG)
  ) {
    // Simulate the agent process dying mid-turn, once (the flag file survives the restart).
    writeFileSync(process.env.FAKE_CRASH_FLAG, "crashed");
    process.exit(1);
  } else if (m.method === "session/prompt" && m.params.prompt?.[0]?.text === "crash") {
    out({ id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.method === "session/prompt") {
    out({
      method: "session/update",
      params: {
        sessionId: m.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        _meta: { "fake/untouched": true },
      },
    });
    out({
      id: "perm-1",
      method: "session/request_permission",
      params: { sessionId: m.params.sessionId },
    });
    globalThis.pendingPrompt = m.id;
  } else if (m.id === "perm-1") {
    out({ id: globalThis.pendingPrompt, result: { stopReason: "end_turn" } });
  } else if (m.method === "malformed/please") {
    process.stdout.write("this is not json\n");
  } else if (m.id !== undefined && m.method) {
    out({ id: m.id, result: { echoed: m.method, params: m.params ?? null } });
  }
});
rl.on("close", () => process.exit(0));
