import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonRpcMessage } from "../src/acp/ndjson.js";
import { Router } from "../src/acp/router.js";
import { SchedulingAddon, splitWhen } from "../src/addon.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import { ThreadStore } from "../src/core/threads.js";
import { callTool } from "../src/mcp.js";
import type { Wake } from "../src/util/keep-awake.js";
import { Logger } from "../src/util/log.js";

const HOUR = 3_600_000;
const T0 = new Date(2026, 9, 4, 14, 0, 0, 0).getTime(); // 4 Oct 2026 14:00 local
const settle = () => new Promise((r) => setTimeout(r, 15));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-addon-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function lines(stream: PassThrough): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  let buf = "";
  stream.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i = buf.indexOf("\n");
    while (i !== -1) {
      out.push(JSON.parse(buf.slice(0, i)) as JsonRpcMessage);
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  });
  return out;
}

/** Router + add-on with a fake client and a fake agent driven by the test. */
interface HarnessOptions {
  /** Present as Zed + the Claude adapter (enables limit handling). */
  claude?: boolean;
  forms?: boolean;
  env?: NodeJS.ProcessEnv;
  configOptions?: unknown[];
  titleMarkers?: boolean;
  /** The client runs terminals for the agent (ACP terminal/*). */
  terminals?: boolean;
  /** Present as Zed + this agent (its `agentInfo.name`), instead of Claude. */
  agentName?: string;
  /** The agent's `agentInfo.title` ("Codex", "Gemini CLI"). */
  agentTitle?: string;
  /** The wrapped agent's id in Zed's settings. */
  agentId?: string;
  /** Show the once-per-thread "How Rewake works" note (off in most tests). */
  firstUseNote?: boolean;
  /** Extra fields in the agent's session/new result (for example legacy `modes`/`models`). */
  sessionResult?: Record<string, unknown>;
  /** Ask about automatic resume when the session opens (off in most tests). */
  askOnNewThreads?: boolean;
  /** The keep-awake hold (most tests: one that never holds and says nothing). */
  wake?: Wake;
}

async function harness(stateDir = dir, o: HarnessOptions = {}) {
  let now = T0;
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();
  const toClient = lines(clientOut);
  const toAgent = lines(agentOut);
  const addon = new SchedulingAddon({
    stateDir,
    log: new Logger({ AGENT_REWAKE_STATE_DIR: stateDir }),
    now: () => now,
    heartbeatMs: 3_600_000, // ticks are driven manually
    locale: "en-GB",
    jitterMs: 0,
    env: o.env ?? { CLAUDE_CONFIG_DIR: join(stateDir, "claude-config") },
    ...(o.titleMarkers !== undefined && { titleMarkers: o.titleMarkers }),
    ...(o.agentId && { agentId: o.agentId }),
    selfCommand: { command: "/node", args: ["/rewake.js"] },
    askOnNewThreads: o.askOnNewThreads ?? false,
    firstUseNote: o.firstUseNote ?? false,
    wake: o.wake ?? { supported: true, set: () => false, release: () => {} },
  });
  const router = new Router({ clientIn, clientOut, agentIn, agentOut, hooks: addon.hooks() });
  addon.attach(router);
  router.start();
  const client = (m: object) => clientIn.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const agent = (m: object) => agentIn.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);

  if (o.claude || o.agentName) {
    client({
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "zed", version: "1.22.0" },
        clientCapabilities: {
          ...(o.forms !== false && { elicitation: { form: {} } }),
          ...(o.terminals && { terminal: true }),
        },
      },
    });
    await settle();
    agent({
      id: 0,
      result: {
        protocolVersion: 1,
        agentInfo: {
          name: o.agentName ?? "@agentclientprotocol/claude-agent-acp",
          ...(o.agentTitle && { title: o.agentTitle }),
        },
      },
    });
    await settle();
  }
  // Open a session the way Zed does.
  client({ id: 1, method: "session/new", params: { cwd: "/project", mcpServers: [] } });
  await settle();
  agent({
    id: 1,
    result: {
      sessionId: "s-1",
      ...(o.configOptions && { configOptions: o.configOptions }),
      ...o.sessionResult,
    },
  });
  await settle();

  const texts = () =>
    toClient
      .filter((m) => m.method === "session/update")
      .map((m) => (m.params as { update: { content?: { text?: string } } }).update.content?.text)
      .filter((t): t is string => typeof t === "string");
  const prompt = (id: number, text: string) =>
    client({
      id,
      method: "session/prompt",
      params: { sessionId: "s-1", prompt: [{ type: "text", text }] },
    });

  return {
    addon,
    toClient,
    toAgent,
    client,
    agent,
    prompt,
    texts,
    advance: (ms: number) => {
      now += ms;
    },
    store: new ScheduleStore(stateDir),
  };
}

describe("session registration", () => {
  it("advertises /schedule and /stop after the session response, merged with the agent's commands", async () => {
    const h = await harness();
    const order = h.toClient.map((m) => (m.id === 1 ? "response" : m.method));
    expect(order).toEqual(["response", "session/update"]);
    const names = (cmds: unknown) => (cmds as Array<{ name: string }>).map((c) => c.name);
    const first = h.toClient[1]?.params as { update: { availableCommands: unknown } };
    expect(names(first.update.availableCommands)).toEqual(["schedule", "stop"]);

    h.agent({
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "compact" }],
        },
      },
    });
    await settle();
    const merged = h.toClient.at(-1)?.params as { update: { availableCommands: unknown } };
    expect(names(merged.update.availableCommands)).toEqual(["compact", "schedule", "stop"]);
    h.addon.stop();
  });
});

describe("/schedule", () => {
  it("creates a schedule without sending anything to the agent", async () => {
    const h = await harness();
    h.prompt(2, "/schedule in 1h Continue the refactor");
    await settle();
    expect(h.toAgent.filter((m) => m.method === "session/prompt")).toEqual([]);
    expect(h.toClient.find((m) => m.id === 2)?.result).toEqual({ stopReason: "end_turn" });
    expect(h.texts().at(-1)).toBe(
      "Rewake: Scheduled for 15:00 today. Type /schedule list to see or change it.",
    );
    const [s] = h.store.list();
    expect(s).toMatchObject({
      sessionId: "s-1",
      cwd: "/project",
      text: "Continue the refactor",
      dueAt: T0 + HOUR,
    });
    h.addon.stop();
  });

  it("rejects an unknown time and stores nothing", async () => {
    const h = await harness();
    h.prompt(2, "/schedule whenever Do it");
    await settle();
    expect(h.texts().at(-1)).toMatch(/^Rewake: Couldn't do that\./);
    expect(h.store.list()).toEqual([]);
    h.addon.stop();
  });

  it("lists, moves, edits, pauses, resumes and deletes by number", async () => {
    const h = await harness();
    h.prompt(2, "/schedule in 2h Second");
    h.prompt(3, "/schedule in 1h First");
    await settle();
    h.prompt(4, "/schedule list");
    await settle();
    expect(h.texts().at(-1)).toContain("| 1 | 15:00 today | First | Scheduled |");
    expect(h.texts().at(-1)).toContain("| 2 | 16:00 today | Second | Scheduled |");

    h.prompt(5, "/schedule move 2 tomorrow 09:00");
    h.prompt(6, "/schedule edit 1 First, edited");
    h.prompt(7, "/schedule pause 1");
    await settle();
    h.prompt(8, "/schedule list");
    await settle();
    expect(h.texts().at(-1)).toContain("| 1 | 15:00 today | First, edited | Paused |");
    expect(h.texts().at(-1)).toContain("| 2 | 09:00 tomorrow (Monday) | Second | Scheduled |");

    h.prompt(9, "/schedule resume 1");
    h.prompt(10, "/schedule rm 2");
    await settle();
    expect(h.store.list().map((s) => [s.text, s.status])).toEqual([["First, edited", "scheduled"]]);
    h.addon.stop();
  });
});

describe("delivery", () => {
  it("sends a due message into the same session, shows it as a user message, and marks it sent", async () => {
    const h = await harness();
    h.prompt(2, "/schedule in 1h Continue the refactor");
    await settle();
    h.advance(HOUR);
    h.addon.tick();
    await settle();
    const sent = h.toAgent.find((m) => m.method === "session/prompt");
    expect(sent?.params).toEqual({
      sessionId: "s-1",
      prompt: [{ type: "text", text: "Continue the refactor" }],
    });
    expect(String(sent?.id)).toMatch(/^agent-rewake:/);
    const user = h.toClient.find(
      (m) =>
        (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
        "user_message_chunk",
    );
    expect(user).toBeDefined();
    expect(h.texts()).toContain(
      "Rewake: Sending your scheduled message. To stop the reply, type /stop.",
    );

    h.agent({ id: sent?.id, result: { stopReason: "end_turn" } });
    await settle();
    expect(h.store.list()[0]?.status).toBe("sent");
    expect(h.toClient.some((m) => m.id === sent?.id)).toBe(false); // Rewake's own response is never forwarded
    h.addon.stop();
  });

  it("waits for the user's running turn, then sends", async () => {
    const h = await harness();
    h.prompt(2, "/schedule in 1h Later");
    await settle();
    h.prompt(3, "a normal message");
    await settle();
    h.advance(HOUR);
    h.addon.tick();
    await settle();
    expect(h.toAgent.filter((m) => m.method === "session/prompt")).toHaveLength(1); // only the user's
    expect(h.store.list()[0]?.status).toBe("queued");
    h.agent({ id: 3, result: { stopReason: "end_turn" } });
    await settle();
    expect(h.toAgent.filter((m) => m.method === "session/prompt")).toHaveLength(2);
    h.addon.stop();
  });

  it("holds a user message typed during a scheduled reply, then forwards it", async () => {
    const h = await harness();
    h.prompt(2, "/schedule in 1h Scheduled");
    await settle();
    h.advance(HOUR);
    h.addon.tick();
    await settle();
    const sent = h.toAgent.find((m) => m.method === "session/prompt");
    h.prompt(3, "typed meanwhile");
    await settle();
    expect(h.toAgent.filter((m) => m.method === "session/prompt")).toHaveLength(1);
    h.agent({ id: sent?.id, result: { stopReason: "end_turn" } });
    await settle();
    const forwarded = h.toAgent.filter((m) => m.method === "session/prompt");
    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]?.id).toBe(3);
    h.agent({ id: 3, result: { stopReason: "end_turn" } });
    await settle();
    expect(h.toClient.find((m) => m.id === 3)?.result).toEqual({ stopReason: "end_turn" });
    h.addon.stop();
  });

  it("/stop cancels a running scheduled reply", async () => {
    const h = await harness();
    h.prompt(2, "/schedule in 1h Scheduled");
    await settle();
    h.advance(HOUR);
    h.addon.tick();
    await settle();
    const sent = h.toAgent.find((m) => m.method === "session/prompt");
    h.prompt(3, "/stop");
    await settle();
    expect(h.toAgent.some((m) => m.method === "session/cancel")).toBe(true);
    h.agent({ id: sent?.id, result: { stopReason: "cancelled" } });
    await settle();
    expect(h.store.list()[0]?.status).toBe("stopped");
    h.addon.stop();
  });

  it("marks a message missed instead of sending it hours late", async () => {
    const h = await harness();
    h.prompt(2, "/schedule in 1h Too late");
    await settle();
    h.advance(3 * HOUR);
    h.addon.tick();
    await settle();
    expect(h.toAgent.filter((m) => m.method === "session/prompt")).toEqual([]);
    expect(h.store.list()[0]?.status).toBe("missed");
    expect(h.texts().at(-1)).toMatch(/^Rewake: Missed\./);
    h.addon.stop();
  });

  it("records a failure with the agent's error", async () => {
    const h = await harness();
    h.prompt(2, "/schedule in 1h Will fail");
    await settle();
    h.advance(HOUR);
    h.addon.tick();
    await settle();
    const sent = h.toAgent.find((m) => m.method === "session/prompt");
    h.agent({ id: sent?.id, error: { code: -32603, message: "Internal error: boom" } });
    await settle();
    expect(h.store.list()[0]).toMatchObject({ status: "failed" });
    expect(h.texts().at(-1)).toMatch(/^Rewake: Couldn't send\./);
    h.addon.stop();
  });

  it("lets only the process that owns the thread deliver", async () => {
    const a = await harness();
    a.prompt(2, "/schedule in 1h Once");
    await settle();
    const b = await harness(); // a second Zed window: same state dir, same session
    a.advance(HOUR);
    b.advance(HOUR);
    b.addon.tick();
    a.addon.tick();
    await settle();
    expect(b.toAgent.filter((m) => m.method === "session/prompt")).toEqual([]);
    expect(a.toAgent.filter((m) => m.method === "session/prompt")).toHaveLength(1);
    a.addon.stop();
    b.addon.stop();
  });
});

describe("thread-title markers", () => {
  const titles = (h: Awaited<ReturnType<typeof harness>>) =>
    h.toClient
      .map((m) => (m.params as { update?: { sessionUpdate?: string; title?: string } })?.update)
      .filter((u) => u?.sessionUpdate === "session_info_update")
      .map((u) => u?.title);

  it("prefixes the agent's title while something is scheduled or running, then restores it", async () => {
    const h = await harness(dir, { titleMarkers: true });
    h.agent({
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: { sessionUpdate: "session_info_update", title: "Fix login" },
      },
    });
    await settle();
    h.prompt(2, "/schedule in 1h Continue");
    await settle();
    expect(titles(h).at(-1)).toBe("Scheduled 15:00 · Fix login");

    // A new title from the agent keeps the marker.
    h.agent({
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: { sessionUpdate: "session_info_update", title: "Fix login flow" },
      },
    });
    await settle();
    expect(titles(h).at(-1)).toBe("Scheduled 15:00 · Fix login flow");

    h.advance(HOUR);
    h.addon.tick();
    await settle();
    expect(titles(h).at(-1)).toBe("Running scheduled · Fix login flow");
    const sent = h.toAgent.find((m) => m.method === "session/prompt");
    h.agent({ id: sent?.id, result: { stopReason: "end_turn" } });
    await settle();
    expect(titles(h).at(-1)).toBe("Fix login flow");
    h.addon.stop();
  });

  it("never sends a title before the agent has provided one", async () => {
    const h = await harness(dir, { titleMarkers: true });
    h.prompt(2, "/schedule in 1h Continue");
    await settle();
    expect(titles(h)).toEqual([]);
    h.addon.stop();
  });
});

describe("/schedule page", () => {
  it("writes a Markdown overview and links to it", async () => {
    const h = await harness();
    h.prompt(2, "/schedule in 1h Check CI");
    h.prompt(3, "/schedule page");
    await settle();
    const reply = h.texts().at(-1) ?? "";
    const url = /\((file:\/\/[^)]+Schedules\.md)\)/.exec(reply)?.[1];
    expect(url).toBeDefined();
    const md = readFileSync(new URL(url ?? ""), "utf8");
    expect(md).toContain("| 15:00 today | Scheduled | Message | Check CI |");
    h.addon.stop();
  });
});

describe("ownership on every delivery path", () => {
  it("a non-owner never delivers, even when its own user turn ends after the due time", async () => {
    const a = await harness();
    a.prompt(2, "/schedule in 1h Owned by A");
    await settle();
    const b = await harness();
    b.advance(HOUR);
    b.prompt(3, "a message in window B");
    await settle();
    b.agent({ id: 3, result: { stopReason: "end_turn" } }); // B's turn ends: B checks for due messages
    await settle();
    expect(b.toAgent.filter((m) => m.method === "session/prompt")).toHaveLength(1); // only B's own message
    a.addon.stop();
    b.addon.stop();
  });
});

describe("splitWhen", () => {
  it("takes the longest time phrase", () => {
    expect(splitWhen("tomorrow 09:00 Do it", T0).text).toBe("Do it");
    expect(splitWhen("in 1h 30m Do it", T0)).toEqual({ at: T0 + 90 * 60_000, text: "Do it" });
    expect(splitWhen("18:00 Do it", T0).text).toBe("Do it");
  });
});

// ---- resume after a usage limit ----------------------------------------------------

const RESET = T0 + 3 * HOUR; // 17:00
const limitErr = {
  code: -32603,
  message: "Internal error: You've hit your session limit · resets 5pm",
  data: { errorKind: "rate_limit" },
};
const rateEvent = (resetAt: number) => ({
  method: "_claude/sdkMessage",
  params: {
    sessionId: "s-1",
    message: {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: resetAt / 1000 },
    },
  },
});

/** Send a user message and have the agent fail it with a usage limit. */
async function hitLimit(h: Awaited<ReturnType<typeof harness>>, id: number) {
  h.prompt(id, "keep going");
  await settle();
  h.agent(rateEvent(RESET));
  h.agent({ id, error: limitErr });
  await settle();
}

const forms = (h: Awaited<ReturnType<typeof harness>>) =>
  h.toClient.filter((m) => m.method === "elicitation/create");

/** Answer the newest form (Accept with these answers, or Decline). */
async function answer(
  h: Awaited<ReturnType<typeof harness>>,
  content: Record<string, unknown> | "decline",
) {
  h.client({
    id: forms(h).at(-1)?.id,
    result: content === "decline" ? { action: "decline" } : { action: "accept", content },
  });
  await settle();
}
const formMessage = (h: Awaited<ReturnType<typeof harness>>) =>
  (forms(h).at(-1)?.params as { message: string } | undefined)?.message;
const formKeys = (h: Awaited<ReturnType<typeof harness>>) =>
  Object.keys(
    (forms(h).at(-1)?.params as { requestedSchema: { properties: object } } | undefined)
      ?.requestedSchema.properties ?? {},
  );

describe("resume after a usage limit", () => {
  it("asks for raw rate-limit events from the Claude adapter and doesn't forward them", async () => {
    const h = await harness(dir, { claude: true });
    const newSession = h.toAgent.find((m) => m.method === "session/new");
    expect(newSession?.params).toMatchObject({
      _meta: { claudeCode: { emitRawSDKMessages: [{ type: "rate_limit_event" }] } },
    });
    h.agent(rateEvent(RESET));
    await settle();
    expect(h.toClient.some((m) => m.method === "_claude/sdkMessage")).toBe(false);
    h.addon.stop();
  });

  it("shows the limit as the agent's reply in Zed, without an error, and offers the resume form with the default prompt", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    // Shown as the agent's reply, and the turn ends without an error: Zed reloads a thread that
    // shows an error whenever a menu pick saves a setting.
    expect(h.toClient.find((m) => m.id === 2)).toMatchObject({
      result: { stopReason: "end_turn" },
    });
    expect(h.toClient.find((m) => m.id === 2)?.error).toBeUndefined();
    expect(
      h.toClient.some(
        (m) =>
          m.method === "session/update" &&
          JSON.stringify(m.params).includes('"agent_message_chunk"') &&
          JSON.stringify(m.params).includes("You've hit your session limit · resets 5pm"),
      ),
    ).toBe(true);
    const [form] = forms(h);
    expect(form?.params).toMatchObject({
      sessionId: "s-1",
      mode: "form",
      message:
        "Claude hit its usage limit. It resets at 17:00 today. Resume this thread when it resets?",
      requestedSchema: {
        properties: {
          prompt: {
            default:
              "Resume the work from where you were interrupted. Agent Rewake sent this message after a usage limit reset, and nobody is here to answer questions or confirm anything until the work is done, so don't ask and don't wait: make the decisions yourself and keep going. Review the current state (latest git pull) and continue from the last completed step. Fully finish the task, including any remaining implementation, testing, fixes and verification. When something is unclear, re-read the task and the code first; otherwise choose the option that changes the least and can be undone, or skip that one item and carry on with the rest. Never invent facts or results, and don't take irreversible or outward-facing actions (deleting data, force-pushing, spending money, publishing) that weren't already asked for. Don't stop to announce your next step or to offer to continue; keep working until everything is complete and there are no known remaining issues. At the end, list the decisions you made on your own and any open questions.",
          },
        },
      },
    });
    h.addon.stop();
  });

  it("schedules the edited prompt for the reset + 1 minute when the user accepts", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    const [form] = forms(h);
    h.client({
      id: form?.id,
      result: { action: "accept", content: { prompt: "Finish the migration" } },
    });
    await settle();
    const [s] = h.store.list();
    expect(s).toMatchObject({
      kind: "limit_resume",
      text: "Finish the migration",
      dueAt: RESET + 60_000,
      createdBy: "form",
    });
    expect(h.texts().at(-1)).toBe(
      "Rewake: This thread will resume when the limit resets (17:00 today). To change or cancel it, use the Rewake menu under the message box.",
    );
    h.addon.stop();
  });

  it("does nothing when the user declines", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    const [form] = forms(h);
    h.client({ id: form?.id, result: { action: "decline" } });
    await settle();
    expect(h.store.list()).toEqual([]);
    expect(h.texts().at(-1)).toMatch(/^Rewake: Not scheduled\./);
    h.addon.stop();
  });

  it("asks before an automatic resume follows a reset more than a day away", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    h.client({
      id: forms(h)[0]?.id,
      result: { action: "accept", content: { prompt: "Resume please" } },
    });
    await settle();
    // Automatic resume is turned on from the menu.
    new ThreadStore(dir).update("s-1", "/project", { autoResume: true }, T0);
    for (const x of h.store.list()) h.store.remove(x.scheduleId);
    await hitLimit(h, 3); // scheduled automatically
    h.advance(3 * HOUR + 60_000);
    h.addon.tick();
    await settle();
    const sent = h.toAgent.filter((m) => m.method === "session/prompt").at(-1);
    const WEEK = RESET + 7 * 24 * HOUR;
    h.agent(rateEvent(WEEK));
    h.agent({ id: sent?.id, error: limitErr });
    await settle();
    expect(h.store.list()[0]?.status).toBe("needs_attention");
    const ask = forms(h).at(-1);
    expect((ask?.params as { message: string } | undefined)?.message).toMatch(
      /^Rewake: Claude is still at its usage limit, now until .*Resume this thread then\?$/,
    );
    h.client({ id: ask?.id, result: { action: "accept", content: {} } });
    await settle();
    expect(h.store.list()[0]).toMatchObject({
      status: "scheduled",
      kind: "limit_resume",
      dueAt: WEEK + 60_000,
    });
    h.addon.stop();
  });

  it("once auto-resume is on, schedules later limits automatically, labelled for Claude", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    const [form] = forms(h);
    h.client({
      id: form?.id,
      result: { action: "accept", content: { prompt: "Resume please" } },
    });
    await settle();
    // Automatic resume is turned on from the menu.
    new ThreadStore(dir).update("s-1", "/project", { autoResume: true }, T0);
    for (const x of h.store.list()) h.store.remove(x.scheduleId);

    await hitLimit(h, 3); // the next limit: no form, scheduled automatically
    expect(forms(h)).toHaveLength(1);
    const [auto] = h.store.list();
    expect(auto).toMatchObject({
      kind: "auto_limit_resume",
      text: "Resume please",
      dueAt: RESET + 60_000,
    });
    expect(h.texts().at(-1)).toMatch(
      /^Rewake: This thread will resume when the limit resets \(17:00 today\), automatically for this thread\./,
    );

    h.advance(3 * HOUR + 60_000);
    h.addon.tick();
    await settle();
    const sent = h.toAgent.filter((m) => m.method === "session/prompt").at(-1);
    expect(sent?.params).toMatchObject({
      prompt: [
        {
          type: "text",
          text: "[Sent automatically by Agent Rewake after the usage limit reset] Resume please",
        },
      ],
    });
    h.addon.stop();
  });

  it("resumes automatically when the thread bypasses permissions, unless Settings turns that off", async () => {
    const bypass = {
      claude: true,
      configOptions: [
        { id: "mode", category: "mode", type: "select", currentValue: "bypassPermissions" },
      ],
    };
    // The default: allowed.
    const h = await harness(dir, bypass);
    h.prompt(2, "/schedule auto on");
    await settle();
    await hitLimit(h, 3);
    expect(h.store.list()[0]).toMatchObject({ kind: "auto_limit_resume" });
    expect(forms(h)).toHaveLength(0);
    h.addon.stop();

    // Turned off in Settings: ask at the limit instead.
    const other = mkdtempSync(join(tmpdir(), "rewake-bypass-"));
    saveSettings(other, { ...loadSettings(other), autoWhenPromptsSkipped: false });
    const g = await harness(other, bypass);
    g.prompt(2, "/schedule auto on");
    await settle();
    await hitLimit(g, 3);
    expect(g.store.list()).toEqual([]);
    expect(forms(g)).toHaveLength(1);
    expect(g.texts()).toContain(
      "Rewake: Not resuming automatically this time: this thread bypasses permissions, and your setting excludes those threads.",
    );
    g.addon.stop();
  });

  it("respects Claude's own autoContinueAtUsageLimit: false", async () => {
    const config = join(dir, "claude-config");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({ autoContinueAtUsageLimit: false }),
    );
    const h = await harness(dir, { claude: true });
    h.prompt(2, "/schedule auto on");
    await settle();
    await hitLimit(h, 3);
    expect(h.store.list()).toEqual([]);
    expect(h.texts().some((t) => t.includes("Continue automatically at usage limit"))).toBe(true);
    h.addon.stop();
  });

  it("follows each new reset time while Claude stays limited, and asks only when there's none", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    const [form] = forms(h);
    h.client({
      id: form?.id,
      result: { action: "accept", content: { prompt: "Resume" } },
    });
    await settle();

    h.advance(3 * HOUR + 60_000);
    h.addon.tick();
    await settle();
    let sent = h.toAgent.filter((m) => m.method === "session/prompt").at(-1);
    h.agent(rateEvent(RESET + 5 * HOUR));
    h.agent({ id: sent?.id, error: limitErr });
    await settle();
    expect(h.store.list()[0]).toMatchObject({
      status: "scheduled",
      dueAt: RESET + 5 * HOUR + 60_000,
    });
    expect(h.texts().at(-1)).toMatch(/^Rewake: Paused again\./);

    // Still limited at 22:01, now until next week: Rewake follows the weekly reset.
    const WEEK = RESET + 7 * 24 * HOUR;
    h.advance(5 * HOUR);
    h.addon.tick();
    await settle();
    sent = h.toAgent.filter((m) => m.method === "session/prompt").at(-1);
    h.agent(rateEvent(WEEK));
    h.agent({ id: sent?.id, error: limitErr });
    await settle();
    expect(h.store.list()[0]).toMatchObject({ status: "scheduled", dueAt: WEEK + 60_000 });
    expect(h.texts().at(-1)).toMatch(/will try again when it resets\.$/);

    // Limited again with no reset time at all: stop and ask instead of guessing.
    h.advance(WEEK + 60_000 - (T0 + 8 * HOUR + 60_000));
    h.addon.tick();
    await settle();
    sent = h.toAgent.filter((m) => m.method === "session/prompt").at(-1);
    h.agent({
      id: sent?.id,
      error: { ...limitErr, message: "Internal error: You've hit your session limit" },
    });
    await settle();
    expect(h.store.list()[0]?.status).toBe("needs_attention");
    // The user is asked with buttons instead of being told to type a command.
    const ask = forms(h).at(-1);
    expect((ask?.params as { message: string } | undefined)?.message).toMatch(
      /^Rewake: Stopped\. .*didn't give a new reset time.*Try again now\?$/,
    );
    h.client({ id: ask?.id, result: { action: "accept", content: { what: "now" } } });
    await settle();
    expect(h.store.list()[0]?.status).toBe("sending");
    h.addon.stop();
  });

  it("shows a message once when it's sent again after a usage limit", async () => {
    const h = await harness(dir, { claude: true });
    h.prompt(2, "/schedule in 1h Run the tests");
    await settle();
    const echoes = () =>
      h.toClient.filter(
        (m) =>
          (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } })?.update
            ?.sessionUpdate === "user_message_chunk",
      ).length;

    h.advance(HOUR);
    h.addon.tick();
    await settle();
    expect(echoes()).toBe(1);
    const first = h.toAgent.filter((m) => m.method === "session/prompt").at(-1);
    h.agent(rateEvent(T0 + 3 * HOUR));
    h.agent({ id: first?.id, error: limitErr });
    await settle();
    expect(h.store.list()[0]).toMatchObject({ status: "scheduled", attempts: [{ n: 1 }] });

    h.advance(2 * HOUR + 60_000); // after the reset
    h.addon.tick();
    await settle();
    expect(h.toAgent.filter((m) => m.method === "session/prompt").length).toBe(2);
    expect(echoes()).toBe(1); // not shown a second time
    expect(h.texts()).toContain(
      'Rewake: Sending your scheduled message again (shown above). To stop the reply, pick "Stop the scheduled reply" in the Rewake menu, or type /stop.',
    );
    h.addon.stop();
  });

  it("cancels a pending resume when the user continues by hand after the reset", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    const [form] = forms(h);
    h.client({
      id: form?.id,
      result: { action: "accept", content: { prompt: "Resume" } },
    });
    await settle();
    h.advance(3 * HOUR + 10_000); // after the reset, before the resume's 1-minute margin
    h.prompt(5, "I'm back, continue");
    await settle();
    h.agent({ id: 5, result: { stopReason: "end_turn" } });
    await settle();
    expect(h.store.list()[0]?.status).toBe("cancelled");
    expect(h.texts().at(-1)).toMatch(/^Rewake: Cancelled the scheduled resume/);
    h.addon.stop();
  });

  it("asks before resending a message left 'Sending' when Zed closed during its reply", async () => {
    const h = await harness(dir, { claude: true });
    const s0 = h.store.create({
      sessionId: "s-1",
      cwd: "/proj",
      text: "Run the tests",
      dueAt: T0 - 60_000,
      createdBy: "form",
      now: T0 - 120_000,
    });
    h.store.update(s0.scheduleId, (x) => ({ ...x, status: "sending" }), T0 - 60_000);
    h.addon.tick();
    await settle();
    expect(h.store.get(s0.scheduleId)).toMatchObject({
      status: "needs_attention",
      failureReason: "interrupted",
    });
    expect(h.toAgent.filter((m) => m.method === "session/prompt")).toEqual([]);
    expect((forms(h).at(-1)?.params as { message: string } | undefined)?.message).toBe(
      'Rewake: The message scheduled for 13:59 today was interrupted, because Zed closed during its reply: "Run the tests". Send it again?',
    );
    h.addon.stop();
  });

  it("explains once per thread how Rewake works, after the first resume is scheduled", async () => {
    const h = await harness(dir, { claude: true, firstUseNote: true });
    await hitLimit(h, 2);
    h.client({ id: forms(h)[0]?.id, result: { action: "accept", content: { prompt: "Resume" } } });
    await settle();
    const note = h.texts().at(-1) ?? "";
    expect(note).toMatch(/^How Rewake works:\n/);
    expect(note).toContain("- Zed must be running with this project open.");
    expect(note).toContain("- Ask Claude. It knows Rewake");
    h.prompt(3, "/schedule in 1h Check the build");
    await settle();
    expect(h.texts().filter((t) => t.startsWith("How Rewake works:"))).toHaveLength(1);
    h.addon.stop();
  });

  it("falls back to a text offer when the client has no forms", async () => {
    const h = await harness(dir, { claude: true, forms: false });
    await hitLimit(h, 2);
    expect(forms(h)).toEqual([]);
    expect(h.texts().at(-1)).toMatch(/Type \/schedule resume to schedule it\.$/);
    h.prompt(3, "/schedule resume");
    await settle();
    expect(h.store.list()[0]).toMatchObject({ kind: "limit_resume", dueAt: RESET + 60_000 });
    h.addon.stop();
  });

  it("asks when to resume if Claude didn't say when the limit resets", async () => {
    const h = await harness(dir, { claude: true });
    h.prompt(2, "keep going");
    await settle();
    h.agent({
      id: 2,
      error: { ...limitErr, message: "Internal error: You've hit your session limit" },
    });
    await settle();
    const [form] = forms(h);
    expect(form?.params).toMatchObject({ requestedSchema: { required: ["prompt", "when"] } });
    // Presets, each with its time, instead of a free-text field.
    type WhenSchema = {
      requestedSchema: { properties: { when: { oneOf: Array<{ title: string }> } } };
    };
    const when = (form?.params as WhenSchema | undefined)?.requestedSchema.properties.when;
    expect(when?.oneOf.map((o) => o.title)).toEqual([
      "In 30 minutes (14:30 today)",
      "In 1 hour (15:00 today)",
      "In 3 hours (17:00 today)",
      "In 5 hours (19:00 today)",
      "Custom time…",
    ]);
    h.client({
      id: form?.id,
      result: { action: "accept", content: { prompt: "Resume", when: String(3 * HOUR) } },
    });
    await settle();
    expect(h.store.list()[0]?.dueAt).toBe(T0 + 3 * HOUR);
    h.addon.stop();
  });

  it("lets you pick any time when the agent didn't say, as a next step", async () => {
    const h = await harness(dir, { agentName: "gemini-cli", agentTitle: "Gemini CLI" });
    h.prompt(2, "keep going");
    await settle();
    h.agent({ id: 2, error: { code: 429, message: "Rate limit exceeded. Try again later." } });
    await settle();
    await answer(h, { prompt: "Resume", when: "custom" });
    expect(formKeys(h)).toEqual(["cron"]);
    await answer(h, { cron: "15 16 * * *" });
    await answer(h, { how: "once" });
    expect(h.store.list()[0]?.dueAt).toBe(T0 + 2 * HOUR + 15 * 60_000);
    h.addon.stop();
  });

  it("says the question was closed, not declined, when Zed closes the form itself", async () => {
    const h = await harness(dir, { agentName: "gemini-cli", agentTitle: "Gemini CLI" });
    h.prompt(2, "keep going");
    await settle();
    h.agent({ id: 2, error: { code: 429, message: "Rate limit exceeded. Try again later." } });
    await settle();
    h.client({ id: forms(h).at(-1)?.id, result: { action: "cancel" } });
    await settle();
    expect(h.texts().at(-1)).toBe(
      'Rewake: The resume question was closed before you answered. To resume when the limit resets, pick "Resume after the usage limit…" in the Rewake menu.',
    );
    h.addon.stop();
  });

  it("says one short line when you decline the resume", async () => {
    const h = await harness(dir, { agentName: "gemini-cli", agentTitle: "Gemini CLI" });
    h.prompt(2, "keep going");
    await settle();
    h.agent({ id: 2, error: { code: 429, message: "Rate limit exceeded. Try again later." } });
    await settle();
    await answer(h, "decline");
    expect(h.texts().at(-1)).toBe(
      'Rewake: Not scheduled. To resume later, pick "Resume after the usage limit…" in the Rewake menu.',
    );
    h.addon.stop();
  });
});

// ---- re-attach a lost session (zed#55501) -------------------------------------------

describe("re-attach", () => {
  const lost = { code: -32603, message: "Internal error", data: { details: "Session not found" } };

  async function claudeWithResume(resume = true) {
    const h = await harness(dir, { claude: true });
    // Re-answer initialize with session capabilities (the harness's first answer had none).
    h.client({
      id: 90,
      method: "initialize",
      params: { protocolVersion: 1, clientInfo: { name: "zed" } },
    });
    await settle();
    h.agent({
      id: 90,
      result: {
        agentInfo: { name: "@agentclientprotocol/claude-agent-acp" },
        agentCapabilities: { loadSession: true, sessionCapabilities: resume ? { resume: {} } : {} },
      },
    });
    await settle();
    return h;
  }

  it("resumes the session and retries the message, so Zed never sees 'Session not found'", async () => {
    const h = await claudeWithResume();
    h.prompt(2, "carry on");
    await settle();
    h.agent({ id: 2, error: lost });
    await settle();
    expect(h.toClient.some((m) => m.id === 2)).toBe(false);
    const resume = h.toAgent.find((m) => m.method === "session/resume");
    expect(resume?.params).toMatchObject({ sessionId: "s-1", cwd: "/project", mcpServers: [] });
    h.agent({ id: resume?.id, result: {} });
    await settle();
    const retried = h.toAgent.filter((m) => m.method === "session/prompt" && m.id === 2);
    expect(retried).toHaveLength(2);
    h.agent({ id: 2, result: { stopReason: "end_turn" } });
    await settle();
    expect(h.toClient.find((m) => m.id === 2)?.result).toEqual({ stopReason: "end_turn" });
    h.addon.stop();
  });

  it("returns the original error if the session can't be reopened", async () => {
    const h = await claudeWithResume();
    h.prompt(2, "carry on");
    await settle();
    h.agent({ id: 2, error: lost });
    await settle();
    const resume = h.toAgent.find((m) => m.method === "session/resume");
    h.agent({ id: resume?.id, error: { code: -32002, message: "Resource not found" } });
    await settle();
    expect(h.toClient.find((m) => m.id === 2)?.error).toEqual(lost);
    h.addon.stop();
  });

  it("falls back to session/load and hides the replayed history", async () => {
    const h = await claudeWithResume(false);
    h.prompt(2, "carry on");
    await settle();
    h.agent({ id: 2, error: lost });
    await settle();
    const load = h.toAgent.find((m) => m.method === "session/load");
    expect(load).toBeDefined();
    const before = h.toClient.length;
    h.agent({
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" } },
      },
    });
    await settle();
    expect(h.toClient.length).toBe(before); // replay dropped
    h.agent({ id: load?.id, result: {} });
    await settle();
    expect(h.toAgent.filter((m) => m.method === "session/prompt" && m.id === 2)).toHaveLength(2);
    h.addon.stop();
  });
});

describe("the Rewake menu in the thread toolbar", () => {
  const MODEL = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "opus",
    options: [{ value: "opus", name: "Opus" }],
  };
  type Option = {
    id: string;
    currentValue: string;
    options: Array<{ value: string; name: string }>;
  };
  const menuOf = (configOptions: unknown) =>
    (configOptions as Option[]).find((o) => o.id === "rewake") as Option;
  const latestOptions = (h: Awaited<ReturnType<typeof harness>>) => {
    const update = h.toClient
      .filter(
        (m) =>
          (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          "config_option_update",
      )
      .at(-1);
    return (update?.params as { update: { configOptions: unknown } } | undefined)?.update
      .configOptions;
  };
  const pick = (h: Awaited<ReturnType<typeof harness>>, id: number, menu: Option, action: string) =>
    h.client({
      id,
      method: "session/set_config_option",
      params: {
        sessionId: "s-1",
        configId: "rewake",
        value: menu.options.find((o) => o.value.endsWith(`.${action}`))?.value,
      },
    });

  it("offers keeping the computer awake in Settings only where Rewake can do it", async () => {
    for (const supported of [true, false]) {
      const wake: Wake = { supported, set: () => false, release: () => {} };
      const h = await harness(dir, { claude: true, wake, configOptions: [MODEL] });
      const opened = h.toClient.find((m) => m.id === 1)?.result as { configOptions: unknown };
      pick(h, 7, menuOf(opened.configOptions), "settings");
      await settle();
      expect(formKeys(h).includes("keepAwake")).toBe(supported);
      if (supported) {
        await answer(h, { autoResume: "ask", clock: "24h", keepAwake: "always" });
        expect(loadSettings(dir).keepAwake).toBe("always");
        expect(h.texts().at(-1)).toContain(
          "Rewake keeps this computer awake for resumes and scheduled messages, also on battery.",
        );
      }
      h.addon.stop();
    }
  });

  it("says a resume is already scheduled, adds messages after it, and sends each when the reply before it finishes", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    h.client({ id: forms(h)[0]?.id, result: { action: "accept", content: { prompt: "Resume" } } });
    await settle();
    for (const [id, text] of [
      [7, "Then run the tests"],
      [8, "Then write the changelog"],
    ] as const) {
      const menu = menuOf(latestOptions(h));
      expect(menu.options.map((o) => o.name)).toContain("Add a message after the resume…");
      pick(h, id, menu, "resume");
      await settle();
      const ask = forms(h).at(-1);
      expect((ask?.params as { message: string } | undefined)?.message).toMatch(
        /^A resume is already scheduled for 17:01 today: "Resume"(, followed by 1 more message)?\. Add a message to send after (it|them)\? Each is sent when the reply before it finishes\.$/,
      );
      h.client({ id: ask?.id, result: { action: "accept", content: { message: text } } });
      await settle();
    }
    expect(h.store.list()).toHaveLength(1);
    expect(h.store.list()[0]?.followUps).toEqual([
      "Then run the tests",
      "Then write the changelog",
    ]);
    expect(h.texts().at(-1)).toBe(
      "Rewake: Added. After the resume, Rewake sends 2 more messages, one at a time, each when the previous reply finishes.",
    );

    const prompts = () => h.toAgent.filter((m) => m.method === "session/prompt");
    const sentText = () =>
      (prompts().at(-1)?.params as { prompt: Array<{ text: string }> } | undefined)?.prompt[0]
        ?.text;
    h.advance(3 * HOUR + 60_000);
    h.addon.tick();
    await settle();
    expect(sentText()).toBe("Resume");
    const before = prompts().length;
    h.addon.tick(); // nothing more goes while the reply is running
    await settle();
    expect(prompts()).toHaveLength(before);
    h.agent({ id: prompts().at(-1)?.id, result: { stopReason: "end_turn" } });
    await settle();
    expect(sentText()).toBe("Then run the tests");
    h.agent({ id: prompts().at(-1)?.id, result: { stopReason: "end_turn" } });
    await settle();
    expect(sentText()).toBe("Then write the changelog");
    h.agent({ id: prompts().at(-1)?.id, result: { stopReason: "end_turn" } });
    await settle();
    expect(h.store.list().map((x) => x.status)).toEqual(["sent", "sent", "sent"]);
    h.addon.stop();
  });

  it("keeps the messages after a resume, paused, when its reply is stopped", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    h.client({ id: forms(h)[0]?.id, result: { action: "accept", content: { prompt: "Resume" } } });
    await settle();
    for (const [id, text] of [
      [7, "Run the tests"],
      [8, "Write the changelog"],
    ] as const) {
      pick(h, id, menuOf(latestOptions(h)), "resume");
      await settle();
      h.client({
        id: forms(h).at(-1)?.id,
        result: { action: "accept", content: { message: text } },
      });
      await settle();
    }
    expect(h.texts().at(-1)).toMatch(/^Rewake: Added\./);
    h.advance(3 * HOUR + 60_000);
    h.addon.tick();
    await settle();
    const sent = h.toAgent.filter((m) => m.method === "session/prompt").at(-1);
    h.agent({ id: sent?.id, result: { stopReason: "cancelled" } });
    await settle();
    const kept = h.store.list().find((x) => x.status === "paused");
    expect(kept).toMatchObject({ text: "Run the tests", followUps: ["Write the changelog"] });
    expect(h.texts().at(-1)).toBe(
      'Rewake: Stopped the scheduled reply. The 2 messages after it are paused. To send them, pick "Change a scheduled message…" in the Rewake menu and resume the paused entry.',
    );
    h.addon.stop();
  });

  describe("asking about automatic resume when a new thread opens", () => {
    const ThreadStoreFor = () => new ThreadStore(dir);
    /** A second thread, opened the way Zed does. */
    const openAnother = async (h: Awaited<ReturnType<typeof harness>>, id: number, sid: string) => {
      h.client({ id, method: "session/new", params: { cwd: "/project", mcpServers: [] } });
      await settle();
      h.agent({ id, result: { sessionId: sid } });
      await settle();
    };

    it("asks in a new Claude thread, after Zed knows the thread, and 'every new thread' sticks", async () => {
      const h = await harness(dir, { claude: true, askOnNewThreads: true });
      const order = h.toClient.map((m) => (m.id === 1 ? "response" : m.method));
      expect(order.indexOf("elicitation/create")).toBeGreaterThan(order.indexOf("response"));
      expect(formMessage(h)).toMatch(
        /^Resume this thread automatically if Claude hits its usage limit\?/,
      );
      // One decision: the message is changed elsewhere.
      expect(formKeys(h)).toEqual(["choice"]);
      await answer(h, { choice: "all" });
      expect(h.texts().at(-1)).toBe(
        "Rewake: Automatic resume is on for this thread and every new one. Change it in Rewake menu → Settings….",
      );
      expect(ThreadStoreFor().get("s-1")).toMatchObject({ autoResume: true });
      expect(loadSettings(dir)).toMatchObject({ newThreads: "on" });

      const before = forms(h).length;
      await openAnother(h, 9, "s-2");
      expect(forms(h)).toHaveLength(before); // not asked again
      expect(ThreadStoreFor().get("s-2")).toMatchObject({ autoResume: true });
      h.addon.stop();
    });

    it("'this thread only' leaves new threads asking; 'don't ask again' stops asking", async () => {
      const h = await harness(dir, { claude: true, askOnNewThreads: true });
      await answer(h, { choice: "this" });
      expect(ThreadStoreFor().get("s-1")?.autoResume).toBe(true);
      expect(loadSettings(dir).newThreads).toBe("ask");

      await openAnother(h, 9, "s-2");
      expect(forms(h)).toHaveLength(2);
      await answer(h, { choice: "never" });
      expect(ThreadStoreFor().get("s-2")?.autoResume).not.toBe(true);
      expect(loadSettings(dir).newThreads).toBe("off");

      await openAnother(h, 10, "s-3");
      expect(forms(h)).toHaveLength(2);
      h.addon.stop();
    });

    it("Decline changes nothing, and an unanswered question doesn't block Rewake's other forms", async () => {
      const h = await harness(dir, { claude: true, askOnNewThreads: true, configOptions: [MODEL] });
      expect(forms(h)).toHaveLength(1);
      const opened = h.toClient.find((m) => m.id === 1)?.result as { configOptions: unknown };
      pick(h, 7, menuOf(opened.configOptions), "settings"); // the question is still open
      await settle();
      expect(forms(h)).toHaveLength(2);
      expect(formKeys(h)).toEqual(["autoResume", "clock", "keepAwake"]);
      h.client({ id: forms(h)[0]?.id, result: { action: "decline" } });
      await settle();
      expect(ThreadStoreFor().get("s-1")?.autoResume).not.toBe(true);
      expect(loadSettings(dir).newThreads).toBe("ask");
      h.addon.stop();
    });

    it("asks in a thread that bypasses permission prompts, unless Settings turned those off", async () => {
      const bypass = {
        claude: true,
        askOnNewThreads: true,
        configOptions: [
          { id: "mode", category: "mode", type: "select", currentValue: "bypassPermissions" },
        ],
      };
      const h = await harness(dir, bypass);
      expect(formMessage(h)).toMatch(/^Resume this thread automatically if Claude hits/);
      h.addon.stop();

      // Off in Settings: automatic resume couldn't run there, so it isn't offered.
      const other = mkdtempSync(join(tmpdir(), "rewake-bypass-"));
      saveSettings(other, { ...loadSettings(other), autoWhenPromptsSkipped: false });
      const g = await harness(other, bypass);
      expect(forms(g)).toEqual([]);
      g.addon.stop();
    });

    it("asks with any agent, by its name, but not in reopened threads", async () => {
      const gemini = await harness(dir, {
        agentName: "gemini-cli",
        agentTitle: "Gemini CLI",
        askOnNewThreads: true,
      });
      expect(formMessage(gemini)).toMatch(
        /^Resume this thread automatically if Gemini CLI hits its usage limit\?/,
      );
      gemini.addon.stop();

      const h = await harness(dir, { claude: true, askOnNewThreads: true });
      await answer(h, { choice: "this" });
      const before = forms(h).length;
      h.client({
        id: 9,
        method: "session/load",
        params: { sessionId: "s-9", cwd: "/project", mcpServers: [] },
      });
      await settle();
      h.agent({ id: 9, result: {} });
      await settle();
      expect(forms(h)).toHaveLength(before);
      h.addon.stop();
    });
  });

  it("is added next to the agent's own options, or on its own when the agent has none", async () => {
    const h = await harness(dir, { claude: true, configOptions: [MODEL] });
    const response = h.toClient.find((m) => m.id === 1)?.result as { configOptions: Option[] };
    expect(response.configOptions.map((o) => o.id)).toEqual(["model", "rewake"]);
    const menu = menuOf(response.configOptions);
    expect(menu.options.find((o) => o.value === menu.currentValue)?.name).toBe("Rewake");
    expect(menu.options.map((o) => o.name)).toContain("Schedule a message…");
    h.addon.stop();

    // No options of its own (and no legacy modes): the Rewake menu alone.
    const other = await harness(mkdtempSync(join(tmpdir(), "rewake-addon-")), { claude: true });
    const alone =
      (other.toClient.find((m) => m.id === 1)?.result as { configOptions?: Option[] } | undefined)
        ?.configOptions ?? [];
    expect(alone.map((o) => o.id)).toEqual(["rewake"]);
    other.addon.stop();
  });

  it("schedules a message with a form: no command to remember", async () => {
    const h = await harness(dir, { claude: true, configOptions: [MODEL] });
    const menu = menuOf(
      (h.toClient.find((m) => m.id === 1)?.result as { configOptions: unknown } | undefined)
        ?.configOptions,
    );
    pick(h, 7, menu, "new");
    await settle();
    // The menu answers at once and snaps back to its label; nothing reaches the agent.
    const snapped = h.toClient.find((m) => m.id === 7)?.result as { configOptions: unknown };
    expect(menuOf(snapped.configOptions).currentValue).toBe(menu.currentValue);
    expect(h.toAgent.some((m) => m.method === "session/set_config_option")).toBe(false);

    // Step 1 asks one thing: a message, or resume after the limit.
    expect(formKeys(h)).toEqual(["what"]);
    await answer(h, { what: "message" });
    // Step 2: only the message and when.
    expect(formKeys(h)).toEqual(["message", "time"]);
    const schema = (
      forms(h).at(-1)?.params as
        | { requestedSchema: { properties: Record<string, { oneOf?: Array<{ title: string }> }> } }
        | undefined
    )?.requestedSchema ?? { properties: {} };
    expect(schema.properties.time?.oneOf?.map((o) => o.title)).toEqual([
      "In 30 minutes (14:30 today)",
      "In 1 hour (15:00 today)",
      "In 3 hours (17:00 today)",
      "Tomorrow morning (09:00 tomorrow (Monday))",
      "Custom time…",
    ]);
    await answer(h, { message: "Run the tests", time: "in 1h" });
    await settle();
    expect(h.store.list()[0]).toMatchObject({ text: "Run the tests", dueAt: T0 + HOUR });
    expect(h.texts().at(-1)).toBe(
      "Rewake: Scheduled for 15:00 today. To change it, use the Rewake menu under the message box.",
    );
    const label = menuOf(latestOptions(h));
    expect(label.options.find((o) => o.value === label.currentValue)?.name).toBe("Rewake (1)");
    expect(label.options.map((o) => o.name)).toEqual([
      "Rewake (1)",
      "Schedules",
      "Schedule a message…",
      "Change a scheduled message…",
      "Turn on auto-resume after limits…",
      "Settings…",
    ]);
    h.addon.stop();
  });

  it("keeps the menu label short so Zed's toolbar doesn't wrap", async () => {
    const h = await harness(dir, { claude: true, configOptions: [MODEL] });
    for (let i = 0; i < 12; i++) h.prompt(2 + i, `/schedule in ${i + 1}h Message ${i}`);
    await settle();
    const menu = menuOf(latestOptions(h));
    const label = menu.options.find((o) => o.value === menu.currentValue)?.name ?? "";
    expect(label).toBe("Rewake (12)");
    expect(label.length).toBeLessThanOrEqual(12);
    h.addon.stop();
  });

  it("ignores a pick Zed saved as the default and replays when a thread opens", async () => {
    const h = await harness(dir, { claude: true, configOptions: [MODEL] });
    h.client({
      id: 7,
      method: "session/set_config_option",
      params: { sessionId: "s-1", configId: "rewake", value: "0ldn0nce.new" },
    });
    await settle();
    expect(h.toClient.find((m) => m.id === 7)?.result).toBeDefined();
    expect(forms(h)).toEqual([]);
    h.addon.stop();
  });

  it("adds itself to the agent's own option updates", async () => {
    const h = await harness(dir, { claude: true, configOptions: [MODEL] });
    h.agent({
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [{ ...MODEL, currentValue: "sonnet" }],
        },
      },
    });
    await settle();
    expect(
      (latestOptions(h) as Option[]).map((o) => [
        o.id,
        o.currentValue.split(".")[1] ?? o.currentValue,
      ]),
    ).toEqual([
      ["model", "sonnet"],
      ["rewake", "home"],
    ]);
    h.addon.stop();
  });

  it("shows times in 12-hour format by default, and Settings switches to 24-hour", async () => {
    DEFAULT_SETTINGS.clock = "12h"; // the product default (test/setup.ts pins 24h for older tests)
    const h = await harness(dir, { claude: true, configOptions: [MODEL] });
    h.prompt(2, "/schedule in 1h Run the tests");
    await settle();
    expect(h.texts().at(-1)).toContain("Scheduled for 3:00 PM today.");

    pick(h, 7, menuOf(latestOptions(h)), "settings");
    await settle();
    expect(formKeys(h)).toEqual(["autoResume", "clock", "keepAwake"]);
    const clock = (
      forms(h).at(-1)?.params as {
        requestedSchema: {
          properties: { clock: { default: string; oneOf: Array<{ title: string }> } };
        };
      }
    )?.requestedSchema.properties.clock;
    expect(clock?.default).toBe("12h");
    expect(clock?.oneOf.map((o) => o.title)).toEqual(["12-hour (3:19 PM)", "24-hour (15:19)"]);
    await answer(h, { autoResume: "ask", clock: "24h" });
    expect(h.texts().at(-1)).toBe("Rewake: Saved. Times now show like 15:19.");
    expect(loadSettings(dir).clock).toBe("24h");

    // One question for automatic resume: each answer sets who it applies to.
    const auto = (
      forms(h).at(-1)?.params as
        | { requestedSchema: { properties: { autoResume: { oneOf: Array<{ title: string }> } } } }
        | undefined
    )?.requestedSchema.properties.autoResume;
    expect(auto?.oneOf.map((o) => o.title)).toEqual([
      "On, even when permissions are bypassed",
      "On, except when permissions are bypassed",
      "Ask when a new thread opens",
      "Off",
    ]);
    pick(h, 9, menuOf(latestOptions(h)), "settings");
    await settle();
    await answer(h, { autoResume: "exceptBypass", clock: "24h" });
    expect(loadSettings(dir)).toMatchObject({ newThreads: "on", autoWhenPromptsSkipped: false });
    expect(h.texts().at(-1)).toBe(
      "Rewake: Saved. New threads, and threads Rewake sees for the first time, resume automatically after usage limits, except threads that bypass permissions.",
    );

    pick(h, 8, menuOf(latestOptions(h)), "open");
    await settle();
    expect(h.texts().at(-1)).toContain("| 1 | 15:00 today | Run the tests | Scheduled |");
    h.addon.stop();
  });

  it("Schedules shows only the table: no form", async () => {
    const h = await harness(dir, { claude: true, configOptions: [MODEL] });
    h.prompt(2, "/schedule in 1h Run the tests");
    await settle();
    pick(h, 7, menuOf(latestOptions(h)), "open");
    await settle();
    const card = h.texts().at(-1) ?? "";
    expect(card).toContain("| 1 | 15:00 today | Run the tests | Scheduled |");
    expect(card).toContain("To change one: Rewake menu → Change a scheduled message…");
    expect(forms(h)).toEqual([]);
    h.addon.stop();
  });

  it("changes a message one step at a time: which one, what to do, then the details", async () => {
    const h = await harness(dir, { claude: true, configOptions: [MODEL] });
    h.prompt(2, "/schedule in 1h Run the tests");
    h.prompt(3, "/schedule in 2h Check CI");
    await settle();
    pick(h, 7, menuOf(latestOptions(h)), "change");
    await settle();
    expect(formMessage(h)).toBe("Which message do you want to change?");
    expect(formKeys(h)).toEqual(["item"]);
    const second = h.store.list()[1]?.scheduleId;
    await answer(h, { item: second });
    expect(formMessage(h)).toBe('"Check CI" · 16:00 today. What do you want to do?');
    expect(formKeys(h)).toEqual(["action"]);
    await answer(h, { action: "move" });
    await answer(h, { time: "custom" });
    await answer(h, { cron: "30 18 * * *" });
    await answer(h, { how: "once" });
    expect(h.store.get(second ?? "")?.dueAt).toBe(T0 + 4.5 * HOUR);
    expect(h.texts().at(-1)).toBe("Rewake: Moved. It will be sent at 18:30 today.");
    h.addon.stop();
  });

  it("skips choosing when there's one message, and asks before deleting", async () => {
    const h = await harness(dir, { claude: true, configOptions: [MODEL] });
    h.prompt(2, "/schedule in 1h Run the tests");
    await settle();
    pick(h, 7, menuOf(latestOptions(h)), "change");
    await settle();
    expect(formKeys(h)).toEqual(["action"]); // straight to "what to do"
    await answer(h, { action: "delete" });
    expect(formMessage(h)).toMatch(/^Delete the message scheduled for 15:00 today/);
    await answer(h, "decline");
    expect(h.store.list()).toHaveLength(1);
    h.addon.stop();
  });

  it("opens the form for a bare /schedule, and asks before sending a missed message", async () => {
    const h = await harness(dir, { claude: true });
    h.prompt(2, "/schedule");
    await settle();
    expect(h.toClient.find((m) => m.id === 2)?.result).toEqual({ stopReason: "end_turn" });
    await answer(h, { what: "message" });
    await answer(h, { message: "Check the build", time: "in 30m" });
    expect(h.texts().at(-1)).toBe(
      "Rewake: Scheduled for 14:30 today. To change it, use the Rewake menu under the message box.",
    );

    h.advance(3 * HOUR); // Zed was closed
    h.addon.tick();
    await settle();
    expect(h.store.list()[0]?.status).toBe("missed");
    const ask = forms(h).at(-1);
    expect((ask?.params as { message: string } | undefined)?.message).toMatch(
      /wasn't sent.*Send it now\?$/,
    );
    h.client({ id: ask?.id, result: { action: "accept", content: { what: "now" } } });
    await settle();
    expect(h.toAgent.filter((m) => m.method === "session/prompt").at(-1)?.params).toMatchObject({
      prompt: [{ type: "text", text: "Check the build" }],
    });
    h.addon.stop();
  });
});

describe("deleting a thread in Zed", () => {
  it("removes that thread's scheduled messages and settings", async () => {
    const h = await harness();
    h.prompt(2, "/schedule in 1h Run the tests");
    await settle();
    expect(h.store.list()).toHaveLength(1);
    h.client({ id: 9, method: "session/delete", params: { sessionId: "s-1" } });
    await settle();
    h.agent({ id: 9, result: {} });
    await settle();
    expect(h.toClient.find((m) => m.id === 9)?.result).toEqual({});
    expect(h.store.list()).toEqual([]);
    expect(new ThreadStore(dir).get("s-1")).toBeUndefined();
    h.addon.stop();
  });
});

describe("Schedules… with nothing scheduled", () => {
  it("shows the empty list and no form", async () => {
    const h = await harness(dir, {
      claude: true,
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "a",
          options: [{ value: "a", name: "A" }],
        },
      ],
    });
    const options = (
      h.toClient.find((m) => m.id === 1)?.result as
        | { configOptions: Array<{ id: string; options: Array<{ value: string }> }> }
        | undefined
    )?.configOptions;
    const open = options
      ?.find((o) => o.id === "rewake")
      ?.options.find((o) => o.value.endsWith(".open"))?.value;
    h.client({
      id: 7,
      method: "session/set_config_option",
      params: { sessionId: "s-1", configId: "rewake", value: open },
    });
    await settle();
    expect(h.texts().at(-1)).toContain("Nothing is scheduled in this thread yet.");
    expect(forms(h)).toEqual([]);
    h.addon.stop();
  });
});

describe("scheduling in small steps, with custom cron", () => {
  const start = async (h: Awaited<ReturnType<typeof harness>>) => {
    h.prompt(2, "/schedule");
    await settle();
    await answer(h, { what: "message" });
  };

  it("asks for a cron expression only for a custom time, explains it, then repeats after each run", async () => {
    const h = await harness(dir, { claude: true });
    await start(h);
    await answer(h, { message: "Run the tests", time: "custom" });
    expect(formKeys(h)).toEqual(["cron"]);
    await answer(h, { cron: "0 9 * * 1-5" });
    expect(formMessage(h)).toBe(
      'Rewake understood "0 9 * * 1-5" as: Every weekday (Monday to Friday) at 09:00. Next runs: 09:00 tomorrow (Monday); Tuesday at 09:00; Wednesday at 09:00.',
    );
    expect(formKeys(h)).toEqual(["how"]);
    await answer(h, { how: "repeat" });
    const MON9 = new Date(2026, 9, 5, 9, 0).getTime();
    expect(h.store.list()[0]).toMatchObject({ dueAt: MON9, repeat: { cron: "0 9 * * 1-5" } });
    expect(h.texts().at(-1)).toContain("Repeats: Every weekday (Monday to Friday) at 09:00.");

    // Monday's run is sent; the message moves on to Tuesday.
    h.advance(MON9 - T0);
    h.addon.tick();
    await settle();
    const sent = h.toAgent.filter((m) => m.method === "session/prompt").at(-1);
    h.agent({ id: sent?.id, result: { stopReason: "end_turn" } });
    await settle();
    expect(h.store.list()[0]).toMatchObject({ status: "scheduled", dueAt: MON9 + 24 * HOUR });
    expect(h.texts().at(-1)).toBe("Rewake: Next run: 09:00 tomorrow (Tuesday).");
    h.addon.stop();
  });

  it("uses a cron time just once when asked, and explains a mistake in the same step", async () => {
    const h = await harness(dir, { claude: true });
    await start(h);
    await answer(h, { message: "Ping", time: "custom" });
    await answer(h, { cron: "0 9 * *" });
    expect(formMessage(h)).toMatch(/^Rewake: A cron expression has 5 parts/);
    expect(formKeys(h)).toEqual(["cron"]);
    await answer(h, { cron: "30 18 * * *" });
    await answer(h, { how: "once" });
    expect(h.store.list()[0]).toMatchObject({ dueAt: T0 + 4.5 * HOUR });
    expect(h.store.list()[0]?.repeat).toBeUndefined();
    h.addon.stop();
  });

  it("turns on resume-after-limit in one step, and skips that step once it's on", async () => {
    const h = await harness(dir, { claude: true });
    h.prompt(2, "/schedule");
    await settle();
    await answer(h, { what: "resume" });
    expect(new ThreadStore(dir).get("s-1")?.autoResume).toBe(true);
    expect(h.texts().at(-1)).toMatch(/^Rewake: Done\. Whenever this thread hits a usage limit/);
    expect(h.store.list()).toEqual([]);
    h.prompt(3, "/schedule");
    await settle();
    expect(formKeys(h)).toEqual(["message", "time"]); // straight to the message
    h.addon.stop();
  });

  it("skips runs of a repeat that were missed while Zed was closed", async () => {
    const h = await harness(dir, { claude: true });
    await start(h);
    await answer(h, { message: "Standup notes", time: "custom" });
    await answer(h, { cron: "0 15 * * *" });
    await answer(h, { how: "repeat" });
    expect(h.store.list()[0]?.dueAt).toBe(T0 + HOUR);
    h.advance(3 * 24 * HOUR); // three days later
    h.addon.tick();
    await settle();
    expect(h.toAgent.some((m) => m.method === "session/prompt")).toBe(false);
    expect(h.store.list()[0]).toMatchObject({
      status: "scheduled",
      dueAt: T0 + 3 * 24 * HOUR + HOUR,
    });
    expect(h.texts().at(-1)).toMatch(/^Rewake: Skipped the run due at .* Next run: 15:00 today\.$/);
    h.addon.stop();
  });
});

describe("/schedule every and /schedule cron", () => {
  it("creates repeating messages from a phrase or a cron expression, and says what it understood", async () => {
    const h = await harness();
    h.prompt(2, "/schedule every weekday 9:30 Check the build");
    await settle();
    expect(h.texts().at(-1)).toMatch(
      /^Rewake: Scheduled to repeat\. Rewake understood "30 9 \* \* 1-5" as: Every weekday \(Monday to Friday\) at 09:30\. Next runs: 09:30 tomorrow \(Monday\)/,
    );
    h.prompt(3, '/schedule cron "*/30 * * * *" Status update');
    await settle();
    expect(h.texts().at(-1)).toContain(
      '"*/30 * * * *" as: Every 30 minutes. Next runs: 14:30 today',
    );
    h.prompt(4, "/schedule cron 0 9 * * Ping");
    await settle();
    expect(h.texts().at(-1)).toMatch(/^Rewake: Couldn't do that\./);
    expect(h.store.list().map((s) => s.repeat?.cron)).toEqual(["*/30 * * * *", "30 9 * * 1-5"]);
    expect(h.toAgent.some((m) => m.method === "session/prompt")).toBe(false);
    h.addon.stop();
  });
});

describe("the agent's tools (approved by the user)", () => {
  async function setup() {
    const h = await harness(dir, { claude: true });
    const open = h.toAgent.find((m) => m.method === "session/new")?.params as {
      mcpServers: Array<{
        name: string;
        command: string;
        args: string[];
        env: Array<{ name: string; value: string }>;
      }>;
    };
    const server = open.mcpServers.find((s) => s.name === "agent-rewake");
    const link = server?.env.find((e) => e.name === "AGENT_REWAKE_LINK")?.value;
    const tool = (name: string, args: Record<string, unknown>) =>
      callTool({ stateDir: dir, link, now: () => T0, locale: "en-GB", pollMs: 5 }, name, args);
    return { h, server, tool };
  }
  const drive = async (h: Awaited<ReturnType<typeof harness>>) => {
    await settle();
    h.addon.processRequests();
    await settle();
  };

  it("adds Rewake's tool server to the session", async () => {
    const { h, server } = await setup();
    expect(server).toMatchObject({ command: "/node", args: ["/rewake.js", "mcp"] });
    h.addon.stop();
  });

  it("schedules what the agent asks for only after the user accepts, and labels it for the agent", async () => {
    const { h, tool } = await setup();
    const result = tool("schedule_message", {
      message: "Check whether the CI run passed",
      when: "in 30m",
      reason: "The build takes about 25 minutes",
    });
    await drive(h);
    const ask = forms(h).at(-1);
    expect((ask?.params as { message: string } | undefined)?.message).toBe(
      'Claude wants to schedule a message in this thread for 14:30 today. Reason: "The build takes about 25 minutes". You can edit the message. Submit schedules it; Decline refuses.',
    );
    expect(h.store.list()).toEqual([]); // nothing until the user accepts
    h.client({
      id: ask?.id,
      result: { action: "accept", content: { message: "Check whether the CI run passed" } },
    });
    const reply = (await result).content[0]?.text ?? "";
    expect(reply).toMatch(
      /^The user approved it\.\nAs saved:\n1\. Next: Sun, 4 Oct 2026, 14:30 \(/,
    );
    expect(reply).toContain(") · 14:30 today\n");
    expect(reply).toContain("Status: scheduled · Once · Added by: you asked, the user approved");
    expect(reply).toContain("Message: Check whether the CI run passed");
    expect(reply).toMatch(/Current time: Sun, 4 Oct 2026, 14:00 \(/);
    expect(h.store.list()[0]).toMatchObject({ createdBy: "agent", dueAt: T0 + 30 * 60_000 });

    h.advance(30 * 60_000);
    h.addon.tick();
    await settle();
    const sent = h.toAgent.filter((m) => m.method === "session/prompt").at(-1);
    expect((sent?.params as { prompt: Array<{ text: string }> } | undefined)?.prompt[0]?.text).toBe(
      "[A message you scheduled earlier with Agent Rewake; the user approved it] Check whether the CI run passed",
    );
    h.addon.stop();
  });

  it("answers questions about Rewake with the guide and this thread's settings, no approval needed", async () => {
    const { h, tool } = await setup();
    const about = (await tool("about_rewake", {})).content[0]?.text ?? "";
    expect(about).toMatch(/^# Agent Rewake: what it is and how it behaves/);
    expect(about).toContain("| Zed is closed at that time | Nothing is sent.");
    expect(about).toContain("## Right now");
    expect(about).toContain(
      "- This thread: automatic resume after usage limits is off; nothing is scheduled.",
    );
    expect(forms(h)).toEqual([]);
    h.addon.stop();
  });

  it("changes nothing if the user answers after the agent stopped waiting", async () => {
    const { h } = await setup();
    const open = h.toAgent.find((m) => m.method === "session/new")?.params as {
      mcpServers: Array<{ name: string; env: Array<{ name: string; value: string }> }>;
    };
    const link = open.mcpServers
      .find((x) => x.name === "agent-rewake")
      ?.env.find((e) => e.name === "AGENT_REWAKE_LINK")?.value;
    const result = callTool(
      { stateDir: dir, link, now: () => T0, locale: "en-GB", pollMs: 5, timeoutMs: 30 },
      "schedule_message",
      { message: "Check the build", when: "in 30m" },
    );
    await drive(h);
    const ask = forms(h).at(-1);
    expect((await result).content[0]?.text).toMatch(/didn't answer within 10 minutes/);
    h.client({
      id: ask?.id,
      result: { action: "accept", content: { message: "Check the build" } },
    });
    await settle();
    expect(h.store.list()).toEqual([]);
    expect(h.texts().at(-1)).toBe(
      "Rewake: Nothing changed. Claude stopped waiting for your answer after 10 minutes. Ask it again if you still want this.",
    );
    h.addon.stop();
  });

  it("lists and cancels on request, and changes nothing when the user declines", async () => {
    const { h, tool } = await setup();
    h.prompt(2, "/schedule every day 09:00 Daily summary");
    await settle();
    const list = (await tool("list_scheduled_messages", {})).content[0]?.text ?? "";
    expect(list).toMatch(/^Current time: Sun, 4 Oct 2026, 14:00 \(/);
    expect(list).toMatch(/\n1\. Next: Mon, 5 Oct 2026, 09:00 \(.*\) · 09:00 tomorrow \(Monday\)\n/);
    expect(list).toContain(
      "Status: scheduled · Repeats: Every day at 09:00 (until cancelled) · Added by: the user",
    );
    const declined = tool("cancel_scheduled_message", { number: 1, reason: "Not needed" });
    await drive(h);
    h.client({ id: forms(h).at(-1)?.id, result: { action: "decline" } });
    expect((await declined).content[0]?.text).toMatch(
      /^The user declined: it stays scheduled\.\nCurrent time: /,
    );
    expect(h.store.list()).toHaveLength(1);

    const cron = tool("schedule_message", { message: "x", cron: "0 9 * *" });
    expect((await cron).isError).toBe(true);
    h.addon.stop();
  });
  it("tells the agent when the user edited the message, and warns both about a duplicate", async () => {
    const { h, tool } = await setup();
    h.prompt(2, "/schedule in 2h Run the tests");
    await settle();
    const result = tool("schedule_message", { message: "run the tests ", when: "in 1h" });
    await drive(h);
    expect(formMessage(h)).toContain("The same message is already scheduled for 16:00 today.");
    h.client({ id: forms(h).at(-1)?.id, result: { action: "accept", content: { message: "hi" } } });
    const reply = (await result).content[0]?.text ?? "";
    expect(reply).toMatch(/^The user approved it, after editing the message\./);
    expect(reply).toContain("Message: hi");
    h.addon.stop();
  });

  it("ends a repeat after the runs asked for, and remembers how the last run went", async () => {
    const { h, tool } = await setup();
    const result = tool("schedule_message", {
      message: "Status check",
      cron: "0 * * * *",
      ends_after_runs: 2,
    });
    await drive(h);
    expect(formMessage(h)).toContain("Repeats: Every hour, on the hour, ending after 2 runs.");
    await answer(h, { message: "Status check" });
    expect((await result).content[0]?.text).toContain(
      "Repeats: Every hour, on the hour (2 runs left)",
    );
    const prompts = () => h.toAgent.filter((m) => m.method === "session/prompt");
    for (const n of [1, 2]) {
      h.advance(HOUR);
      h.addon.tick();
      await settle();
      h.agent({ id: prompts().at(-1)?.id, result: { stopReason: "end_turn" } });
      await settle();
      expect(prompts()).toHaveLength(n);
    }
    expect(h.texts()).toContain("Rewake: That was the last run of this repeating message.");
    expect(h.store.list()[0]).toMatchObject({ status: "sent", lastRun: { outcome: "sent" } });
    h.advance(HOUR);
    h.addon.tick();
    await settle();
    expect(prompts()).toHaveLength(2);
    h.addon.stop();
  });

  it("changes a message only after the user accepts: time, repeat end, pause", async () => {
    const { h, tool } = await setup();
    h.prompt(2, "/schedule every day 09:00 Daily summary");
    await settle();
    const moved = tool("update_scheduled_message", {
      number: 1,
      when: "tomorrow 10:00",
      ends_after_runs: 3,
      paused: true,
      reason: "Later works better",
    });
    await drive(h);
    expect(formMessage(h)).toBe(
      'Claude wants to change the message scheduled for 09:00 tomorrow (Monday) ("Daily summary"): move it from 09:00 tomorrow (Monday) to 10:00 tomorrow (Monday), end the repeat, ending after 3 runs, pause it. Reason: "Later works better". Submit changes it; Decline keeps it as it is.',
    );
    expect(h.store.list()[0]?.status).toBe("scheduled"); // nothing until the user accepts
    await answer(h, {});
    const reply = (await moved).content[0]?.text ?? "";
    expect(reply).toMatch(/^The user approved it\.\nAs saved:\n1\. Next: Mon, 5 Oct 2026, 10:00/);
    expect(reply).toContain("Status: paused · Repeats: Every day at 09:00 (3 runs left)");

    const resumed = tool("update_scheduled_message", {
      number: 1,
      paused: false,
      message: "Summary",
    });
    await drive(h);
    expect(formKeys(h)).toEqual(["message"]);
    await answer(h, "decline");
    expect((await resumed).content[0]?.text).toMatch(/^The user declined: nothing was changed\./);
    expect(h.store.list()[0]).toMatchObject({ status: "paused", text: "Daily summary" });

    expect((await tool("update_scheduled_message", { number: 1 })).isError).toBe(true);
    expect((await tool("update_scheduled_message", { number: 4, paused: false })).isError).toBe(
      true,
    );
    h.addon.stop();
  });

  it("refuses an end for a one-off message, and reports past times with the current time", async () => {
    const { tool, h } = await setup();
    const once = await tool("schedule_message", {
      message: "x",
      when: "in 1h",
      ends_after_runs: 2,
    });
    expect(once.isError).toBe(true);
    const past = await tool("schedule_message", { message: "x", when: "2026-10-04 09:00" });
    expect(past.content[0]?.text).toMatch(
      /^That time has already passed\. Current time: Sun, 4 Oct 2026, 14:00/,
    );
    h.addon.stop();
  });
});

describe("the menu's own Rewake entry", () => {
  it("shows what Rewake is, how to use it, and where it lives", async () => {
    const h = await harness(dir, {
      claude: true,
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "a",
          options: [{ value: "a", name: "A" }],
        },
      ],
    });
    const menu = (
      h.toClient.find((m) => m.id === 1)?.result as
        | { configOptions: Array<{ id: string; currentValue: string }> }
        | undefined
    )?.configOptions.find((o) => o.id === "rewake");
    h.client({
      id: 7,
      method: "session/set_config_option",
      params: { sessionId: "s-1", configId: "rewake", value: menu?.currentValue },
    });
    await settle();
    const about = h.texts().at(-1) ?? "";
    expect(about).toMatch(/^\*\*About Agent Rewake\*\*/);
    expect(about).toContain("[Agent Rewake on GitHub](https://github.com/codizelabs/agent-rewake)");
    expect(forms(h)).toEqual([]);
    h.addon.stop();
  });
});

// The Rewake menu for every agent.
describe("the same Rewake menu for every agent", () => {
  // Gemini CLI 0.62.0 and Zed's older Claude adapter answer with legacy modes and models only
  //.
  const LEGACY = {
    modes: {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "autoEdit", name: "Auto edit", description: "Edits without asking" },
      ],
    },
    models: {
      currentModelId: "gemini-pro",
      availableModels: [
        { modelId: "gemini-pro", name: "Gemini Pro" },
        { modelId: "gemini-flash", name: "Gemini Flash" },
      ],
    },
  };
  type Opt = { id: string; category?: string; currentValue?: string; options: unknown[] };
  const optionsIn = (m: { result?: unknown } | undefined) =>
    (m?.result as { configOptions?: Opt[] } | undefined)?.configOptions ?? [];
  const lastOptionsUpdate = (h: Awaited<ReturnType<typeof harness>>) =>
    (
      h.toClient
        .filter(
          (m) =>
            (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
            "config_option_update",
        )
        .at(-1)?.params as { update: { configOptions: Opt[] } } | undefined
    )?.update.configOptions;

  it("shows a legacy-only agent's modes and models as toolbar options, beside the menu", async () => {
    const h = await harness(dir, { agentName: "gemini-cli", sessionResult: LEGACY });
    const options = optionsIn(h.toClient.find((m) => m.id === 1));
    expect(options.map((o) => [o.id, o.category, o.currentValue])).toEqual([
      ["mode", "mode", "default"],
      ["model", "model", "gemini-pro"],
      ["rewake", "_rewake", expect.stringMatching(/\.home$/)],
    ]);
    expect(options[0]?.options).toEqual([
      { value: "default", name: "Default" },
      { value: "autoEdit", name: "Auto edit", description: "Edits without asking" },
    ]);
    h.addon.stop();
  });

  it("translates a mode or model pick into the agent's own request, and its mode changes back", async () => {
    const h = await harness(dir, { agentName: "gemini-cli", sessionResult: LEGACY });
    h.client({
      id: 7,
      method: "session/set_config_option",
      params: { sessionId: "s-1", configId: "mode", value: "autoEdit" },
    });
    await settle();
    const ask = h.toAgent.find((m) => m.method === "session/set_mode");
    expect(ask?.params).toEqual({ sessionId: "s-1", modeId: "autoEdit" });
    expect(h.toAgent.some((m) => m.method === "session/set_config_option")).toBe(false);
    h.agent({ id: ask?.id, result: {} });
    await settle();
    const answer = optionsIn(h.toClient.find((m) => m.id === 7));
    expect(answer.find((o) => o.id === "mode")?.currentValue).toBe("autoEdit");
    expect(answer.at(-1)?.id).toBe("rewake");

    h.client({
      id: 8,
      method: "session/set_config_option",
      params: { sessionId: "s-1", configId: "model", value: "gemini-flash" },
    });
    await settle();
    const model = h.toAgent.find((m) => m.method === "session/set_model");
    expect(model?.params).toEqual({ sessionId: "s-1", modelId: "gemini-flash" });
    h.agent({ id: model?.id, error: { code: -32602, message: "Unknown model" } });
    await settle();
    expect(h.toClient.find((m) => m.id === 8)?.error).toEqual({
      code: -32602,
      message: "Unknown model",
    });

    // The agent switches mode itself: Zed ignores mode updates once there are options, so it
    // becomes an options update.
    h.agent({
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: { sessionUpdate: "current_mode_update", currentModeId: "default" },
      },
    });
    await settle();
    expect(lastOptionsUpdate(h)?.find((o) => o.id === "mode")?.currentValue).toBe("default");
    h.addon.stop();
  });

  it("applies the agent's default_mode from Zed's settings, which Zed no longer applies itself", async () => {
    const config = join(dir, "zed-config");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "settings.json"),
      '{ // Zed\n "agent_servers": { "gemini": { "type": "registry", "default_mode": "autoEdit" } } }',
    );
    const h = await harness(dir, {
      agentName: "gemini-cli",
      agentId: "gemini",
      sessionResult: LEGACY,
      env: { AGENT_REWAKE_ZED_CONFIG_DIR: config, CLAUDE_CONFIG_DIR: join(dir, "c") },
    });
    const ask = h.toAgent.find((m) => m.method === "session/set_mode");
    expect(ask?.params).toEqual({ sessionId: "s-1", modeId: "autoEdit" });
    h.agent({ id: ask?.id, result: {} });
    await settle();
    expect(lastOptionsUpdate(h)?.find((o) => o.id === "mode")?.currentValue).toBe("autoEdit");
    h.addon.stop();
  });

  it("gives every kind of agent the same menu entries", async () => {
    const menuNames = async (o: HarnessOptions) => {
      const h = await harness(mkdtempSync(join(tmpdir(), "rewake-parity-")), o);
      const options = optionsIn(h.toClient.find((m) => m.id === 1));
      h.addon.stop();
      return ((options.at(-1)?.options ?? []) as Array<{ name: string }>).map((x) => x.name);
    };
    const codexModel = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gpt-5",
      options: [{ value: "gpt-5", name: "GPT-5" }],
    };
    const withOptions = await menuNames({ agentName: "codex-acp", configOptions: [codexModel] });
    const legacy = await menuNames({ agentName: "gemini-cli", sessionResult: LEGACY });
    const bare = await menuNames({ agentName: "deepagents-acp" });
    expect(legacy).toEqual(withOptions);
    expect(bare).toEqual(withOptions);
  });
});

// Usage limits for every agent.
describe("usage limits for every agent", () => {
  const CODEX = {
    agentName: "@agentclientprotocol/codex-acp",
    agentTitle: "Codex",
    agentId: "codex-acp",
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5",
        options: [{ value: "gpt-5", name: "GPT-5" }],
      },
    ],
  };
  const GEMINI = { agentName: "gemini-cli", agentTitle: "Gemini CLI", agentId: "gemini" };
  const codexLimit = {
    code: -32603,
    message: "Internal error",
    data: {
      message: "You've hit your usage limit. Upgrade to Pro or try again at 6:34 PM.",
      codexErrorInfo: "usageLimitExceeded",
    },
  };
  const geminiLimit = { code: 429, message: "Rate limit exceeded. Try again later." };

  it("offers Codex the same resume form, at the time Codex gave", async () => {
    const h = await harness(dir, CODEX);
    h.prompt(2, "keep going");
    await settle();
    h.agent({ id: 2, error: codexLimit });
    await settle();
    expect(formMessage(h)).toBe(
      "Codex hit its usage limit. It resets at 18:34 today. Resume this thread when it resets?",
    );
    await answer(h, { prompt: "Carry on" });
    expect(h.store.list()[0]).toMatchObject({
      text: "Carry on",
      dueAt: T0 + 4 * HOUR + 35 * 60_000, // the reset, plus Rewake's margin
    });
    h.addon.stop();
  });

  it("has Auto-resume in the menu for every agent", async () => {
    for (const o of [CODEX, { ...GEMINI, sessionResult: {} }]) {
      const h = await harness(mkdtempSync(join(tmpdir(), "rewake-auto-")), o);
      const menu = (
        h.toClient.find((m) => m.id === 1)?.result as {
          configOptions?: Array<{ id: string; options: Array<{ name: string }> }>;
        }
      )?.configOptions?.find((x) => x.id === "rewake");
      expect(menu?.options.map((x) => x.name)).toContain("Turn on auto-resume after limits…");
      h.addon.stop();
    }
  });

  it("resumes Gemini automatically after the wait you chose, again while still limited, for up to a day", async () => {
    const h = await harness(dir, GEMINI);
    h.prompt(2, "keep going");
    await settle();
    h.agent({ id: 2, error: geminiLimit });
    await settle();
    expect(formMessage(h)).toBe(
      "Gemini CLI hit its usage limit. It didn't say when the limit resets. When should Rewake resume this thread?",
    );
    await answer(h, { prompt: "Carry on", when: String(HOUR) });
    new ThreadStore(dir).update("s-1", "/project", { autoResume: true }, T0);
    expect(h.store.list()[0]?.dueAt).toBe(T0 + HOUR);
    for (const sched of h.store.list())
      h.store.update(sched.scheduleId, (x) => ({ ...x, status: "sent" }), T0);

    // A later limit: resumed automatically after the same wait, with no form.
    h.advance(HOUR);
    const formsBefore = forms(h).length;
    h.prompt(3, "next task");
    await settle();
    h.agent({ id: 3, error: geminiLimit });
    await settle();
    expect(forms(h).length).toBe(formsBefore);
    const auto = h.store.list().find((s) => s.kind === "auto_limit_resume");
    expect(auto?.dueAt).toBe(T0 + 2 * HOUR);

    // Still limited when it resumes: wait again.
    h.advance(HOUR);
    h.addon.tick();
    await settle();
    const sent = h.toAgent.filter((m) => m.method === "session/prompt").at(-1);
    h.agent({ id: sent?.id, error: geminiLimit });
    await settle();
    expect(h.store.get(auto?.scheduleId ?? "")?.dueAt).toBe(T0 + 3 * HOUR);
    expect(h.texts().at(-1)).toMatch(
      /^Rewake: Paused again\. Gemini CLI is still at its usage limit\. Rewake will try again at 17:00 today\.$/,
    );
    h.addon.stop();
  });

  it("resumes on its own in a full-access mode too, for any agent, unless Settings turns it off", async () => {
    const fullAccess = {
      ...CODEX,
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "agent-full-access",
          options: [{ value: "agent-full-access", name: "Full access" }],
        },
      ],
    };
    const h = await harness(dir, fullAccess);
    new ThreadStore(dir).update("s-1", "/project", { autoResume: true }, T0);
    h.prompt(2, "keep going");
    await settle();
    h.agent({ id: 2, error: codexLimit });
    await settle();
    expect(h.store.list()[0]).toMatchObject({ kind: "auto_limit_resume" });
    h.addon.stop();

    const other = mkdtempSync(join(tmpdir(), "rewake-full-"));
    saveSettings(other, { ...loadSettings(other), autoWhenPromptsSkipped: false });
    const g = await harness(other, fullAccess);
    new ThreadStore(other).update("s-1", "/project", { autoResume: true }, T0);
    g.prompt(2, "keep going");
    await settle();
    g.agent({ id: 2, error: codexLimit });
    await settle();
    expect(g.texts()).toContain(
      "Rewake: Not resuming automatically this time: this thread bypasses permissions, and your setting excludes those threads.",
    );
    expect(formMessage(g)).toMatch(/^Codex hit its usage limit\./);
    g.addon.stop();
  });
});

// Robustness that differs by agent.
describe("robust with every agent", () => {
  it("opens the session without Rewake's tools if the agent refuses them", async () => {
    const h = await harness(dir, { agentName: "qwen-code", agentTitle: "Qwen Code" });
    h.client({ id: 20, method: "session/new", params: { cwd: "/p", mcpServers: [] } });
    await settle();
    const first = h.toAgent.filter((m) => m.method === "session/new").at(-1);
    expect(
      (first?.params as { mcpServers: Array<{ name: string }> } | undefined)?.mcpServers,
    ).toHaveLength(1);
    h.agent({ id: 20, error: { code: -32099, message: "MCP budget would be exceeded" } });
    await settle();
    const retry = h.toAgent.filter((m) => m.method === "session/new").at(-1);
    expect(retry?.id).not.toBe(20);
    expect((retry?.params as { mcpServers: unknown[] } | undefined)?.mcpServers).toEqual([]);
    h.agent({ id: retry?.id, result: { sessionId: "s-2" } });
    await settle();
    const answer = h.toClient.find((m) => m.id === 20);
    expect(answer?.error).toBeUndefined();
    expect((answer?.result as { sessionId: string } | undefined)?.sessionId).toBe("s-2");
    // Not offered again to this agent.
    h.client({ id: 21, method: "session/new", params: { cwd: "/p", mcpServers: [] } });
    await settle();
    const third = h.toAgent.filter((m) => m.method === "session/new").at(-1);
    expect((third?.params as { mcpServers: unknown[] } | undefined)?.mcpServers).toEqual([]);
    h.addon.stop();
  });

  it("passes a sign-in error straight through, without retrying", async () => {
    const h = await harness(dir, { agentName: "codex-acp" });
    h.client({ id: 20, method: "session/new", params: { cwd: "/p", mcpServers: [] } });
    await settle();
    h.agent({ id: 20, error: { code: -32000, message: "Authentication required" } });
    await settle();
    expect(h.toClient.find((m) => m.id === 20)?.error).toEqual({
      code: -32000,
      message: "Authentication required",
    });
    expect(h.toAgent.filter((m) => m.method === "session/new")).toHaveLength(2); // harness + this
    h.addon.stop();
  });

  it("sends its commands again a moment after the session opens (zed#59281)", async () => {
    const h = await harness(dir, { agentName: "gemini-cli" });
    const count = () =>
      h.toClient.filter(
        (m) =>
          (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          "available_commands_update",
      ).length;
    expect(count()).toBe(1);
    await new Promise((res) => setTimeout(res, 500));
    expect(count()).toBe(2);
    h.addon.stop();
  });

  it("forwards Zed's capabilities to the agent unchanged", async () => {
    const h = await harness(dir, { agentName: "codex-acp" });
    expect(h.toAgent[0]?.params).toEqual({
      protocolVersion: 1,
      clientInfo: { name: "zed", version: "1.22.0" },
      clientCapabilities: { elicitation: { form: {} } },
    });
    h.addon.stop();
  });

  it("keeps the agent's own commands when it announces them before the session response", async () => {
    // Seen live with deepagents-acp 0.1.7: its commands arrive before its session/new answer.
    const h = await harness(dir, { agentName: "deepagents-acp" });
    h.client({ id: 30, method: "session/new", params: { cwd: "/p", mcpServers: [] } });
    await settle();
    h.agent({
      method: "session/update",
      params: {
        sessionId: "s-9",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "plan", description: "Plan mode", input: null }],
        },
      },
    });
    h.agent({ id: 30, result: { sessionId: "s-9" } });
    await settle();
    const last = h.toClient
      .filter(
        (m) =>
          (m.params as { sessionId?: string; update?: { sessionUpdate?: string } })?.update
            ?.sessionUpdate === "available_commands_update" &&
          (m.params as { sessionId?: string }).sessionId === "s-9",
      )
      .at(-1)?.params as { update: { availableCommands: Array<{ name: string }> } } | undefined;
    expect(last?.update.availableCommands.map((c) => c.name)).toEqual(["plan", "schedule", "stop"]);
    h.addon.stop();
  });
});

// ---- limits in every agent's words --------------------------------------------------

describe("limits that agents report in their own way", () => {
  const chunk = (text: string) => ({
    method: "session/update",
    params: {
      sessionId: "s-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
  const toolCall = {
    method: "session/update",
    params: {
      sessionId: "s-1",
      update: { sessionUpdate: "tool_call", toolCallId: "t-1", title: "Read file" },
    },
  };

  it("Claude: a spend limit whose session limit resets is offered a resume", async () => {
    const h = await harness(dir, { claude: true });
    h.prompt(2, "keep going");
    await settle();
    h.agent(rateEvent(RESET));
    h.agent({
      id: 2,
      error: {
        code: -32603,
        message:
          "Internal error: You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 5pm",
        data: { errorKind: "rate_limit" },
      },
    });
    await settle();
    expect(formMessage(h)).toMatch(/^Claude hit its usage limit\. It resets at 17:00 today\./);
    h.addon.stop();
  });

  it("Claude: says why it won't resume when only credits would help", async () => {
    const h = await harness(dir, { claude: true });
    h.prompt(2, "keep going");
    await settle();
    h.agent({
      id: 2,
      error: {
        code: -32603,
        message: "Internal error: You're out of usage credits",
        data: { errorKind: "rate_limit" },
      },
    });
    await settle();
    expect(forms(h)).toHaveLength(0);
    expect(h.texts().at(-1)).toBe(
      "Rewake: Not resuming. Claude stopped at a credit, billing or spending limit, which waiting won't fix.",
    );
    h.addon.stop();
  });

  it("Cursor: the limit line at the end of a normal turn", async () => {
    const h = await harness(dir, {
      agentName: "cursor-agent",
      agentTitle: "Cursor",
      agentId: "cursor",
    });
    h.prompt(2, "keep going");
    await settle();
    h.agent(chunk("Working on it."));
    h.agent(toolCall);
    h.agent(chunk("\n\nUpgrade your plan to continue"));
    h.agent({ id: 2, result: { stopReason: "end_turn" } });
    await settle();
    expect(formMessage(h)).toMatch(/^Cursor hit its usage limit\. It didn't say when/);
    h.addon.stop();
  });

  it("Copilot: limit words in the middle of a turn are not a limit", async () => {
    const h = await harness(dir, {
      agentName: "copilot",
      agentTitle: "GitHub Copilot",
      agentId: "github-copilot-cli",
    });
    h.prompt(2, "what does the log say?");
    await settle();
    h.agent(
      chunk(
        "Error: You've hit your session rate limit. Please wait for your limit to reset in 3 hours.",
      ),
    );
    h.agent(toolCall);
    h.agent(chunk("That line is from yesterday's run; nothing is limited now."));
    h.agent({ id: 2, result: { stopReason: "end_turn" } });
    await settle();
    expect(forms(h)).toHaveLength(0);
    h.addon.stop();
  });

  it("Droid: reads the message before its bare error, and doesn't repeat it", async () => {
    const h = await harness(dir, {
      agentName: "droid",
      agentTitle: "Factory Droid",
      agentId: "factory-droid",
    });
    h.prompt(2, "keep going");
    await settle();
    const limit =
      'Error: 402 {"detail":"You\'ve reached your 5-hour standard usage limit (resets in 3h 0min).","status":402}';
    h.agent(chunk(limit));
    h.agent({
      id: 2,
      error: {
        code: -32603,
        message: "Internal error",
        data: { details: "Internal error: Agent error" },
      },
    });
    await settle();
    expect(formMessage(h)).toMatch(
      /^Factory Droid hit its usage limit\. It resets at 17:00 today\./,
    );
    expect(h.texts().filter((t) => t.includes("5-hour standard usage limit"))).toHaveLength(1);
    h.addon.stop();
  });
});

describe("the limit ends early", () => {
  const allowed = {
    method: "_claude/sdkMessage",
    params: {
      sessionId: "s-1",
      message: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    },
  };

  it("cancels the resume when Claude answers again before the reset (another account)", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    await answer(h, { prompt: "Resume" });
    expect(h.store.list().filter((s) => s.status === "scheduled")).toHaveLength(1);
    h.advance(HOUR); // still before the 17:00 reset
    h.prompt(3, "carry on");
    await settle();
    h.agent(allowed);
    h.agent({ id: 3, result: { stopReason: "end_turn" } });
    await settle();
    expect(h.store.list().filter((s) => s.status === "scheduled")).toHaveLength(0);
    expect(h.texts().at(-1)).toMatch(/^Rewake: Cancelled the scheduled resume/);
    h.addon.stop();
  });

  it("keeps the resume when a turn succeeds without Claude saying the limit lifted", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2);
    await answer(h, { prompt: "Resume" });
    h.advance(HOUR);
    h.prompt(3, "/context");
    await settle();
    h.agent({ id: 3, result: { stopReason: "end_turn" } });
    await settle();
    expect(h.store.list().filter((s) => s.status === "scheduled")).toHaveLength(1);
    h.addon.stop();
  });
});

describe("the limit text in the thread", () => {
  it("isn't repeated when Claude already wrote it", async () => {
    const h = await harness(dir, { claude: true });
    h.prompt(2, "keep going");
    await settle();
    const text = "You've hit your session limit · resets 5pm";
    h.agent({
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      },
    });
    h.agent(rateEvent(RESET));
    h.agent({ id: 2, error: limitErr });
    await settle();
    expect(h.texts().filter((t) => t === text)).toHaveLength(1);
    h.addon.stop();
  });
});

describe("resumes left from an earlier limit", () => {
  it("cancels an old resume after a restart when Claude answers again (another account)", async () => {
    const h = await harness(dir, { claude: true });
    // Scheduled by an earlier process, which remembered the limit; this one doesn't.
    h.store.create({
      sessionId: "s-1",
      cwd: "/project",
      text: "Resume",
      dueAt: RESET + 60_000,
      kind: "auto_limit_resume",
      createdBy: "auto",
      now: T0,
    });
    h.advance(HOUR);
    h.prompt(2, "carry on");
    await settle();
    h.agent({
      method: "_claude/sdkMessage",
      params: {
        sessionId: "s-1",
        message: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
      },
    });
    h.agent({ id: 2, result: { stopReason: "end_turn" } });
    await settle();
    expect(h.store.list()[0]?.status).toBe("cancelled");
    h.addon.stop();
  });

  it("replaces a missed resume with this limit's resume", async () => {
    const h = await harness(dir, { claude: true });
    const old = h.store.create({
      sessionId: "s-1",
      cwd: "/project",
      text: "Resume",
      dueAt: T0 - HOUR,
      kind: "auto_limit_resume",
      createdBy: "auto",
      now: T0 - 2 * HOUR,
    });
    h.store.update(old.scheduleId, (x) => ({ ...x, status: "missed" }), T0);
    await hitLimit(h, 2);
    expect(h.store.get(old.scheduleId)?.status).toBe("cancelled");
    expect(formMessage(h)).toMatch(/^Claude hit its usage limit\. It resets at 17:00 today\./);
    h.addon.stop();
  });

  it("moves a resume earlier when a sooner limit resets first (another model)", async () => {
    const h = await harness(dir, { claude: true });
    const weekly = h.store.create({
      sessionId: "s-1",
      cwd: "/project",
      text: "Resume",
      dueAt: T0 + 72 * HOUR,
      kind: "auto_limit_resume",
      createdBy: "auto",
      now: T0,
    });
    await hitLimit(h, 2);
    expect(h.store.get(weekly.scheduleId)?.dueAt).toBe(RESET + 60_000);
    expect(h.texts().at(-1)).toBe(
      "Rewake: Moved the resume from Wednesday at 14:00 to 17:01 today, just after this limit resets.",
    );
    h.addon.stop();
  });

  it("still offers the resume in a line when another Rewake question is open", async () => {
    const h = await harness(dir, { claude: true });
    await hitLimit(h, 2); // its question stays open
    h.prompt(3, "try again");
    await settle();
    h.agent(rateEvent(RESET));
    h.agent({ id: 3, error: limitErr });
    await settle();
    expect(forms(h)).toHaveLength(1);
    expect(h.texts().at(-1)).toMatch(
      /^Rewake: Claude hit its usage limit; it resets at 17:00 today\. To resume when it resets,/,
    );
    h.addon.stop();
  });

  it("turns automatic resume on for a thread it first sees when Zed reopens it", async () => {
    saveSettings(dir, { ...loadSettings(dir), newThreads: "on" });
    const h = await harness(dir, { claude: true, askOnNewThreads: true });
    h.client({
      id: 7,
      method: "session/load",
      params: { sessionId: "s-9", cwd: "/project", mcpServers: [] },
    });
    await settle();
    h.agent({ id: 7, result: {} });
    await settle();
    expect(new ThreadStore(dir).get("s-9")?.autoResume).toBe(true);
    h.addon.stop();
  });
});

describe("limits reported in a turn's metadata", () => {
  it("DimCode: a plan window reached, from the refusal's error reason", async () => {
    const h = await harness(dir, {
      agentName: "dimcode",
      agentTitle: "DimCode",
      agentId: "dimcode",
    });
    h.prompt(2, "keep going");
    await settle();
    h.agent({
      id: 2,
      result: {
        stopReason: "refusal",
        _meta: {
          dimcode: { error: { type: "provider_error", reason: "window_rate_limit_reached" } },
        },
      },
    });
    await settle();
    expect(formMessage(h)).toMatch(/^DimCode hit its usage limit\./);
    h.addon.stop();
  });

  it("DimCode: says it won't resume when the balance is spent", async () => {
    const h = await harness(dir, {
      agentName: "dimcode",
      agentTitle: "DimCode",
      agentId: "dimcode",
    });
    h.prompt(2, "keep going");
    await settle();
    h.agent({
      id: 2,
      result: {
        stopReason: "refusal",
        _meta: {
          dimcode: { error: { reason: "insufficient_balance", message: "Insufficient balance" } },
        },
      },
    });
    await settle();
    expect(forms(h)).toHaveLength(0);
    expect(h.texts().at(-1)).toMatch(
      /^Rewake: Not resuming\. DimCode stopped at a credit, billing or spending limit/,
    );
    h.addon.stop();
  });

  it("Harn: a billing stop at the end of a normal turn", async () => {
    const h = await harness(dir, { agentName: "harn", agentTitle: "Harn", agentId: "harn" });
    h.prompt(2, "keep going");
    await settle();
    h.agent({
      id: 2,
      result: {
        stopReason: "end_turn",
        _meta: {
          harn: {
            terminal: {
              kind: "provider_error",
              terminalClass: "provider_billing",
              message: "anthropic HTTP 429 [billing_limit]: credit balance is too low",
            },
          },
        },
      },
    });
    await settle();
    expect(h.texts().at(-1)).toMatch(
      /^Rewake: Not resuming\. Harn stopped at a credit, billing or spending limit/,
    );
    h.addon.stop();
  });

  it("an ordinary turn's metadata is not a limit", async () => {
    const h = await harness(dir, { agentName: "harn", agentTitle: "Harn", agentId: "harn" });
    h.prompt(2, "hello");
    await settle();
    h.agent({
      id: 2,
      result: { stopReason: "end_turn", _meta: { harn: { terminal: { kind: "completed" } } } },
    });
    await settle();
    expect(forms(h)).toHaveLength(0);
    expect(h.texts().filter((t) => t.startsWith("Rewake:"))).toHaveLength(0);
    h.addon.stop();
  });
});

describe("keeping the computer awake", () => {
  /** A hold that records what Rewake asked for. */
  const recorder = (supported = true) => {
    const calls: [boolean, string][] = [];
    let held = false;
    const wake: Wake = {
      supported,
      set: (want, mode) => {
        calls.push([want, mode]);
        held = supported && want && mode !== "never";
        return held;
      },
      release: () => {
        held = false;
      },
    };
    return { wake, calls, held: () => held };
  };

  it("holds while a resume is due within a few hours, says so once, and lets go after", async () => {
    const r = recorder();
    const h = await harness(dir, { claude: true, wake: r.wake });
    await hitLimit(h, 2);
    await answer(h, { prompt: "Resume" });
    h.addon.tick();
    await settle();
    expect(r.held()).toBe(true);
    expect(r.calls.at(-1)).toEqual([true, "plugged-in"]);
    const said = h.texts().filter((t) => t.startsWith("Rewake: Keeping this computer awake"));
    expect(said).toEqual([
      "Rewake: Keeping this computer awake until the resume at 17:01 today, while it's plugged in. Closing the lid still puts it to sleep.",
    ]);
    h.addon.tick();
    await settle();
    expect(h.texts().filter((t) => t.startsWith("Rewake: Keeping"))).toHaveLength(1);
    // Cancelled: nothing is due, so the computer may sleep again.
    for (const s of h.store.list())
      h.store.update(s.scheduleId, (x) => ({ ...x, status: "cancelled" }), T0);
    h.addon.tick();
    await settle();
    expect(r.held()).toBe(false);
    h.addon.stop();
  });

  it("doesn't hold for a message due more than a few hours away", async () => {
    const r = recorder();
    const h = await harness(dir, { claude: true, wake: r.wake });
    h.store.create({
      sessionId: "s-1",
      cwd: "/project",
      text: "Run the tests",
      dueAt: T0 + 30 * HOUR,
      createdBy: "command",
      now: T0,
    });
    h.addon.tick();
    await settle();
    expect(r.held()).toBe(false);
    h.addon.stop();
  });

  it("follows the setting: never means never", async () => {
    saveSettings(dir, { ...loadSettings(dir), keepAwake: "never" });
    const r = recorder();
    const h = await harness(dir, { claude: true, wake: r.wake });
    await hitLimit(h, 2);
    await answer(h, { prompt: "Resume" });
    h.addon.tick();
    await settle();
    expect(r.held()).toBe(false);
    expect(h.texts().some((t) => t.startsWith("Rewake: Keeping"))).toBe(false);
    h.addon.stop();
  });

  it("says once where it can't keep the computer awake", async () => {
    const r = recorder(false);
    const h = await harness(dir, { claude: true, wake: r.wake });
    await hitLimit(h, 2);
    await answer(h, { prompt: "Resume" });
    h.addon.tick();
    h.addon.tick();
    await settle();
    expect(h.texts().filter((t) => t.startsWith("Rewake: Can't keep this computer awake"))).toEqual(
      [
        "Rewake: Can't keep this computer awake on this system. If it sleeps, resumes and scheduled messages wait until it wakes; change its sleep settings to avoid that.",
      ],
    );
    h.addon.stop();
  });
});
