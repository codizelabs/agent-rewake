// The words people read, pinned as inline snapshots: a wording change then shows up in review on
// purpose. When one of these fails after an intended change, check the new text against the UX
// rules in DESIGN.md §U, then update the snapshot with `vitest -u`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonRpcMessage } from "../src/acp/ndjson.js";
import { Router } from "../src/acp/router.js";
import { SchedulingAddon } from "../src/addon.js";
import { runContinue } from "../src/continue.js";
import { type DoctorContext, diagnose, render } from "../src/doctor.js";
import type { ClosedDeps } from "../src/hosts/closed.js";
import { copilotHost } from "../src/hosts/copilot/host.js";
import { geminiHost, offerText } from "../src/hosts/gemini/host.js";
import "../src/hosts/index.js";
import { SessionRecords } from "../src/hosts/sessions.js";
import { Logger } from "../src/util/log.js";

const HOUR = 3_600_000;
const T0 = new Date(2026, 9, 4, 14, 0, 0, 0).getTime(); // 4 Oct 2026 14:00 local
const settle = () => new Promise((r) => setTimeout(r, 15));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-strings-"));
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

/** What the person sees when the agent stops at a usage limit: the form's question and choices. */
async function limitForm(error: object): Promise<string> {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();
  const toClient = lines(clientOut);
  const addon = new SchedulingAddon({
    stateDir: dir,
    log: new Logger({ AGENT_REWAKE_STATE_DIR: dir }),
    now: () => T0,
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
  const router = new Router({ clientIn, clientOut, agentIn, agentOut, hooks: addon.hooks() });
  addon.attach(router);
  router.start();
  const client = (m: object) => clientIn.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const agent = (m: object) => agentIn.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  client({
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientInfo: { name: "zed", version: "1.22.0" },
      clientCapabilities: { elicitation: { form: {} } },
    },
  });
  await settle();
  agent({
    id: 0,
    result: { protocolVersion: 1, agentInfo: { name: "gemini-cli", title: "Gemini CLI" } },
  });
  await settle();
  client({ id: 1, method: "session/new", params: { cwd: "/project", mcpServers: [] } });
  await settle();
  agent({ id: 1, result: { sessionId: "s-1" } });
  await settle();
  client({
    id: 2,
    method: "session/prompt",
    params: { sessionId: "s-1", prompt: [{ type: "text", text: "keep going" }] },
  });
  await settle();
  agent({ id: 2, error });
  await settle();
  addon.stop();
  const form = toClient.filter((m) => m.method === "elicitation/create").at(-1);
  const params = form?.params as {
    message: string;
    requestedSchema: {
      properties: Record<string, { title: string; oneOf?: Array<{ title: string }> }>;
      required: string[];
    };
  };
  const fields = Object.entries(params.requestedSchema.properties).map(([key, f]) =>
    [
      `${key}: ${f.title}${params.requestedSchema.required.includes(key) ? " (required)" : ""}`,
      ...(f.oneOf ?? []).map((o) => `  - ${o.title}`),
    ].join("\n"),
  );
  return [params.message, ...fields].join("\n");
}

describe("the limit question", () => {
  it("asks when to resume, with the presets and their times, when the reset is unknown", async () => {
    expect(
      await limitForm({ code: 429, message: "Rate limit exceeded. Try again later." }),
    ).toMatchInlineSnapshot(`
      "Gemini CLI hit its usage limit. It didn't say when the limit resets. When should Rewake resume this thread?
      prompt: Message to send (required)
      when: Resume (required)
        - In 30 minutes (14:30 today)
        - In 1 hour (15:00 today)
        - In 3 hours (17:00 today)
        - In 5 hours (19:00 today)
        - Custom time…"
    `);
  });

  it("asks whether to resume at the reset time, when the agent gave one", async () => {
    expect(
      await limitForm({
        code: -32603,
        message: "Internal error",
        data: {
          message: "You've hit your usage limit. Upgrade to Pro or try again at 6:34 PM.",
          codexErrorInfo: "usageLimitExceeded",
        },
      }),
    ).toMatchInlineSnapshot(`
      "Gemini CLI hit its usage limit. It resets at 18:34 today. Resume this thread when it resets?
      prompt: Message to send (required)"
    `);
  });
});

describe("the Gemini offer", () => {
  const NOW = new Date(2026, 9, 7, 12, 0).getTime();
  it("names the reset, or asks for a time when there is none", () => {
    expect([offerText(NOW + HOUR, NOW), offerText(undefined, NOW)]).toMatchInlineSnapshot(`
      [
        "Rewake: Gemini hit its usage limit, which resets at 13:00 today. To continue this conversation then, type /rewake.",
        "Rewake: Gemini hit its usage limit. To continue this conversation later, type /rewake with a time, for example /rewake 3:30pm.",
      ]
    `);
  });
});

describe("agent-rewake continue", () => {
  const NOW = new Date(2026, 9, 7, 12, 0).getTime();
  const SESSIONS = [
    { host: copilotHost, id: "11111111-2222-4333-8444-555555555555", cwd: "/work/shop", reset: 3 },
    { host: geminiHost, id: "66666666-7777-4888-9999-000000000000", cwd: "/work/blog" },
  ] as const;

  function setUp(sessions: ReadonlyArray<(typeof SESSIONS)[number]>): ClosedDeps {
    const state = join(dir, "state");
    sessions.forEach((s, i) => {
      new SessionRecords(state, s.host.id).put({
        schemaVersion: 1,
        host: s.host.id,
        sessionId: s.id,
        cwd: s.cwd,
        open: false,
        closedAt: NOW - 60_000 * (i + 1),
        lastPromptAt: NOW - 3 * HOUR,
        limit: {
          kind: "session",
          billing: false,
          ...("reset" in s && { resetsAt: NOW + s.reset * HOUR }),
          seenAt: NOW - 60_000 * (i + 1),
        },
        updatedAt: NOW,
      });
    });
    return {
      stateDir: state,
      now: NOW,
      env: {},
      arm: () => {},
      disarm: () => {},
      notify: () => {},
    };
  }

  async function run(
    deps: ClosedDeps,
    interactive: boolean,
    answers: string[] = [],
    mode?: "always" | "ask" | "cancel",
  ) {
    let output = "";
    const asked: string[] = [];
    const code = await runContinue({
      ...(mode && { mode }),
      hosts: [copilotHost, geminiHost],
      deps,
      interactive,
      out: (t) => {
        output += t;
      },
      ask: async (q) => {
        asked.push(q);
        return answers.shift() ?? "";
      },
    });
    return `${output}${asked.map((q) => `? ${q}`).join("\n")}\nexit ${code}`;
  }

  it("lists the sessions stopped at a limit, and asks which to continue", async () => {
    expect(await run(setUp(SESSIONS), true, [""])).toMatchInlineSnapshot(`
      "Sessions stopped at a usage limit:
        1. GitHub Copilot CLI in the "shop" folder: stopped at 11:59 today; Rewake can continue it at 15:01 today
        2. Gemini CLI in the "blog" folder: stopped at 11:58 today
      Nothing was changed.
      ? Which one should Rewake continue? (1-2, or Enter to cancel) 
      exit 1"
    `);
  });

  it("lists them for a script, and says where to choose", async () => {
    expect(await run(setUp(SESSIONS), false)).toMatchInlineSnapshot(`
      "  GitHub Copilot CLI in the "shop" folder: stopped at 11:59 today; Rewake can continue it at 15:01 today
        Gemini CLI in the "blog" folder: stopped at 11:58 today
      Run "agent-rewake continue" in a terminal to choose.

      exit 1"
    `);
  });

  it("offers preset times when the reset is unknown", async () => {
    expect(await run(setUp(SESSIONS.slice(1)), true, [""])).toMatchInlineSnapshot(`
      "When should Rewake continue Gemini CLI in the "blog" folder?
        1. In 1 hour (13:00 today)
        2. In 3 hours (15:00 today)
        3. In 5 hours (17:00 today)
        4. Another time
      Nothing was changed.
      ? Choose 1-4 (Enter to cancel): 
      exit 1"
    `);
  });

  it("says when nothing waits", async () => {
    expect(await run(setUp([]), true)).toMatchInlineSnapshot(`
      "Nothing to continue: no closed session is stopped at a usage limit.

      exit 0"
    `);
  });

  it("explains --always and --ask", async () => {
    const deps = setUp([]);
    expect([
      await run(deps, true, [], "always"),
      await run(deps, true, [], "ask"),
    ]).toMatchInlineSnapshot(`
      [
        "From now on, when an agent stops at a usage limit that resets within a day, Rewake continues it by itself, without asking: in new Zed threads, in Claude Code, and in closed Copilot CLI, Gemini CLI, Grok Build, Qwen Code and Antigravity CLI sessions. To be asked again, everywhere: agent-rewake continue --ask

      exit 0",
        "Rewake will ask again, in every agent: after a usage limit, run "agent-rewake continue" to continue a closed session.

      exit 0",
      ]
    `);
  });
});

describe("doctor", () => {
  const NOW = new Date(2026, 9, 6, 12, 0).getTime(); // local, so the times read the same anywhere

  function report(options: { wrapped: boolean }): string {
    mkdirSync(join(dir, "zed"), { recursive: true });
    writeFileSync(join(dir, "agent-rewake.js"), "");
    writeFileSync(
      join(dir, "zed", "settings.json"),
      JSON.stringify({
        agent_servers: options.wrapped
          ? {
              "claude-acp": {
                type: "custom",
                command: process.execPath,
                args: [join(dir, "agent-rewake.js"), "--wrap-registry", "claude-acp"],
              },
            }
          : {},
      }),
    );
    if (options.wrapped) {
      mkdirSync(join(dir, "state", "logs"), { recursive: true });
      writeFileSync(
        join(dir, "state", "logs", "rewake-2026-10-06.jsonl"),
        `${JSON.stringify({
          level: "info",
          t: new Date(2026, 9, 6, 10, 0).toISOString(),
          event: "proxy.start",
          pid: 1,
          agent: "claude-acp",
          node: "24.1.0",
        })}\n`,
      );
    }
    const ctx: DoctorContext = {
      env: {
        AGENT_REWAKE_ZED_CONFIG_DIR: join(dir, "zed"),
        AGENT_REWAKE_ZED_DATA_DIR: join(dir, "data"),
        AGENT_REWAKE_STATE_DIR: join(dir, "state"),
        HOME: dir,
      },
      now: NOW,
      platform: "darwin",
      home: dir,
      zedApps: () => [{ name: "Zed", version: "1.22.0" }],
      version: "0.1.2",
      nodeVersion: "24.1.0",
    };
    // The temporary folder's name is the only thing that differs between runs.
    return render(diagnose(ctx), { version: "0.1.2", ascii: false }).split(dir).join("<home>");
  }

  it("says what to do first when Rewake isn't set up", () => {
    expect(report({ wrapped: false })).toMatchInlineSnapshot(`
      "Agent Rewake 0.1.2: checking your setup

      Zed
        ✓ OK: Found Zed 1.22.0.
        ✓ OK: Zed's AI features and Agent Panel are on.

      Rewake
        ! To do: Rewake isn't set up yet, and Zed has no external agents yet.
          → Run: npx @codizelabs/agent-rewake install  (it offers to add Claude Agent, Claude in Zed's Agent Panel)

      1 thing to do. Start here: Run: npx @codizelabs/agent-rewake install  (it offers to add Claude Agent, Claude in Zed's Agent Panel)
      More detail for a bug report: agent-rewake doctor --details
      "
    `);
  });

  it("says all is set when Zed has started a wrapped agent", () => {
    expect(report({ wrapped: true })).toMatchInlineSnapshot(`
      "Agent Rewake 0.1.2: checking your setup

      Zed
        ✓ OK: Found Zed 1.22.0.
        ✓ OK: Zed's AI features and Agent Panel are on.

      Rewake
        ✓ OK: Rewake is on for: Claude Agent.
        ✓ OK: Working: Zed last started it today at 10:00 AM, for Claude Agent.

      All set: nothing to do.
      More detail for a bug report: agent-rewake doctor --details
      "
    `);
  });
});
