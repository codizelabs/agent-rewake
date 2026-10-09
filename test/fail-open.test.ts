import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonRpcMessage } from "../src/acp/ndjson.js";
import { Router, type RouterHooks } from "../src/acp/router.js";
import { SchedulingAddon } from "../src/addon.js";
import { failOpenNotice, runProxy } from "../src/proxy.js";
import { Logger } from "../src/util/log.js";

const settle = () => new Promise((r) => setTimeout(r, 20));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-failopen-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function collect(stream: PassThrough): string[] {
  const out: string[] = [];
  let buf = "";
  stream.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i = buf.indexOf("\n");
    while (i !== -1) {
      out.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  });
  return out;
}

const boom = () => {
  throw new TypeError("secret detail: /Users/someone/project");
};

function routerWith(hooks: RouterHooks, o: { notice?: string } = {}) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();
  const failures: string[] = [];
  const toClient = collect(clientOut);
  const toAgent = collect(agentOut);
  const router = new Router({
    clientIn,
    clientOut,
    agentIn,
    agentOut,
    hooks,
    onFailOpen: (where) => failures.push(where),
    ...(o.notice && { failOpenNotice: o.notice }),
  });
  router.start();
  return {
    router,
    failures,
    toClient,
    toAgent,
    fromClient: (raw: string) => clientIn.write(`${raw}\n`),
    fromAgent: (raw: string) => agentIn.write(`${raw}\n`),
  };
}

const prompt = (id: number, sessionId = "s-1") =>
  `{"jsonrpc":"2.0","id":${id},"method":"session/prompt","params":{"sessionId":"${sessionId}","prompt":[{"type":"text","text":"hello"}]}}`;

describe("a Rewake bug in the router's hooks", () => {
  it("forwards the message that made a client hook throw, byte for byte", async () => {
    const t = routerWith({ onClientMessage: boom });
    t.fromClient(prompt(5));
    await settle();
    expect(t.toAgent).toEqual([prompt(5)]);
    expect(t.failures).toEqual(["client-message"]);
  });

  it("forwards an agent message and an agent response when their hooks throw", async () => {
    const t = routerWith({ onAgentMessage: boom, onAgentResponse: boom });
    const update =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"plan"}}}';
    t.fromAgent(update);
    t.fromClient(prompt(7));
    await settle();
    t.fromAgent('{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}');
    await settle();
    expect(t.toClient).toContain(update);
    expect(t.toClient).toContain('{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}');
  });

  it("stops calling hooks after the first failure and relays everything", async () => {
    let calls = 0;
    const t = routerWith({
      onClientMessage: () => {
        calls++;
        // A hook that would swallow every prompt, if it ran.
        if (calls > 1) return { kind: "consume" };
        return boom();
      },
    });
    t.fromClient(prompt(1));
    t.fromClient(prompt(2));
    t.fromClient(prompt(3));
    await settle();
    expect(calls).toBe(1);
    expect(t.toAgent).toEqual([prompt(1), prompt(2), prompt(3)]);
    expect(t.failures).toEqual(["client-message"]);
  });

  it("tells the person once, in their thread, without the error's text", async () => {
    const t = routerWith({ onClientMessage: boom }, { notice: "Rewake hit a problem." });
    t.fromClient(prompt(1));
    t.fromClient(prompt(2));
    await settle();
    const notes = t.toClient.map((l) => JSON.parse(l) as JsonRpcMessage);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.method).toBe("session/update");
    expect(notes[0]?.params).toMatchObject({
      sessionId: "s-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Rewake hit a problem." },
      },
    });
    expect(t.toClient.join("")).not.toContain("secret detail");
  });

  it("tells every thread that was in use, once each", async () => {
    const t = routerWith({}, { notice: "Rewake hit a problem." });
    t.fromClient(prompt(1, "s-1"));
    t.fromClient(prompt(2, "s-2"));
    await settle();
    t.router.failOpen("process", new Error("late"));
    t.router.failOpen("process", new Error("again"));
    t.fromClient(prompt(3, "s-3"));
    t.fromClient(prompt(4, "s-1"));
    await settle();
    const told = t.toClient
      .map((l) => (JSON.parse(l) as JsonRpcMessage).params)
      .map((p) => (p as { sessionId: string }).sessionId);
    expect(told.sort()).toEqual(["s-1", "s-2", "s-3"]);
  });

  it("reports every failure, not just the first, but switches off once", async () => {
    const seen: boolean[] = [];
    const clientIn = new PassThrough();
    const router = new Router({
      clientIn,
      clientOut: new PassThrough(),
      agentIn: new PassThrough(),
      agentOut: new PassThrough(),
      onFailOpen: (_where, _err, first) => seen.push(first),
    });
    router.start();
    router.failOpen("process", new Error("a"));
    router.failOpen("process", new Error("b"));
    expect(seen).toEqual([true, false]);
    expect(router.failedOpenNow).toBe(true);
  });

  it("waits to tell the person until a thread is known", async () => {
    const t = routerWith({}, { notice: "Rewake hit a problem." });
    t.router.failOpen("process", new Error("late"));
    await settle();
    expect(t.toClient).toEqual([]);
    t.fromClient(prompt(1, "s-9"));
    await settle();
    expect(t.toClient).toHaveLength(1);
    expect(t.toClient[0]).toContain('"sessionId":"s-9"');
    expect(t.toAgent).toEqual([prompt(1, "s-9")]);
  });
});

describe("a Rewake bug in the real add-on", () => {
  it("keeps the agent's traffic flowing, untouched, once the add-on fails", async () => {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const agentIn = new PassThrough();
    const agentOut = new PassThrough();
    const toClient = collect(clientOut);
    const toAgent = collect(agentOut);
    let broken = false;
    const addon = new SchedulingAddon({
      stateDir: dir,
      log: new Logger({ AGENT_REWAKE_STATE_DIR: dir }),
      // The add-on reads the clock for every prompt: a clock that throws is a bug inside it.
      now: () => {
        if (broken) throw new RangeError("simulated bug");
        return Date.now();
      },
      heartbeatMs: 3_600_000,
      locale: "en-GB",
      jitterMs: 0,
      env: { CLAUDE_CONFIG_DIR: join(dir, "claude-config") },
      selfCommand: { command: "/node", args: ["/rewake.js"] },
      askOnNewThreads: false,
      firstUseNote: false,
      wake: { supported: true, set: () => false, release: () => {} },
      sleepSettings: () => ({ os: "macos", pluggedInSleepMin: 0, onBattery: false }),
    });
    const router = new Router({
      clientIn,
      clientOut,
      agentIn,
      agentOut,
      hooks: addon.hooks(),
      failOpenNotice: failOpenNotice(),
      onFailOpen: () => addon.failOpen(),
    });
    addon.attach(router);
    router.start();

    // A session the way Zed opens one; the add-on works.
    clientIn.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/project", mcpServers: [] } })}\n`,
    );
    await settle();
    agentIn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "s-1" } })}\n`);
    await settle();
    expect(toClient.some((l) => l.includes('"id":1'))).toBe(true);

    // Now the add-on breaks. The person's message still reaches the agent, exactly as sent.
    broken = true;
    const message = prompt(2);
    clientIn.write(`${message}\n`);
    await settle();
    expect(toAgent).toContain(message);

    // The agent's reply and later traffic still reach the client untouched.
    const reply = '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}';
    agentIn.write(`${reply}\n`);
    const update =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}';
    agentIn.write(`${update}\n`);
    clientIn.write(`${prompt(3)}\n`);
    await settle();
    expect(toClient).toContain(reply);
    expect(toClient).toContain(update);
    expect(toAgent).toContain(prompt(3));

    // The person was told once, in plain words.
    const notices = toClient.filter((l) => l.includes("Rewake hit a problem"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain("simulated bug");
    addon.stop();
  });
});

describe("the proxy with a real agent process", () => {
  /** An agent that answers every request with its own method name, and one stray notification. */
  const agentScript = (): string => {
    const file = join(dir, "echo-agent.mjs");
    writeFileSync(
      file,
      `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (raw) => {
  const m = JSON.parse(raw);
  if (m.method === "die") process.exit(3);
  if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { echo: m.method } }) + "\\n");
});
`,
    );
    return file;
  };

  const logLines = (): string => {
    const logs = join(dir, "logs");
    return readdirSync(logs)
      .map((f) => readFileSync(join(logs, f), "utf8"))
      .join("");
  };

  async function run(hooks: RouterHooks, o: { processError?: () => void } = {}) {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const toClient = collect(clientOut);
    let failed = 0;
    let restarted = 0;
    const done = runProxy({
      agent: { command: process.execPath, args: [agentScript()], env: { ...process.env } },
      clientIn,
      clientOut,
      log: new Logger({ AGENT_REWAKE_STATE_DIR: dir }),
      hooks,
      onFailOpen: () => {
        failed++;
      },
      onAgentRestarted: () => {
        restarted++;
      },
      ...(o.processError && { handleProcessErrors: true }),
    });
    const send = (id: number, method: string) =>
      clientIn.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params: { sessionId: "s-1" } })}\n`,
      );
    return { clientIn, toClient, done, send, failures: () => failed, restarts: () => restarted };
  }

  it("keeps answering the client after a hook throws, and logs only the error's name", async () => {
    const p = await run({ onClientMessage: boom });
    p.send(1, "session/prompt");
    await new Promise((r) => setTimeout(r, 300));
    p.send(2, "session/prompt");
    await new Promise((r) => setTimeout(r, 300));
    const replies = p.toClient.map((l) => JSON.parse(l) as JsonRpcMessage);
    expect(replies.filter((m) => m.id === 1 || m.id === 2).map((m) => m.result)).toEqual([
      { echo: "session/prompt" },
      { echo: "session/prompt" },
    ]);
    expect(p.failures()).toBe(1);
    const log = logLines();
    expect(log).toContain('"event":"addon.error"');
    expect(log).toContain('"error":"TypeError"');
    expect(log).not.toContain("secret detail");
    p.clientIn.end();
    expect(await p.done).toBe(0);
  });

  it("doesn't restart the agent for the add-on once it has failed open: it ends with the agent", async () => {
    const p = await run({ onClientMessage: boom });
    p.send(1, "session/prompt");
    await new Promise((r) => setTimeout(r, 200));
    p.send(2, "die");
    expect(await p.done).toBe(3);
    expect(p.restarts()).toBe(0);
  });

  it("restarts the agent for the add-on as usual while nothing has failed", async () => {
    const p = await run({});
    p.send(1, "die");
    await new Promise((r) => setTimeout(r, 500));
    expect(p.restarts()).toBe(1);
    p.clientIn.end();
    await p.done;
  });

  it("treats an uncaught exception or rejection as a failure of its own handling, not of the session", async () => {
    // The test runner reports unhandled errors itself: set its listeners aside while one is raised.
    const saved = {
      uncaughtException: process.listeners("uncaughtException"),
      unhandledRejection: process.listeners("unhandledRejection"),
    };
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    try {
      const p = await run({}, { processError: () => {} });
      process.emit("uncaughtException", new TypeError("secret detail"), "uncaughtException");
      process.emit("unhandledRejection", new RangeError("another"), Promise.resolve());
      p.send(1, "session/prompt");
      await new Promise((r) => setTimeout(r, 300));
      const replies = p.toClient.map((l) => JSON.parse(l) as JsonRpcMessage);
      expect(replies.find((m) => m.id === 1)?.result).toEqual({ echo: "session/prompt" });
      expect(p.failures()).toBe(1);
      p.clientIn.end();
      expect(await p.done).toBe(0);
      // Its own listeners are gone once it ends.
      expect(process.listeners("uncaughtException")).toEqual([]);
    } finally {
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
      for (const [event, fns] of Object.entries(saved))
        for (const fn of fns) process.on(event as "uncaughtException", fn);
    }
  });
});

describe("the notice", () => {
  it("is plain words, names no error, and says what to do", () => {
    const text = failOpenNotice();
    expect(text).toContain("Your agent is not affected");
    expect(text).toContain("doctor --details");
    expect(text).not.toMatch(/exception|stack|TypeError|undefined/i);
  });
});
