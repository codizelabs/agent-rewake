import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { JsonRpcMessage } from "../src/acp/ndjson.js";
import { CONSUME, REWAKE_ID_PREFIX, Router, type RouterHooks } from "../src/acp/router.js";
import { META_WRAPPED, phase1Hooks } from "../src/proxy.js";

/** Collects newline-delimited output from a stream. */
function collector(stream: PassThrough) {
  const lines: string[] = [];
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let i = buf.indexOf("\n");
    while (i !== -1) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  });
  return lines;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

function setup(hooks?: RouterHooks) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();
  const toClient = collector(clientOut);
  const toAgent = collector(agentOut);
  const router = new Router({ clientIn, clientOut, agentIn, agentOut, ...(hooks && { hooks }) });
  router.start();
  return {
    router,
    fromClient: (raw: string) => clientIn.write(`${raw}\n`),
    fromAgent: (raw: string) => agentIn.write(`${raw}\n`),
    toClient,
    toAgent,
  };
}

describe("Router pass-through", () => {
  it("forwards unknown methods, _meta and custom fields byte-for-byte in both directions", async () => {
    const t = setup();
    const req =
      '{"jsonrpc":"2.0","id":7,"method":"_zed.dev/custom","params":{"x":1,"_meta":{"a":"b"}},"extra":true}';
    const note =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"plan_update"},"_meta":{"k":[1,2]}}}';
    const resp = '{"jsonrpc":"2.0","id":7,"result":{"weird":  "spacing kept"}}';
    t.fromClient(req);
    t.fromAgent(note);
    t.fromAgent(resp);
    await tick();
    expect(t.toAgent).toEqual([req]);
    expect(t.toClient).toEqual([note, resp]);
  });

  it("forwards agent->client requests and the client's responses unchanged", async () => {
    const t = setup();
    const perm =
      '{"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"s"}}';
    const answer =
      '{"jsonrpc":"2.0","id":"p1","result":{"outcome":{"outcome":"selected","optionId":"allow"}}}';
    t.fromAgent(perm);
    await tick();
    t.fromClient(answer);
    await tick();
    expect(t.toClient).toEqual([perm]);
    expect(t.toAgent).toEqual([answer]);
  });

  it("forwards malformed lines as-is instead of stopping", async () => {
    const t = setup();
    t.fromAgent("not json at all");
    t.fromAgent('{"jsonrpc":"2.0","method":"after"}');
    await tick();
    expect(t.toClient).toEqual(["not json at all", '{"jsonrpc":"2.0","method":"after"}']);
  });

  it("lets a hook consume a client message", async () => {
    const t = setup({
      onClientMessage: (m) => (m.method === "_rewake/ping" ? CONSUME : { kind: "forward" }),
    });
    t.fromClient('{"jsonrpc":"2.0","method":"_rewake/ping"}');
    t.fromClient('{"jsonrpc":"2.0","method":"other"}');
    await tick();
    expect(t.toAgent).toEqual(['{"jsonrpc":"2.0","method":"other"}']);
  });
});

describe("Rewake-originated requests", () => {
  it("uses its own id space and never forwards the response", async () => {
    const t = setup();
    const pending = t.router.requestAgent("session/prompt", { sessionId: "s" });
    await tick();
    const sent = JSON.parse(t.toAgent[0] ?? "{}") as JsonRpcMessage;
    expect(String(sent.id)).toMatch(new RegExp(`^${REWAKE_ID_PREFIX}`));
    t.fromAgent(
      JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { stopReason: "end_turn" } }),
    );
    const response = await pending;
    expect(response.result).toEqual({ stopReason: "end_turn" });
    await tick();
    expect(t.toClient).toEqual([]);
  });

  it("matches client responses to Rewake's client requests", async () => {
    const t = setup();
    const pending = t.router.requestClient("elicitation/create", { message: "Resume?" });
    await tick();
    const sent = JSON.parse(t.toClient[0] ?? "{}") as JsonRpcMessage;
    t.fromClient(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { action: "accept" } }));
    expect((await pending).result).toEqual({ action: "accept" });
    await tick();
    expect(t.toAgent).toEqual([]);
  });
});

describe("initialize rewrite", () => {
  it("reports Rewake's identity, keeps the wrapped agentInfo in _meta, and leaves authMethods untouched", async () => {
    const t = setup(phase1Hooks());
    t.fromClient('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}');
    const authMethods = [
      {
        id: "claude-ai-login",
        name: "Claude Subscription",
        type: "terminal",
        args: ["--cli", "auth", "login"],
      },
    ];
    t.fromAgent(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
          authMethods,
          _meta: { keep: 1 },
        },
      }),
    );
    await tick();
    const out = JSON.parse(t.toClient[0] ?? "{}") as { result: Record<string, unknown> };
    expect(out.result.agentInfo).toMatchObject({ name: "agent-rewake", title: "Agent Rewake" });
    expect(out.result.authMethods).toEqual(authMethods);
    expect(out.result._meta).toEqual({
      keep: 1,
      [META_WRAPPED]: { name: "claude-agent-acp", version: "0.85.1" },
    });
  });

  it("does not touch responses to other methods", async () => {
    const t = setup(phase1Hooks());
    t.fromClient('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}');
    const resp = '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"s","agentInfo":{"name":"x"}}}';
    t.fromAgent(resp);
    await tick();
    expect(t.toClient).toEqual([resp]);
  });
});
