import { createInterface } from "node:readline";
import { describeCron, nextRun, parseCron } from "./core/cron.js";
import { type AgentRequest, LinkStore, RequestStore } from "./core/requests.js";
import { applySettings, loadSettings } from "./core/settings.js";
import { ScheduleStore, TERMINAL_STATUSES } from "./core/store.js";
import { ThreadStore } from "./core/threads.js";
import { formatExact, formatWhen, parseWhen } from "./core/time.js";
import { AGENT_GUIDE } from "./guide.js";
import { VERSION } from "./version.js";

/**
 * `agent-rewake mcp`: the tools the agent gets in a thread with Rewake, as a
 * dependency-free MCP server over stdio (newline-delimited JSON-RPC). Rewake adds it to every
 * session it opens; the agent can then schedule, list, change and cancel messages in *its own*
 * thread. Every change waits for the user to accept in the thread, and the reply says exactly
 * what was saved.
 */

/** How long a tool call waits for the user before giving up (nothing is scheduled then). */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** What happens around a scheduled message, so the agent can tell the user before they approve. */
const DELIVERY_NOTES =
  "Times are the user's local time; a clock time that has passed today means tomorrow, and one-off messages can be at most 30 days ahead. A message is sent only while Zed is running with this project, and after a Zed restart only once the thread has been opened again; the user can work in other threads meanwhile. If a reply is in progress at that time, it's sent right after the reply. If Zed or the computer wasn't running, a one-off message more than 15 minutes late isn't sent: it's marked missed and the user is asked whether to send it; a repeating message skips that run. For anything else, call about_rewake.";

const ENDS = {
  ends_after_runs: {
    type: "integer",
    minimum: 1,
    description: "Repeating only: stop after this many runs.",
  },
  ends_at: {
    type: "string",
    description: 'Repeating only: no runs after this time, e.g. "2026-10-31 18:00" (local time).',
  },
};

export const TOOLS = [
  {
    name: "schedule_message",
    description: `Schedule a message to be sent into this conversation later, as if the user typed it. Use it when the user asks you to schedule something, or to schedule a follow-up for yourself (for example to check on a long build). The user must approve it in the thread, and may edit the message first; this call waits for that answer and returns what was saved: number, exact time, repeat, message. Give either \`when\` (once) or \`cron\` (repeating); a repeat runs until cancelled unless you give an end. ${DELIVERY_NOTES}`,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to send at that time." },
        when: {
          type: "string",
          description:
            'For a one-off: "in 30m", "in 2h", "09:00", "tomorrow 09:00" or "2026-10-06 09:00" (local time).',
        },
        cron: {
          type: "string",
          description:
            'For a repeating message: a 5-field cron expression in local time, e.g. "0 9 * * 1-5" (weekdays at 09:00), or @hourly, @daily, @weekly.',
        },
        ...ENDS,
        reason: { type: "string", description: "One sentence the user sees: why you want this." },
      },
      required: ["message"],
    },
  },
  {
    name: "about_rewake",
    description:
      "How Agent Rewake works, in detail: what it does, the Rewake menu and commands, settings, when a scheduled message is and isn't sent (Zed closed, thread closed or not open, another thread in use, computer asleep, late, busy, several windows), usage limits and automatic resume, approvals, statuses and data. Call it before answering any question the user asks about Rewake, and answer from it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_scheduled_messages",
    description:
      "List the messages scheduled in this conversation, numbered, with the current time, each one's exact next run, status, repeat and end, how its last run went, and messages finished in the last 24 hours.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_scheduled_message",
    description: `Change a message scheduled in this conversation, by its number from list_scheduled_messages: its message, its time, its repeat or end, or pause or resume it. Give only what changes. The user must approve it in the thread, and may edit the message; this call waits and returns the message as saved. ${DELIVERY_NOTES}`,
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer", minimum: 1 },
        message: { type: "string", description: "The new message." },
        when: {
          type: "string",
          description: "A new time for the next run (as in schedule_message).",
        },
        cron: { type: "string", description: "A new repeat (replaces the old one)." },
        stop_repeating: {
          type: "boolean",
          description: "true: send it once more at its next run, then stop.",
        },
        ...ENDS,
        paused: { type: "boolean", description: "true pauses it; false resumes it." },
        reason: { type: "string", description: "One sentence the user sees: why." },
      },
      required: ["number"],
    },
  },
  {
    name: "cancel_scheduled_message",
    description:
      "Delete a message scheduled in this conversation, by its number from list_scheduled_messages. The user must approve it in the thread; this call waits for that answer.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer", minimum: 1 },
        reason: { type: "string", description: "One sentence the user sees: why." },
      },
      required: ["number"],
    },
  },
];

export interface McpOptions {
  stateDir: string;
  /** The token Rewake gave this tool server (AGENT_REWAKE_LINK). */
  link: string | undefined;
  now?: () => number;
  locale?: string;
  pollMs?: number;
  timeoutMs?: number;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function runMcp(
  opts: McpOptions,
  input: NodeJS.ReadableStream = process.stdin,
  output: { write(chunk: string): unknown } = process.stdout,
): Promise<number> {
  const send = (m: object) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    let m: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === undefined || m.id === null) return; // notifications need no answer
    const reply = (result: unknown) => send({ id: m.id, result });
    switch (m.method) {
      case "initialize":
        reply({
          protocolVersion:
            typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-rewake", version: VERSION },
          instructions:
            "Agent Rewake resumes this conversation after usage limits and schedules messages into it. The user approves every schedule, change and cancellation in the thread. When the user asks anything about Rewake (how it works, what happens if Zed or the thread is closed, settings, limits), call about_rewake first and answer from it.",
        });
        return;
      case "ping":
        reply({});
        return;
      case "tools/list":
        reply({ tools: TOOLS });
        return;
      case "tools/call":
        void callTool(
          opts,
          String(m.params?.name ?? ""),
          (m.params?.arguments ?? {}) as Record<string, unknown>,
        )
          .then(reply)
          .catch((err: Error) => reply(text(`Agent Rewake: ${err.message}`, true)));
        return;
      default:
        send({ id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
    }
  });
  return new Promise((resolve) => rl.on("close", () => resolve(0)));
}

/** The guide, plus this thread's settings right now, so answers can be specific. */
function aboutRewake(opts: McpOptions, sessionId: string | undefined, now: number): string {
  const settings = loadSettings(opts.stateDir);
  const auto = {
    off: "Off",
    ask: "Ask when a new thread opens",
    on: settings.autoWhenPromptsSkipped
      ? "On, even when permissions are bypassed"
      : "On, except when permissions are bypassed",
  }[settings.newThreads];
  const lines = [
    "## Right now",
    "",
    `- Current time: ${formatExact(now, opts.locale)}.`,
    `- Settings: automatic resume for new threads: ${auto}${
      settings.newThreads !== "on"
        ? `; threads that bypass permissions ${settings.autoWhenPromptsSkipped ? "included" : "excluded"}`
        : ""
    }. Time format: ${settings.clock === "24h" ? "24-hour" : "12-hour"}.`,
  ];
  if (sessionId) {
    const thread = new ThreadStore(opts.stateDir).get(sessionId);
    const pending = new ScheduleStore(opts.stateDir)
      .listForSession(sessionId)
      .filter((s) => !TERMINAL_STATUSES.has(s.status));
    lines.push(
      `- This thread: automatic resume after usage limits is ${thread?.autoResume ? "on" : "off"}; ${
        pending.length === 0
          ? "nothing is scheduled"
          : `${pending.length} scheduled ${pending.length === 1 ? "message" : "messages"} (list_scheduled_messages shows them)`
      }.`,
    );
  }
  return `${AGENT_GUIDE}\n${lines.join("\n")}\n`;
}

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isError && { isError: true }) };
}

export async function callTool(
  opts: McpOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const now = opts.now ?? Date.now;
  applySettings(opts.stateDir); // the user may have changed the time format since this server started
  const link = opts.link ? new LinkStore(opts.stateDir).get(opts.link) : undefined;
  if (name === "about_rewake") return text(aboutRewake(opts, link?.sessionId, now()));
  if (!link)
    return text(
      "Agent Rewake isn't linked to this conversation yet. Ask the user to reopen the thread.",
      true,
    );
  const schedules = new ScheduleStore(opts.stateDir);
  const requests = new RequestStore(opts.stateDir);
  const pending = () =>
    schedules.listForSession(link.sessionId).filter((s) => !TERMINAL_STATUSES.has(s.status));

  const exact = (t: number) => formatExact(t, opts.locale);
  const clockLine = () => `Current time: ${exact(now())}.`;
  const reason = () =>
    typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason.trim() } : {};
  const byNumber = () => {
    const n = Number(args.number);
    return Number.isInteger(n) && n >= 1 ? pending()[n - 1] : undefined;
  };
  /** The optional end of a repeat, or an error. */
  const ends = (): { until?: number; times?: number } | string => {
    const out: { until?: number; times?: number } = {};
    if (args.ends_after_runs !== undefined) {
      const n = Number(args.ends_after_runs);
      if (!Number.isInteger(n) || n < 1)
        return "`ends_after_runs` must be a whole number, 1 or more.";
      out.times = n;
    }
    if (typeof args.ends_at === "string" && args.ends_at.trim()) {
      const t = parseWhen(args.ends_at, now());
      if (!t.ok) return `ends_at: ${t.error}`;
      out.until = t.at;
    }
    return out;
  };
  /** One scheduled message, in full, for the agent. */
  const describe = (sid: string): string => {
    const list = pending();
    const i = list.findIndex((x) => x.scheduleId === sid);
    const s = list[i] ?? schedules.get(sid);
    if (!s) return "";
    const p = s.repeat ? parseCron(s.repeat.cron) : undefined;
    const end = [
      s.repeat?.remaining !== undefined
        ? `${s.repeat.remaining} run${s.repeat.remaining === 1 ? "" : "s"} left`
        : "",
      s.repeat?.until !== undefined ? `no runs after ${exact(s.repeat.until)}` : "",
    ].filter(Boolean);
    const repeat = p?.ok
      ? `Repeats: ${describeCron(p.cron)}${end.length ? ` (${end.join(", ")})` : " (until cancelled)"}`
      : "Once";
    const last = s.lastRun ? ` · Last run: ${s.lastRun.outcome}, due ${exact(s.lastRun.at)}` : "";
    const by =
      s.createdBy === "agent"
        ? "you asked, the user approved"
        : s.kind === "user"
          ? "the user"
          : "the user (resume after a usage limit)";
    return [
      `${i >= 0 ? `${i + 1}. ` : ""}Next: ${exact(s.dueAt)} · ${formatWhen(s.dueAt, now(), opts.locale)}`,
      `   Status: ${s.status} · ${repeat}${last} · Added by: ${by}`,
      `   Message: ${s.text}`,
    ].join("\n");
  };

  if (name === "list_scheduled_messages") {
    const list = pending();
    const recent = schedules
      .listForSession(link.sessionId)
      .filter((s) => TERMINAL_STATUSES.has(s.status) && now() - s.updatedAt < 24 * 3_600_000);
    const out = [clockLine()];
    out.push(
      list.length === 0
        ? "Nothing is scheduled in this conversation."
        : list.map((s) => describe(s.scheduleId)).join("\n"),
    );
    if (recent.length > 0)
      out.push(
        "Finished in the last 24 hours:",
        ...recent.map((s) => `- ${s.status}: due ${exact(s.dueAt)} · ${s.text}`),
      );
    return text(out.join("\n"));
  }

  /** The user's answer, plus what was saved, so the agent never guesses. */
  const settle = async (requestId: string): Promise<ToolResult> => {
    const r = await wait(opts, requests, requestId);
    if (r.status !== "approved") return text(`${r.text}\n${clockLine()}`, r.isError);
    const saved = r.scheduleId ? describe(r.scheduleId) : "";
    return text([r.text, saved && `As saved:\n${saved}`, clockLine()].filter(Boolean).join("\n"));
  };

  if (name === "schedule_message") {
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (!message) return text("Give the message to send.", true);
    const when = typeof args.when === "string" ? args.when.trim() : "";
    const cronText = typeof args.cron === "string" ? args.cron.trim() : "";
    if (!when === !cronText)
      return text("Give either `when` (once) or `cron` (repeating), not both.", true);
    const end = ends();
    if (typeof end === "string") return text(end, true);
    if (!cronText && (end.until !== undefined || end.times !== undefined))
      return text(
        "`ends_after_runs` and `ends_at` are only for repeating messages (`cron`).",
        true,
      );
    let dueAt: number;
    let cron: string | undefined;
    if (cronText) {
      const parsed = parseCron(cronText);
      if (!parsed.ok) return text(parsed.error, true);
      const first = nextRun(parsed.cron, now());
      if (first === undefined) return text(`"${cronText}" never runs.`, true);
      if (end.until !== undefined && first > end.until)
        return text(`It would never run: the first run, ${exact(first)}, is after ends_at.`, true);
      dueAt = first;
      cron = parsed.cron.source;
    } else {
      const parsed = parseWhen(when, now());
      if (!parsed.ok) return text(`${parsed.error} ${clockLine()}`, true);
      dueAt = parsed.at;
    }
    const same = (t: string) => t.trim().toLowerCase();
    const twin = pending().find((s) => same(s.text) === same(message));
    const r = requests.create({
      sessionId: link.sessionId,
      kind: "schedule",
      message,
      dueAt,
      ...(cron && { cron }),
      ...end,
      ...(twin && { duplicateOf: twin.scheduleId }),
      ...reason(),
      createdAt: now(),
    });
    return settle(r.requestId);
  }

  if (name === "update_scheduled_message") {
    const target = byNumber();
    if (!target)
      return text(
        `There's no scheduled message number ${args.number}. Use list_scheduled_messages.`,
        true,
      );
    const end = ends();
    if (typeof end === "string") return text(end, true);
    const change: Partial<AgentRequest> = { ...end };
    if (typeof args.message === "string" && args.message.trim())
      change.message = args.message.trim();
    if (typeof args.when === "string" && args.when.trim()) {
      const t = parseWhen(args.when, now());
      if (!t.ok) return text(`${t.error} ${clockLine()}`, true);
      change.dueAt = t.at;
    }
    if (typeof args.cron === "string" && args.cron.trim()) {
      const parsed = parseCron(args.cron);
      if (!parsed.ok) return text(parsed.error, true);
      if (change.dueAt !== undefined)
        return text(
          "Give either `when` or `cron`, not both: a new repeat sets its own next run.",
          true,
        );
      change.cron = parsed.cron.source;
    }
    if (args.stop_repeating === true) change.stopRepeating = true;
    if (typeof args.paused === "boolean") change.paused = args.paused;
    if (
      (change.until !== undefined || change.times !== undefined) &&
      !target.repeat &&
      change.cron === undefined
    )
      return text("That message doesn't repeat, so it has no end to set.", true);
    if (Object.keys(change).length === 0) return text("Give at least one thing to change.", true);
    const r = requests.create({
      sessionId: link.sessionId,
      kind: "update",
      scheduleId: target.scheduleId,
      ...change,
      ...reason(),
      createdAt: now(),
    });
    return settle(r.requestId);
  }

  if (name === "cancel_scheduled_message") {
    const target = byNumber();
    if (!target)
      return text(
        `There's no scheduled message number ${args.number}. Use list_scheduled_messages.`,
        true,
      );
    const r = requests.create({
      sessionId: link.sessionId,
      kind: "cancel",
      scheduleId: target.scheduleId,
      ...reason(),
      createdAt: now(),
    });
    return settle(r.requestId);
  }

  return text(`Unknown tool ${name}.`, true);
}

/** Wait for the user's answer, written by the Rewake process that owns the thread. */
async function wait(
  opts: McpOptions,
  requests: RequestStore,
  requestId: string,
): Promise<{
  status: AgentRequest["status"];
  text: string;
  scheduleId?: string;
  isError?: boolean;
}> {
  const deadline = Date.now() + (opts.timeoutMs ?? APPROVAL_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const r = requests.get(requestId);
    if (!r)
      return {
        status: "declined",
        text: "The request disappeared; nothing was changed.",
        isError: true,
      };
    if (r.status !== "pending") {
      requests.remove(requestId);
      return {
        status: r.status,
        text:
          r.answer ?? (r.status === "approved" ? "The user approved it." : "The user declined."),
        ...(r.scheduleId && r.kind !== "cancel" && { scheduleId: r.scheduleId }),
      };
    }
    await new Promise((res) => setTimeout(res, opts.pollMs ?? 500));
  }
  requests.remove(requestId);
  return {
    status: "declined",
    text: "The user didn't answer within 10 minutes, so nothing was changed.",
  };
}
