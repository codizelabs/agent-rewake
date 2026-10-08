import { randomUUID } from "node:crypto";
import { type FSWatcher, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonRpcId, JsonRpcMessage } from "./acp/ndjson.js";
import {
  type Action,
  CONSUME,
  FORWARD,
  type InFlightRequest,
  type Router,
  type RouterHooks,
} from "./acp/router.js";
import type { Classification, RateLimitInfo } from "./adapters/claude/limits.js";
import { claudeAutoContinueDisabled, resetFromTranscript } from "./adapters/claude/sources.js";
import {
  type AgentProfile,
  classifyLimit,
  classifyText,
  classifyTurnEnd,
  isSessionLost,
  type LimitClassification,
  parseResetHint,
  profileFor,
} from "./adapters/profiles.js";
import { normalize } from "./adapters/text.js";
import {
  COMMAND_NAME,
  parseRewake,
  type RewakeCommand,
  type RewakePlace,
  rewakeHelp,
  splitWhen,
} from "./core/command.js";
import { describeCron, nextRun, nextRuns, parseCron, runsPerDay } from "./core/cron.js";
import { SessionLock } from "./core/lock.js";
import {
  BRIDGED_MODE_ID,
  type Bridge,
  bridgeOptions,
  legacyRequest,
  withValue,
} from "./core/options-bridge.js";
import { type AgentRequest, LinkStore, RequestStore } from "./core/requests.js";
import { decideArm, decideFire, FAR_RESET_MS } from "./core/resume.js";
import { applySettings, type KeepAwake, loadSettings, saveSettings } from "./core/settings.js";
import { MAX_FOLLOW_UPS, type Schedule, ScheduleStore, TERMINAL_STATUSES } from "./core/store.js";
import { DEFAULT_RESUME_PROMPT, ThreadStore } from "./core/threads.js";
import { clockTime, formatClock, formatWhen, parseWhen, TEXT_LOCALE } from "./core/time.js";
import { introNote } from "./guide.js";
import { zedAgentSetting } from "./install.js";
import { phase1Hooks } from "./proxy.js";
import { overview, overviewMarkdown, STATUS_WORDS } from "./ui/overview.js";
import { rewake } from "./util/command.js";
import { type Wake, Wakefulness } from "./util/keep-awake.js";
import type { Logger } from "./util/log.js";
import { ensurePrivateDir } from "./util/paths.js";
import {
  readSleepSettings,
  SLEEP_DOCS_URL,
  type SleepSettings,
  sleepRisks,
} from "./util/sleep-settings.js";
import { REPO_URL, SUPPORT_URL, VERSION } from "./version.js";

/** Sign-in kinds the Claude and Codex adapters report in `_auth/status_update`. */
const AUTH_KINDS = new Set(["account", "api_key", "external", "gateway", "none"]);

/** The id of Rewake's menu in the thread toolbar. Zed saves the last pick under this key. */
export const MENU_CONFIG_ID = "rewake";

/** Actions in the Rewake menu in the thread toolbar. */
type MenuAction = "home" | "open" | "change" | "new" | "resume" | "auto" | "stop" | "settings";
const MENU_ACTIONS = new Set<string>([
  "home",
  "open",
  "change",
  "new",
  "resume",
  "auto",
  "stop",
  "settings",
]);

/** `/rewake` in an ACP thread (Zed and other clients): everything Rewake does is here. */
export const ACP_PLACE: RewakePlace = {
  name: "this thread",
  typed: `/${COMMAND_NAME}`,
  features: new Set([
    "messages",
    "repeat",
    "cancelOne",
    "auto",
    "stop",
    "items",
    "prompt",
    "page",
  ] as const),
};

/** What the person typed: `/rewake`, then its arguments. */
const REWAKE_TYPED = new RegExp(`^\\/${COMMAND_NAME}(?:\\s+([\\s\\S]*))?$`, "i");

// The grammar moved to the core, shared with every place Rewake runs; kept here for imports.
export { splitWhen };

/** Commands Rewake adds to every session. */
export const REWAKE_COMMANDS = [
  {
    name: COMMAND_NAME,
    description:
      "Agent Rewake: continue after usage limits, and schedule messages in this thread (/rewake help)",
    input: {
      hint: "<when> <message> | <when> | list | cancel [N|all] | auto on|off | stop | help",
    },
  },
];

/** The name of Rewake's tool server in the agent's MCP servers. */
export const AGENT_TOOLS_NAME = "agent-rewake";

/** Label sent ahead of a message the agent scheduled, so it knows the user didn't just type it. */
export const AGENT_SCHEDULED_LABEL =
  "[A message you scheduled earlier with Agent Rewake; the user approved it]";

/** Label sent to Claude ahead of an automatic resume, so it knows no human typed it (#88782). */
export const AUTO_LABEL = "[Sent automatically by Agent Rewake after the usage limit reset]";

export interface AddonOptions {
  stateDir: string;
  log: Logger;
  now?: () => number;
  /** How often to check for due messages. */
  heartbeatMs?: number;
  /** A message more than this late (e.g. Zed was closed) is marked missed, not sent. */
  missedGraceMs?: number;
  locale?: string;
  /**
   * Prefix the thread title with the schedule state. Default off:
   * thread names stay exactly as the agent set them, and the Rewake menu's label shows the state.
   */
  titleMarkers?: boolean;
  /**
   * How to start `agent-rewake` itself, for the agent's tool server (`agent-rewake mcp`). Without
   * it, the agent gets no Rewake tools.
   */
  selfCommand?: { command: string; args: string[] };
  /** Give the agent Rewake's tools (schedule, list, cancel; owner approval). Default true. */
  agentTools?: boolean;
  /** Zed's id for the wrapped agent (its `agent_servers` key), recorded per thread. */
  agentId?: string;
  /** The wrapped agent's name for people ("Claude Agent"); defaults to the agent's own title. */
  agentName?: string;
  /** Environment used to find Claude's settings and transcripts. */
  env?: NodeJS.ProcessEnv;
  /** Margin after the reset before resuming. */
  resumeMarginMs?: number;
  /** Random extra delay per thread, so several threads don't resume at the same instant. */
  jitterMs?: number;
  /** Release gate for remembered automatic resumes. Default true. */
  allowAutomaticResume?: boolean;
  /** Ask about automatic resume when a new thread opens. Default true. */
  askOnNewThreads?: boolean;
  /** The once-per-thread "How Rewake works" note. Default true. */
  firstUseNote?: boolean;
  /** Keeps the computer awake while a message is due (tests pass their own). */
  wake?: Wake;
  /** Reads this computer's own sleep settings (tests pass their own). */
  sleepSettings?: () => SleepSettings;
}

interface LimitEpisode {
  detectedAt: number;
  /** When this limit episode began (it can last through several resume attempts). */
  startedAt: number;
  resetAt: number | undefined;
  text: string;
  /** Automatic resumes sent in this limit window. */
  autoAttempts: number;
}

interface SessionState {
  sessionId: string;
  cwd: string;
  /** The client's session/prompt currently being answered by the agent, if any. */
  userTurn: JsonRpcId | undefined;
  userTurnStartedAt: number;
  /** The user's message is a slash command, which may be answered without the model. */
  userTurnCommand: boolean;
  /** A scheduled message currently being delivered (out of turn). */
  delivering: string | undefined;
  /** User prompts held back while a scheduled reply runs. */
  heldPrompts: JsonRpcMessage[];
  /** The adapter's own slash commands, so ours can be merged in. */
  agentCommands: unknown[];
  /** The agent's own title for the thread, restored when no marker applies. */
  baseTitle: string | undefined;
  /** The marker currently shown, if any. */
  marker: string | undefined;
  /** Claude's latest rate_limit_event, and when it arrived. */
  rateLimit: { info: RateLimitInfo; at: number } | undefined;
  /** When the current turn (the user's or a scheduled message's) started. */
  turnStartedAt: number;
  /**
   * The start of the agent's last message in the current turn. Several agents end a turn normally
   * and report a usage limit only as this message.
   */
  lastMessage: string;
  lastMessageId: string | undefined;
  /** How many chunks that message came in: agents write their own errors in one. */
  lastMessageChunks: number;
  /** The store has been checked for a resume left from an earlier limit. */
  resumesChecked: boolean;
  /** A limit some agents send as their own session update (Nova's `error`), for this turn. */
  turnError: { code: string; message: string } | undefined;
  /** The thread's permission mode, from the adapter's "mode" config option. */
  permissionMode: string | undefined;
  /** The current usage-limit episode, if any. */
  limit: LimitEpisode | undefined;
  /** An elicitation form is open, so another one isn't stacked on top. */
  formOpen: boolean;
  /** Rewake is asking the user about one of the agent's requests. */
  askingAgent: boolean;
  /** Params needed to re-open the session after the agent loses it (memory only: MCP config can hold secrets). */
  openParams: Record<string, unknown>;
  /** The agent lost this session (restart or "Session not found"); re-attach before the next prompt. */
  needsReattach: boolean;
  /**
   * The agent's own config options, or undefined if it has none. Zed shows either config options
   * or the older mode/model pickers, so Rewake adds its menu only next to the agent's own options.
   */
  agentOptions: unknown[] | undefined;
  /**
   * Set when the agent has only the older `modes`/`models`: Rewake shows them as toolbar options
   * and translates picks back.
   */
  bridge: Bridge | undefined;
  /**
   * Changes every time the session is opened. Menu values carry it, so a pick that Zed saved as
   * the agent's default (it saves every pick) is recognised as stale and never re-runs.
   */
  menuNonce: string;
  /** The config options last sent to Zed, so the menu is only re-sent when it changes. */
  menuSent: string | undefined;
  /** Drop history replayed by session/load during a re-attach: Zed already shows it. */
  suppressReplay: boolean;
  /** User prompt ids already retried once after a re-attach. */
  retried: Set<JsonRpcId>;
}

/**
 * The scheduling add-on: `/rewake`, the schedule store, a wall-clock scheduler and
 * out-of-turn delivery into the same session, plus resume after a usage
 * limit with the in-thread "Resume after the limit?" form.
 */
export class SchedulingAddon {
  private router: Router | undefined;
  private readonly store: ScheduleStore;
  private readonly threads: ThreadStore;
  private readonly lock: SessionLock;
  private readonly requests: RequestStore;
  /**
   * Scheduled messages whose text this process already showed in their thread. A retry within the
   * same run (for example after a usage limit, which also moves the due time) doesn't show the
   * same text again; a repeating message's next run starts with no attempts and is shown.
   */
  private readonly shown = new Set<string>();
  private readonly links: LinkStore;
  /** session/new request id → the token given to that session's tool server. */
  private readonly pendingLinks = new Map<string, string>();
  private requestWatcher: FSWatcher | undefined;
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;
  private readonly missedGraceMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private timer: NodeJS.Timeout | undefined;
  private watcher: FSWatcher | undefined;
  private watchDebounce: NodeJS.Timeout | undefined;
  private readonly initHooks = phase1Hooks();
  /** The keep-awake hold this process takes while one of its threads has a message due soon. */
  private readonly wake: Wake;
  /** Messages whose thread was told the computer is kept awake for them. */
  private readonly wakeAnnounced = new Set<string>();
  /** The one-time line about this computer's own sleep settings was shown. */
  private wakeUnsupportedSaid = false;
  /** This computer's sleep settings, read at most every ten minutes (it runs system commands). */
  private sleepRead: { at: number; settings: SleepSettings } | undefined;
  /** Claude-only extras: its rate-limit events, transcripts and own auto-continue setting. */
  private claudeAgent = false;
  /** How this agent reports a usage limit. */
  private profile: AgentProfile = "generic";
  /** The agent's last reported sign-in kind (`_auth/status_update`), logged when it changes. */
  private authKind: string | undefined;
  /** The agent refused a session with Rewake's tool server, so it isn't offered again (D1). */
  private toolsRefused = false;
  /**
   * Commands an agent announced before its session response arrived (deepagents does), kept until
   * the session is known so Rewake's own command update doesn't erase them.
   */
  private readonly earlyCommands = new Map<string, unknown[]>();
  private clientSupportsForms = false;
  private clientIsZed = false;
  /** The wrapped agent's name for status lines ("Claude", "Codex", …). */
  private agentName = "the agent";
  /** session/new|load|resume requests whose `_meta` Rewake extended, so raw SDK events can be told apart. */
  private clientWantsRawSdk = false;
  /** The client's initialize params, replayed to a restarted agent. */
  private clientInit: unknown;
  private agentCanResume = false;
  private agentCanLoad = false;
  /** Re-attach budget: at most 3 in 10 minutes. */
  private reattachTimes: number[] = [];

  constructor(private readonly opts: AddonOptions) {
    this.store = new ScheduleStore(opts.stateDir);
    this.threads = new ThreadStore(opts.stateDir);
    this.lock = new SessionLock(opts.stateDir);
    this.requests = new RequestStore(opts.stateDir);
    applySettings(opts.stateDir);
    this.links = new LinkStore(opts.stateDir);
    this.now = opts.now ?? Date.now;
    this.missedGraceMs = opts.missedGraceMs ?? 15 * 60_000;
    this.wake = opts.wake ?? new Wakefulness();
    this.env = opts.env ?? process.env;
  }

  attach(router: Router): void {
    this.router = router;
    this.timer = setInterval(() => this.tick(), this.opts.heartbeatMs ?? 30_000);
    this.timer.unref();
    // Edits from the schedules page or CLI take effect within a second (the heartbeat is the fallback).
    try {
      this.watcher = watch(ensurePrivateDir(this.store.dir), { persistent: false }, () => {
        if (this.watchDebounce) return;
        this.watchDebounce = setTimeout(() => {
          this.watchDebounce = undefined;
          this.tick();
          for (const s of this.sessions.values()) this.refreshMarker(s);
        }, 500);
        this.watchDebounce.unref();
      });
    } catch {
      // fs.watch isn't available everywhere; the heartbeat still picks changes up.
    }
    // The agent's requests need a quick answer: watch for them too (heartbeat as fallback).
    try {
      this.requestWatcher = watch(ensurePrivateDir(this.requests.dir), { persistent: false }, () =>
        setTimeout(() => this.processRequests(), 100).unref(),
      );
    } catch {
      // As above.
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watcher?.close();
    this.requestWatcher?.close();
    this.lock.releaseAll();
    this.wake.release();
  }

  hooks(): RouterHooks {
    return {
      onClientMessage: (m) => this.onClientMessage(m),
      onAgentMessage: (m) => this.onAgentMessage(m),
      onAgentResponse: (method, params, response) => this.onAgentResponse(method, params, response),
    };
  }

  // ---- client → agent -------------------------------------------------------------------------

  private onClientMessage(m: JsonRpcMessage): Action {
    if (m.method === "initialize") {
      this.clientInit = m.params;
      const p = asObject(m.params);
      const caps = asObject(p.clientCapabilities);
      this.clientSupportsForms = "form" in asObject(caps.elicitation);
      const name = asObject(p.clientInfo).name;
      this.clientIsZed = typeof name === "string" && /zed/i.test(name);
      return FORWARD;
    }
    if (
      m.method === "session/new" ||
      m.method === "session/load" ||
      m.method === "session/resume"
    ) {
      return this.prepareOpen(m);
    }
    if (m.method === "session/set_config_option") return this.onSetConfigOption(m);
    if (m.method !== "session/prompt" || m.id == null) return FORWARD;
    const params = asObject(m.params);
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return FORWARD;

    const text = promptText(params.prompt);
    const command = REWAKE_TYPED.exec(text.trim());
    if (command) {
      setImmediate(() => this.runCommand(session, m.id as JsonRpcId, command[1] ?? ""));
      return CONSUME;
    }
    if (session.delivering) {
      session.heldPrompts.push(m);
      this.status(
        session,
        `Rewake: Waiting. Your message will be sent when the scheduled reply finishes. ${this.stopHint(session, "To interrupt it")}`,
      );
      return CONSUME;
    }
    session.userTurn = m.id;
    session.userTurnStartedAt = this.now();
    session.userTurnCommand = text.trim().startsWith("/");
    this.startTurn(session);
    if (session.needsReattach) {
      void this.reattach(session).then((ok) => this.forwardAfterReattach(session, m, ok));
      return CONSUME;
    }
    return FORWARD;
  }

  /** Send a user prompt that was held for a re-attach, or fail it if the session couldn't be reopened. */
  private forwardAfterReattach(session: SessionState, m: JsonRpcMessage, ok: boolean): void {
    if (m.id == null) return;
    if (ok) {
      this.router?.forwardClientRequest(m);
      return;
    }
    session.userTurn = undefined;
    this.router?.respondToClient(m.id, { error: REATTACH_FAILED });
  }

  /**
   * Opening a session: add Rewake's tool server for the agent and, for Claude,
   * request raw rate-limit events.
   */
  private prepareOpen(m: JsonRpcMessage): Action {
    let params = asObject(m.params);
    let changed = false;
    if (this.claudeAgent) {
      const merged = this.withRateLimitEvents(params);
      if (merged !== params) {
        params = merged;
        changed = true;
      }
    }
    const tools =
      this.opts.agentTools !== false && !this.toolsRefused ? this.opts.selfCommand : undefined;
    if (tools && Array.isArray(params.mcpServers)) {
      const token = randomUUID();
      const known = typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (known) this.links.set(token, known, typeof params.cwd === "string" ? params.cwd : "");
      else if (m.id != null) this.pendingLinks.set(String(m.id), token);
      params = {
        ...params,
        mcpServers: [
          ...params.mcpServers.filter((s) => asObject(s).name !== AGENT_TOOLS_NAME),
          {
            name: AGENT_TOOLS_NAME,
            command: tools.command,
            args: [...tools.args, "mcp"],
            env: [
              { name: "AGENT_REWAKE_LINK", value: token },
              { name: "AGENT_REWAKE_STATE_DIR", value: this.opts.stateDir },
            ],
          },
        ],
      };
      changed = true;
    }
    return changed ? { kind: "replace", message: { ...m, params } } : FORWARD;
  }

  /**
   * Ask claude-agent-acp to also emit raw SDK `rate_limit_event`s, merged with anything the client
   * asked for itself.
   */
  private withRateLimitEvents(params: Record<string, unknown>): Record<string, unknown> {
    const meta = asObject(params._meta);
    const claudeCode = asObject(meta.claudeCode);
    const existing = claudeCode.emitRawSDKMessages;
    if (existing === true) {
      this.clientWantsRawSdk = true;
      return params;
    }
    if (Array.isArray(existing) && existing.length > 0) this.clientWantsRawSdk = true;
    const filters = [...(Array.isArray(existing) ? existing : []), { type: "rate_limit_event" }];
    return {
      ...params,
      _meta: { ...meta, claudeCode: { ...claudeCode, emitRawSDKMessages: filters } },
    };
  }

  // ---- agent → client -------------------------------------------------------------------------

  private onAgentMessage(m: JsonRpcMessage): Action {
    if (m.method === "_claude/sdkMessage") return this.onRawSdkMessage(m);
    if (m.method === "_auth/status_update") {
      // How the agent is signed in, for `doctor`: the kind only, never the account's email,
      // organisation or plan (claude-agent-acp 0.85.1 and codex-acp send this).
      const kind = asObject(m.params).kind;
      if (typeof kind === "string" && AUTH_KINDS.has(kind) && kind !== this.authKind) {
        this.authKind = kind;
        this.opts.log.info("agent.auth", { kind });
      }
      return FORWARD;
    }
    if (m.method !== "session/update") return FORWARD;
    const params = asObject(m.params);
    const update = asObject(params.update);
    const session =
      typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
    if (session?.suppressReplay) return CONSUME;
    if (session) this.trackTurn(session, update);

    if (update.sessionUpdate === "session_info_update" && typeof update.title === "string") {
      if (!session) return FORWARD;
      if (session.baseTitle !== update.title) {
        this.threads.update(
          session.sessionId,
          session.cwd,
          { title: update.title.slice(0, 200) },
          this.now(),
        );
      }
      session.baseTitle = update.title;
      if (!session.marker) return FORWARD;
      return replaceUpdate(m, params, { ...update, title: `${session.marker} · ${update.title}` });
    }
    if (update.sessionUpdate === "current_mode_update" && session?.bridge?.modes) {
      // The agent changed its own mode: show it in the Mode option Rewake made (Zed ignores
      // mode updates once a session has toolbar options, research Z-a).
      const modeId = typeof update.currentModeId === "string" ? update.currentModeId : undefined;
      if (!modeId || !this.menuEnabled(session)) return FORWARD;
      session.agentOptions = withValue(session.agentOptions ?? [], BRIDGED_MODE_ID, modeId);
      session.permissionMode = modeId;
      const configOptions = this.withMenu(session);
      session.menuSent = JSON.stringify(configOptions);
      return replaceUpdate(m, params, { sessionUpdate: "config_option_update", configOptions });
    }
    if (update.sessionUpdate === "config_option_update" && session) {
      session.permissionMode = modeFrom(update.configOptions) ?? session.permissionMode;
      if (!this.menuEnabled(session) || !Array.isArray(update.configOptions)) return FORWARD;
      session.agentOptions = update.configOptions;
      const configOptions = this.withMenu(session);
      session.menuSent = JSON.stringify(configOptions);
      return replaceUpdate(m, params, { ...update, configOptions });
    }
    if (update.sessionUpdate === "usage_update" && session) {
      const rate = asObject(asObject(update._meta)["_claude/rateLimit"]);
      if (rate.status !== undefined) session.rateLimit = { info: rate, at: this.now() };
      return FORWARD;
    }
    if (update.sessionUpdate !== "available_commands_update") return FORWARD;
    const agentCommands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
    if (session) session.agentCommands = agentCommands;
    else if (typeof params.sessionId === "string" && this.earlyCommands.size < 100)
      this.earlyCommands.set(params.sessionId, agentCommands);
    return replaceUpdate(m, params, { ...update, availableCommands: mergeCommands(agentCommands) });
  }

  private onRawSdkMessage(m: JsonRpcMessage): Action {
    const params = asObject(m.params);
    const message = asObject(params.message);
    const session =
      typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
    if (session && message.type === "rate_limit_event") {
      const info = asObject(message.rate_limit_info);
      if (info.status !== undefined) session.rateLimit = { info, at: this.now() };
    }
    return this.clientWantsRawSdk ? FORWARD : CONSUME;
  }

  private onAgentResponse(
    method: string,
    params: unknown,
    response: JsonRpcMessage,
  ): JsonRpcMessage | undefined | null {
    if (method === "initialize") {
      const result = asObject(response.result);
      const caps = asObject(result.agentCapabilities);
      this.agentCanLoad = caps.loadSession === true;
      this.agentCanResume = "resume" in asObject(caps.sessionCapabilities);
      const info = asObject(result.agentInfo);
      const wrapped = info.name;
      this.profile = profileFor(this.opts.agentId, wrapped);
      this.claudeAgent = this.profile === "claude";
      const title =
        typeof info.title === "string" && info.title
          ? info.title
          : (this.opts.agentName ?? wrapped);
      this.agentName = this.claudeAgent
        ? "Claude"
        : typeof title === "string" && title
          ? title
          : "the agent";
      return this.initHooks.onAgentResponse?.(method, params, response);
    }
    const p = asObject(params);
    if (method === "session/delete" && typeof p.sessionId === "string" && !response.error) {
      // The thread was deleted in Zed: its scheduled messages and settings go with it.
      this.forgetThread(p.sessionId);
      return undefined;
    }
    if (method === "session/set_config_option" && typeof p.sessionId === "string") {
      const session = this.sessions.get(p.sessionId);
      const result = asObject(response.result);
      const mode = modeFrom(result.configOptions);
      if (session && mode) session.permissionMode = mode;
      if (!session || !this.menuEnabled(session) || !Array.isArray(result.configOptions))
        return undefined;
      session.agentOptions = result.configOptions;
      const configOptions = this.withMenu(session);
      session.menuSent = JSON.stringify(configOptions);
      return { ...response, result: { ...result, configOptions } };
    }
    if (method === "session/new" || method === "session/load" || method === "session/resume") {
      // `p` is the client's own request; Rewake added its tool server on the way (prepareOpen).
      const ours =
        Array.isArray(p.mcpServers) &&
        this.opts.agentTools !== false &&
        !!this.opts.selfCommand &&
        !this.toolsRefused;
      if (response.error && ours && response.error.code !== -32000 && response.id != null) {
        // The agent may refuse an extra MCP server (Qwen: -32099): a session must never fail to
        // open because of Rewake, so try once without it.
        this.retryWithoutTools(method, p, response.id);
        return null;
      }
      const result = asObject(response.result);
      const sessionId =
        method === "session/new"
          ? typeof result.sessionId === "string"
            ? result.sessionId
            : undefined
          : typeof p.sessionId === "string"
            ? p.sessionId
            : undefined;
      const token = response.id != null ? this.pendingLinks.get(String(response.id)) : undefined;
      if (token) this.pendingLinks.delete(String(response.id));
      if (sessionId && response.error === undefined) {
        const cwd = typeof p.cwd === "string" ? p.cwd : "";
        if (token) this.links.set(token, sessionId, cwd);
        // A thread Rewake hasn't seen before, even one Zed reopens rather than creates: the
        // "on for new threads" setting applies to it as well.
        const firstSeen = this.threads.get(sessionId) === undefined;
        const session = this.openSession(sessionId, cwd, p, result);
        // Defer until the response itself has been written: Zed drops session updates for a
        // session it hasn't registered yet (zed#59281).
        setImmediate(() => {
          try {
            this.registerSession(session);
          } catch (err) {
            this.opts.log.error("session.register_failed", {
              code: (err as NodeJS.ErrnoException).code ?? "error",
            });
          }
          if (method === "session/new") {
            this.applyDefaultMode(session);
            void this.offerAutoOnNewThread(session);
          } else if (firstSeen) {
            void this.offerAutoOnNewThread(session, true);
          }
        });
        if (this.menuEnabled(session)) {
          const configOptions = this.withMenu(session);
          session.menuSent = JSON.stringify(configOptions);
          return { ...response, result: { ...result, configOptions } };
        }
      }
      return undefined;
    }
    if (method === "session/prompt" && typeof p.sessionId === "string") {
      const session = this.sessions.get(p.sessionId);
      if (!session || session.userTurn !== response.id) return undefined;
      if (
        response.error &&
        response.id != null &&
        isSessionLost(response.error) &&
        !session.retried.has(response.id)
      ) {
        // zed#55501: the agent lost the session. Re-attach and retry this message once.
        const id = response.id;
        const error = response.error;
        session.retried.add(id);
        session.needsReattach = true;
        void this.reattach(session).then((ok) => {
          if (ok) {
            this.router?.forwardClientRequest({
              jsonrpc: "2.0",
              id,
              method: "session/prompt",
              params,
            });
          } else {
            session.userTurn = undefined;
            this.router?.respondToClient(id, { error });
          }
        });
        return null;
      }
      session.userTurn = undefined;
      const classification = this.classifyTurn(session, response);
      let answer: JsonRpcMessage | undefined;
      if (classification?.kind === "usage_limit") {
        setImmediate(() => this.onUsageLimit(session, classification));
        if (response.error) {
          const shown =
            classification.shown ||
            (classification.text !== "" &&
              normalize(session.lastMessage).includes(normalize(classification.text)));
          answer = this.cleanError(session, response, classification, !shown);
        }
      } else if (
        classification?.kind === "not_recoverable" &&
        classification.reason === "billing"
      ) {
        setImmediate(() => this.onNotResumable(session));
      } else if (!response.error) {
        const stop = asObject(response.result).stopReason;
        setImmediate(() => this.onUserTurnSucceeded(session, stop === "end_turn"));
      }
      setImmediate(() => this.deliverDue(session));
      return answer;
    }
    return undefined;
  }

  /**
   * In Zed, the limit's text is shown as the agent's reply and the turn ends normally, instead of
   * as an error. A thread that shows an error is reloaded by Zed
   * whenever agent settings change (conversation_view.rs handle_agent_servers_updated, v1.22.0),
   * and every pick in the Rewake menu saves one (config_options.rs confirm), so the reload closed
   * the form the pick had just opened. Other clients keep the adapter's original error.
   */
  private cleanError(
    session: SessionState,
    response: JsonRpcMessage,
    c: Classification,
    echo = true,
  ): JsonRpcMessage | undefined {
    if (!this.clientIsZed || !response.error) return undefined;
    // Agents that already wrote the limit as their last message don't need it twice.
    if (echo)
      this.router?.notifyClient("session/update", {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: randomUUID(),
          content: { type: "text", text: c.text },
        },
      });
    return { jsonrpc: "2.0", id: response.id ?? null, result: { stopReason: "end_turn" } };
  }

  /** Remove everything Rewake keeps for a thread that no longer exists. */
  private forgetThread(sessionId: string): void {
    const schedules = this.store.listForSession(sessionId);
    for (const s of schedules) this.store.remove(s.scheduleId);
    this.threads.remove(sessionId);
    this.sessions.delete(sessionId);
    this.lock.release(sessionId);
    this.opts.log.info("thread.deleted", { schedules: schedules.length });
  }

  /** Record which agent the thread belongs to, for the schedules page (only when it changes). */
  private rememberAgent(session: SessionState): void {
    const agentId = this.opts.agentId;
    const agentName =
      this.opts.agentName ?? (this.agentName === "the agent" ? undefined : this.agentName);
    const known = this.threads.get(session.sessionId);
    if (known && known.agentId === agentId && known.agentName === agentName) return;
    this.threads.update(
      session.sessionId,
      session.cwd,
      { ...(agentId && { agentId }), ...(agentName && { agentName }) },
      this.now(),
    );
  }

  private retryWithoutTools(method: string, p: Record<string, unknown>, id: JsonRpcId): void {
    const router = this.router;
    if (!router) return;
    const without = {
      ...p,
      mcpServers: (p.mcpServers as unknown[]).filter((s) => asObject(s).name !== AGENT_TOOLS_NAME),
    };
    void router.requestAgent(method, without).then((r) => {
      if (!r.error) {
        this.toolsRefused = true;
        this.opts.log.info("agent_tools.refused", {
          method,
          agent: this.opts.agentId ?? "agent",
        });
      }
      const answered = this.onAgentResponse(method, without, { ...r, id }) ?? { ...r, id };
      router.respondToClient(
        id,
        answered.error ? { error: answered.error } : { result: answered.result },
      );
    });
  }

  /** Create or refresh the session's state when the agent opens it (new, load or resume). */
  private openSession(
    sessionId: string,
    cwd: string,
    openParams: Record<string, unknown>,
    result: Record<string, unknown>,
  ): SessionState {
    const { options, bridge } = bridgeOptions(result);
    const mode = modeFrom(options);
    const existing = this.sessions.get(sessionId);
    const session: SessionState = existing ?? {
      sessionId,
      cwd,
      userTurn: undefined,
      userTurnStartedAt: 0,
      userTurnCommand: false,
      delivering: undefined,
      heldPrompts: [],
      agentCommands: [],
      baseTitle: undefined,
      marker: undefined,
      rateLimit: undefined,
      turnStartedAt: 0,
      lastMessage: "",
      lastMessageId: undefined,
      lastMessageChunks: 0,
      resumesChecked: false,
      turnError: undefined,
      permissionMode: mode,
      limit: undefined,
      formOpen: false,
      askingAgent: false,
      openParams,
      agentOptions: undefined,
      bridge: undefined,
      menuNonce: "",
      menuSent: undefined,
      needsReattach: false,
      suppressReplay: false,
      retried: new Set(),
    };
    if (mode) session.permissionMode = mode;
    session.openParams = openParams;
    session.needsReattach = false;
    session.agentOptions = options;
    session.bridge = bridge;
    const early = this.earlyCommands.get(sessionId);
    if (early) {
      session.agentCommands = early;
      this.earlyCommands.delete(sessionId);
    }
    session.menuNonce = randomUUID().slice(0, 8);
    session.menuSent = undefined;
    this.sessions.set(sessionId, session);
    return session;
  }

  private registerSession(session: SessionState): void {
    const sessionId = session.sessionId;
    this.rememberAgent(session);
    const owned = this.lock.acquire(sessionId);
    this.opts.log.info("session.registered", { owned });
    const sendCommands = () =>
      this.router?.notifyClient("session/update", {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: mergeCommands(session.agentCommands),
        },
      });
    sendCommands();
    // Zed can drop updates that arrive before it has registered the session (zed#59281), and then
    // rejects /rewake as unknown: send them once more a moment later.
    const again = setTimeout(() => {
      if (this.sessions.get(sessionId) === session) sendCommands();
    }, COMMANDS_RESEND_MS);
    again.unref?.();
    if (owned) this.deliverDue(session);
    this.refreshMarker(session);
  }

  // ---- re-attach -------------------------------------------------------

  /**
   * Re-open a session the agent lost, under the same id, so Zed's thread never notices. Prefers
   * `session/resume` (no history replay); falls back to `session/load` and drops the replay.
   */
  async reattach(session: SessionState): Promise<boolean> {
    const router = this.router;
    if (!router) return false;
    const now = this.now();
    this.reattachTimes = this.reattachTimes.filter((t) => now - t < 10 * 60_000);
    const method = this.agentCanResume
      ? "session/resume"
      : this.agentCanLoad
        ? "session/load"
        : undefined;
    if (!method || this.reattachTimes.length >= 3) {
      this.opts.log.warn("reattach.unavailable", {
        method: method ?? "none",
        recent: this.reattachTimes.length,
      });
      return false;
    }
    this.reattachTimes.push(now);
    const p = session.openParams;
    const params: Record<string, unknown> = {
      sessionId: session.sessionId,
      cwd: typeof p.cwd === "string" ? p.cwd : session.cwd,
      mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers : [],
      ...(p.additionalDirectories !== undefined && {
        additionalDirectories: p.additionalDirectories,
      }),
      ...(this.claudeAgent && {
        _meta: { claudeCode: { emitRawSDKMessages: [{ type: "rate_limit_event" }] } },
      }),
    };
    session.suppressReplay = method === "session/load";
    const response = await router.requestAgent(method, params);
    session.suppressReplay = false;
    const ok = response.error === undefined;
    session.needsReattach = !ok;
    this.opts.log.info("reattach.done", { method, ok });
    return ok;
  }

  /**
   * The agent process was replaced: replay the client's initialize, mark every
   * session for re-attach, and retry user messages that were in flight once.
   */
  async onAgentRestarted(inFlight: InFlightRequest[]): Promise<void> {
    const router = this.router;
    if (!router) return;
    for (const s of this.sessions.values()) {
      s.needsReattach = true;
      s.delivering = undefined;
    }
    const init = await router.requestAgent("initialize", this.clientInit ?? { protocolVersion: 1 });
    if (init.error) this.opts.log.error("restart.initialize_failed", { code: init.error.code });
    for (const req of inFlight) {
      const p = asObject(req.params);
      const session = typeof p.sessionId === "string" ? this.sessions.get(p.sessionId) : undefined;
      if (req.method === "session/prompt" && session && !session.retried.has(req.id)) {
        session.retried.add(req.id);
        const m: JsonRpcMessage = {
          jsonrpc: "2.0",
          id: req.id,
          method: req.method,
          params: req.params,
        };
        void this.reattach(session).then((ok) => this.forwardAfterReattach(session, m, ok));
      } else {
        router.respondToClient(req.id, {
          error: {
            code: -32603,
            message: "The agent restarted. Please try again.",
            data: { details: "The agent restarted. Please try again." },
          },
        });
      }
    }
  }

  // ---- usage limits -------------------------------------------------------------

  /** A new turn: forget the last turn's closing message and agent-reported error. */
  private startTurn(session: SessionState): void {
    session.turnStartedAt = this.now();
    session.lastMessage = "";
    session.lastMessageId = undefined;
    session.lastMessageChunks = 0;
    session.turnError = undefined;
  }

  /** Keep the start of the agent's latest message in this turn, and reset it when work follows. */
  private trackTurn(session: SessionState, update: Record<string, unknown>): void {
    if (session.userTurn === undefined && session.delivering === undefined) return;
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const content = asObject(update.content);
      if (content.type !== "text" || typeof content.text !== "string") return;
      const id = typeof update.messageId === "string" ? update.messageId : undefined;
      if (id !== session.lastMessageId) {
        session.lastMessage = "";
        session.lastMessageId = id;
        session.lastMessageChunks = 0;
      }
      session.lastMessageChunks += 1;
      const room = MESSAGE_KEPT - session.lastMessage.length;
      if (room > 0) {
        // A slice of a large chunk would keep the whole chunk in memory: copy the part kept.
        const part =
          content.text.length > room
            ? Buffer.from(content.text.slice(0, room)).toString()
            : content.text;
        session.lastMessage += part;
      }
    } else if (
      kind === "tool_call" ||
      kind === "tool_call_update" ||
      kind === "user_message_chunk" ||
      kind === "plan"
    ) {
      session.lastMessage = "";
      session.lastMessageId = undefined;
      session.lastMessageChunks = 0;
    } else if (kind === "error" && typeof update.errorCode === "string") {
      session.turnError = {
        code: update.errorCode,
        message: typeof update.message === "string" ? update.message : update.errorCode,
      };
    }
  }

  /**
   * How a turn ended, as far as limits go: from the error if there is one, and otherwise (or when
   * the error says nothing) from what the agent reported in its last message or its own fields.
   */
  private classifyTurn(
    session: SessionState,
    response: JsonRpcMessage,
  ): (LimitClassification & { shown?: boolean }) | undefined {
    const now = this.now();
    const rate = session.rateLimit;
    const rateLimit =
      this.claudeAgent && rate && rate.at >= session.turnStartedAt - 1000 ? rate.info : undefined;
    if (response.error) {
      const c = classifyLimit(this.profile, response.error, now, { rateLimit });
      if (c.kind !== "other") return c;
      const shown = classifyTurnEnd(
        this.profile,
        session.lastMessage,
        "error",
        now,
        session.lastMessageChunks,
      );
      return shown ? { ...shown, shown: true } : c;
    }
    const result = asObject(response.result);
    const fromText = classifyTurnEnd(
      this.profile,
      session.lastMessage,
      result.stopReason,
      now,
      session.lastMessageChunks,
    );
    if (fromText) return fromText;
    // Nova reports its token quota as a session update of its own.
    if (session.turnError?.code === "TOKEN_LIMIT_EXCEEDED")
      return { kind: "usage_limit", text: session.turnError.message, limitType: "other" };
    const meta = asObject(result._meta);
    const acts = (c: LimitClassification) =>
      c.kind === "usage_limit" || (c.kind === "not_recoverable" && c.reason === "billing");
    // DimCode ends a failed turn with "refusal" and the error in its result's metadata.
    const dim = asObject(asObject(meta.dimcode).error);
    if (result.stopReason === "refusal" && Object.keys(dim).length > 0) {
      const text = typeof dim.message === "string" ? dim.message : String(dim.reason ?? "");
      const reason = typeof dim.reason === "string" ? dim.reason : "";
      if (reason === "window_rate_limit_reached" || reason === "feature_quota_exhausted")
        return { kind: "usage_limit", text, limitType: "other" };
      if (/^insufficient_|^member_credit_limit_reached$/.test(reason))
        return { kind: "not_recoverable", text, reason: "billing" };
      const c = classifyText(text, now);
      if (acts(c)) return c;
    }
    // Harn's agent loop ends a failed turn normally, with its error class in the metadata.
    const terminal = asObject(asObject(meta.harn).terminal);
    if (typeof terminal.terminalClass === "string") {
      const c = classifyLimit(
        this.profile,
        {
          code: -32603,
          message: typeof terminal.message === "string" ? terminal.message : "",
          data: { terminalClass: terminal.terminalClass },
        },
        now,
      );
      if (acts(c)) return c;
    }
    return undefined;
  }

  /** The agent stopped at a limit that waiting won't fix: say so, rather than nothing. */
  private onNotResumable(session: SessionState): void {
    this.status(
      session,
      `Rewake: Not resuming. ${capitalize(this.agentName)} stopped at a credit, billing or spending limit, which waiting won't fix.`,
    );
  }

  private resolveReset(
    session: SessionState,
    text: string,
    since: number,
    hint?: number,
  ): number | undefined {
    const now = this.now();
    const sane = (t: number | undefined) =>
      t !== undefined && Number.isFinite(t) && t > now - 10 * 60_000 && t < now + 8 * 86_400_000
        ? t
        : undefined;
    if (!this.claudeAgent) return sane(hint) ?? sane(parseResetHint(text, now));
    const rate = session.rateLimit;
    if (
      rate &&
      rate.at >= since - 1000 &&
      rate.info.status === "rejected" &&
      typeof rate.info.resetsAt === "number"
    ) {
      const t = sane(rate.info.resetsAt * 1000);
      if (t !== undefined) return t;
    }
    const fromTranscript = sane(
      resetFromTranscript(this.env, session.cwd, session.sessionId, since)?.resetAt,
    );
    if (fromTranscript !== undefined) return fromTranscript;
    return sane(hint) ?? sane(parseResetHint(text, now));
  }

  private onUsageLimit(
    session: SessionState,
    c: Extract<LimitClassification, { kind: "usage_limit" }>,
  ): void {
    const now = this.now();
    const resetAt = this.resolveReset(session, c.text, session.userTurnStartedAt || now, c.resetAt);
    const previous = session.limit;
    session.limit = {
      detectedAt: now,
      startedAt: previous?.startedAt ?? now,
      resetAt,
      text: c.text,
      autoAttempts: previous && previous.resetAt === resetAt ? previous.autoAttempts : 0,
    };
    this.opts.log.info("limit.detected", {
      limitType: c.limitType,
      resetKnown: resetAt !== undefined,
    });
    const resumes = this.pending(session).filter((s) => s.kind !== "user");
    const live = resumes.find((s) => LIVE_RESUME.has(s.status));
    if (live) {
      // Another limit with a sooner reset (Sonnet's 5 hours after Opus's week): resume then.
      const sooner = resetAt === undefined ? undefined : this.resumeAt(resetAt);
      if (live.status === "scheduled" && sooner !== undefined && sooner < live.dueAt - 60_000) {
        this.store.update(live.scheduleId, (x) => ({ ...x, dueAt: Math.max(now, sooner) }), now);
        this.refreshMarker(session);
        this.status(
          session,
          `Rewake: Moved the resume from ${formatWhen(live.dueAt, now, this.opts.locale)} to ${formatWhen(sooner, now, this.opts.locale)}, just after this limit resets.`,
        );
        return;
      }
      this.status(
        session,
        `Rewake: A resume is already scheduled for this thread. ${this.manageHint(session)}`,
      );
      return;
    }
    // A resume that was missed or is waiting for an answer belongs to an older limit: this one
    // replaces it.
    for (const s of resumes)
      if (s.status === "missed" || s.status === "needs_attention")
        this.store.cancel(s.scheduleId, now);
    const thread = this.threads.get(session.sessionId);
    const gate = this.autoGate(session, resetAt);
    // The shared rules decide (src/core/resume.ts): billing never, a reset a day away is asked
    // about, no reset time waits the time last chosen in the resume form (C2).
    const delay = thread?.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS;
    const decision = decideArm({
      now,
      ...(resetAt !== undefined && { resetsAt: resetAt }),
      isBilling: false,
      auto: thread?.autoResume && gate === undefined ? "always" : "ask",
      noResetDelayMs: delay,
    });
    // A reset that has already passed: resume now (the add-on's own timing rounds it up).
    const passed = decision.action === "none" && decision.why === "passed";
    if (thread?.autoResume && gate === undefined && (decision.action === "arm" || passed)) {
      if (resetAt === undefined) session.limit.resetAt = now + delay - this.margin();
      this.scheduleResume(
        session,
        "auto_limit_resume",
        this.threads.resumePrompt(session.sessionId),
        "auto",
      );
      return;
    }
    if (thread?.autoResume && gate) {
      this.status(session, `Rewake: Not resuming automatically this time: ${gate}`);
    }
    void this.offerResume(session);
  }

  /** Why a remembered automatic resume may not run, or undefined if it may. */
  private autoGate(session: SessionState, resetAt: number | undefined): string | undefined {
    if (this.opts.allowAutomaticResume === false)
      return "automatic resume is turned off in Agent Rewake's settings.";
    if (this.claudeAgent && claudeAutoContinueDisabled(this.env, session.cwd)) {
      return 'your Claude setting "Continue automatically at usage limit" is off.';
    }
    if (
      isBypassMode(session.permissionMode) &&
      !loadSettings(this.opts.stateDir).autoWhenPromptsSkipped
    ) {
      return "this thread bypasses permissions, and your setting excludes those threads.";
    }
    if (resetAt === undefined) {
      const delay = this.threads.get(session.sessionId)?.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS;
      const started = session.limit?.startedAt ?? this.now();
      if (this.now() + delay - started > 24 * 3_600_000)
        return "the limit has lasted almost a day, so Rewake won't keep trying on its own.";
      return undefined;
    }
    if (resetAt - this.now() > FAR_RESET_MS) return "the limit resets more than 24 hours from now.";
    if ((session.limit?.autoAttempts ?? 0) >= 1)
      return `${capitalize(this.agentName)} gave the same reset time as last time, so resuming again would repeat itself.`;
    return undefined;
  }

  /** The "Resume after the limit?" form, or a text fallback if forms aren't supported. */
  private async offerResume(session: SessionState): Promise<void> {
    const limit = session.limit;
    if (!limit) return;
    if (session.formOpen) {
      // Another Rewake question is open; one form at a time, so this one is a line.
      const how = this.menuEnabled(session)
        ? 'pick "Resume after the usage limit…" in the Rewake menu under the message box.'
        : "type /rewake.";
      this.status(
        session,
        `Rewake: ${capitalize(this.agentName)} hit its usage limit${
          limit.resetAt !== undefined
            ? `; it resets at ${formatWhen(limit.resetAt, this.now(), this.opts.locale)}`
            : ""
        }. To resume when it resets, ${how}`,
      );
      return;
    }
    const waiting = this.pending(session).find((s) => s.kind !== "user");
    if (waiting) return this.addAfterResume(session, waiting);
    const now = this.now();
    const prompt = this.threads.resumePrompt(session.sessionId);
    const agent = capitalize(this.agentName);
    const when =
      limit.resetAt !== undefined
        ? `It resets at ${formatWhen(limit.resetAt, now, this.opts.locale)}. Resume this thread when it resets?`
        : "It didn't say when the limit resets. When should Rewake resume this thread?";
    const message = `${agent} hit its usage limit. ${when}`;
    const router = this.router;
    if (!router || !this.clientSupportsForms) {
      this.status(
        session,
        limit.resetAt !== undefined
          ? `Rewake: Stopped at ${this.agentName}'s usage limit. ${when} Type /rewake to schedule it.`
          : `Rewake: Stopped at ${this.agentName}'s usage limit, and it didn't say when the limit resets. To resume later, type a time, for example /rewake 3:30pm or /rewake in 1h.`,
      );
      return;
    }
    const properties: Record<string, unknown> = {
      // One decision per form: automatic resume is its own menu entry.
      prompt: { type: "string", title: "Message to send", default: prompt },
    };
    if (limit.resetAt === undefined) {
      // No reset time: pick when, from presets, each with its actual time.
      properties.when = {
        type: "string",
        title: "Resume",
        oneOf: [
          ...UNKNOWN_RESET_DELAYS.map(([ms, label]) => ({
            const: String(ms),
            title: `${label} (${formatWhen(now + ms, now, this.opts.locale)})`,
          })),
          // Free entry only on request, as a next step.
          { const: "custom", title: "Custom time…" },
        ],
        default: String(UNKNOWN_RESET_DELAYS[1]?.[0]),
      };
    }
    session.formOpen = true;
    const response = await router.requestClient("elicitation/create", {
      sessionId: session.sessionId,
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties,
        required: limit.resetAt === undefined ? ["prompt", "when"] : ["prompt"],
      },
    });
    session.formOpen = false;
    const result = asObject(response.result);
    if (result.action !== "accept") {
      // Zed answers "cancel" by itself when the form is closed without a choice (Stop, a new
      // message, the thread closed: acp_thread.rs cancel_outstanding_elicitations, v1.22.0).
      // That isn't the person declining, so say what happened rather than "Not scheduled".
      const closed = result.action === "cancel" || response.error !== undefined;
      const how = this.menuEnabled(session)
        ? 'pick "Resume after the usage limit…" in the Rewake menu.'
        : "type /rewake.";
      this.status(
        session,
        closed
          ? `Rewake: The resume question was closed before you answered. To resume when the limit resets, ${how}`
          : `Rewake: Not scheduled. To resume later, ${how}`,
      );
      return;
    }
    const content = asObject(result.content);
    const text =
      typeof content.prompt === "string" && content.prompt.trim() ? content.prompt.trim() : prompt;
    const delay = limit.resetAt === undefined ? Number(content.when) : undefined;
    const validDelay =
      delay !== undefined && UNKNOWN_RESET_DELAYS.some(([ms]) => ms === delay) ? delay : undefined;
    // The message and the wait chosen here are what automatic resume uses later in this thread.
    if (text !== prompt || validDelay) {
      this.threads.update(
        session.sessionId,
        session.cwd,
        { resumePrompt: text, ...(validDelay && { resumeDelayMs: validDelay }) },
        this.now(),
      );
    }
    if (limit.resetAt === undefined) {
      if (content.when === "custom") {
        const custom = await this.askCustomTime(session);
        if (!custom) return;
        limit.resetAt = custom.first - this.margin();
      } else if (!validDelay) {
        this.status(session, "Rewake: Not scheduled. Pick when to resume, then submit.");
        return;
      } else {
        limit.resetAt = this.now() + validDelay - this.margin();
      }
    }
    this.scheduleResume(session, "limit_resume", text, "form");
  }

  /**
   * A resume is already scheduled: say so, and take one more message to send after it. Like
   * Zed's own queue, each message goes when the reply before it finishes. Zed's queue itself only takes what's typed in its message box, so Rewake keeps
   * this list: ACP has no way to add to it (thread_view.rs add_to_queue, v1.22.0).
   */
  private async addAfterResume(session: SessionState, resume: Schedule): Promise<void> {
    const now = this.now();
    const then = resume.followUps ?? [];
    if (then.length >= MAX_FOLLOW_UPS) {
      this.status(
        session,
        `Rewake: A resume is already scheduled, with ${MAX_FOLLOW_UPS} messages after it. That's the most Rewake keeps.`,
      );
      return;
    }
    const after =
      then.length === 0
        ? ""
        : `, followed by ${then.length === 1 ? "1 more message" : `${then.length} more messages`}`;
    const content = await this.form(
      session,
      `A resume is already scheduled for ${formatWhen(resume.dueAt, now, this.opts.locale)}: "${preview(resume.text)}"${after}. Add a message to send after ${then.length === 0 ? "it" : "them"}? Each is sent when the reply before it finishes.`,
      { message: { type: "string", title: "Message to send next", minLength: 1 } },
      ["message"],
    );
    const text = String(content?.message ?? "").trim();
    if (!content) return;
    if (!text) {
      this.status(session, "Rewake: Nothing added. Type a message, then submit.");
      return;
    }
    const updated = this.store.update(
      resume.scheduleId,
      (x) => ({ ...x, followUps: [...(x.followUps ?? []), text].slice(0, MAX_FOLLOW_UPS) }),
      this.now(),
    );
    if (!updated) {
      this.status(session, "Rewake: Nothing added. The resume isn't scheduled any more.");
      return;
    }
    const n = updated.followUps?.length ?? 0;
    this.status(
      session,
      n === 1
        ? "Rewake: Added. Rewake sends it when the resume's reply finishes."
        : `Rewake: Added. After the resume, Rewake sends ${n} more messages, one at a time, each when the previous reply finishes.`,
    );
    this.refreshMarker(session);
  }

  /**
   * The resume didn't run its course (stopped, or the person continued by hand): the messages
   * waiting after it are kept, paused, as one entry, never dropped. Returns the
   * sentence that says so, or "".
   */
  private keepFollowUps(session: SessionState, s: Schedule | undefined): string {
    const [first, ...rest] = s?.followUps ?? [];
    if (!s || !first) return "";
    const now = this.now();
    this.store.update(s.scheduleId, ({ followUps: _kept, ...x }) => x, now);
    const kept = this.store.create({
      sessionId: session.sessionId,
      cwd: session.cwd,
      text: first,
      dueAt: now,
      createdBy: s.createdBy,
      now,
      followUps: rest,
    });
    this.store.update(kept.scheduleId, (x) => ({ ...x, status: "paused" }), now);
    const what =
      rest.length === 0
        ? "The message after it is"
        : `The ${rest.length + 1} messages after it are`;
    return ` ${what} paused. To send ${rest.length === 0 ? "it" : "them"}, ${
      this.menuEnabled(session)
        ? 'pick "Change a scheduled message…" in the Rewake menu and resume the paused entry.'
        : "type /rewake list, then /rewake resume N."
    }`;
  }

  private margin(): number {
    return this.opts.resumeMarginMs ?? 60_000;
  }

  private resumeAt(resetAt: number): number {
    return resetAt + this.margin();
  }

  private scheduleResume(
    session: SessionState,
    kind: "limit_resume" | "auto_limit_resume",
    text: string,
    createdBy: Schedule["createdBy"],
  ): void {
    const limit = session.limit;
    if (!limit || limit.resetAt === undefined) return;
    const now = this.now();
    const jitter = Math.floor(Math.random() * (this.opts.jitterMs ?? 20_000));
    const dueAt = Math.max(now, this.resumeAt(limit.resetAt) + jitter);
    if (kind === "auto_limit_resume") limit.autoAttempts += 1;
    session.resumesChecked = false;
    this.store.create({
      sessionId: session.sessionId,
      cwd: session.cwd,
      text,
      dueAt,
      kind,
      createdBy,
      now,
    });
    this.opts.log.info("limit.resume_scheduled", { kind, dueAt });
    this.introOnce(session);
    this.status(
      session,
      kind === "auto_limit_resume"
        ? `Rewake: This thread will resume when the limit resets (${formatWhen(limit.resetAt, now, this.opts.locale)}), automatically for this thread. ${
            this.menuEnabled(session)
              ? "To cancel it, use the Rewake menu under the message box."
              : "To cancel it, type /rewake cancel."
          }`
        : `Rewake: This thread will resume when the limit resets (${formatWhen(limit.resetAt, now, this.opts.locale)}). ${
            this.menuEnabled(session)
              ? "To change or cancel it, use the Rewake menu under the message box."
              : "To cancel it, type /rewake cancel."
          }`,
    );
    this.refreshMarker(session);
  }

  /** The user continued by hand after the reset: drop pending resumes for that limit. */
  private onUserTurnSucceeded(session: SessionState, answered: boolean): void {
    const limit = session.limit;
    // Claude says the limit is lifted before its reset: another account, another model, or bought
    // usage. The resume scheduled for the old reset would only interrupt the work later. This
    // holds after a restart too, when Rewake no longer remembers the limit itself. Other agents
    // say nothing of the kind, so their full answer (not a stopped turn) to a message that isn't a
    // slash command (a command may be answered without the model) is taken as the same sign.
    const rate = session.rateLimit;
    const lifted = this.claudeAgent
      ? rate !== undefined &&
        rate.at >= session.turnStartedAt - 1000 &&
        (rate.info.status === "allowed" || rate.info.status === "allowed_warning")
      : answered && !session.userTurnCommand;
    if (!lifted && (!limit || limit.resetAt === undefined || this.now() < limit.resetAt)) return;
    // Claude says "allowed" on most turns: look for an old resume once, not on every turn.
    if (!limit && session.resumesChecked) return;
    session.resumesChecked = true;
    session.limit = undefined;
    const resumes = this.pending(session).filter(
      (s) => s.kind !== "user" && s.status !== "sending" && s.createdAt < session.turnStartedAt,
    );
    for (const s of resumes) this.store.cancel(s.scheduleId, this.now());
    if (resumes.length > 0) {
      const kept = resumes.map((s) => this.keepFollowUps(session, s)).join("");
      this.status(
        session,
        `Rewake: Cancelled the scheduled resume, because you've already continued this thread.${kept}`,
      );
      this.refreshMarker(session);
    }
  }

  // ---- the Rewake menu and forms --------------------------------

  /** The menu needs the agent's own config options (see `agentOptions`) and Zed's forms. */
  private menuEnabled(session: SessionState): boolean {
    return session.agentOptions !== undefined && this.clientSupportsForms;
  }

  /** The agent's config options plus Rewake's menu, always showing its "home" entry. */
  private withMenu(session: SessionState): unknown[] {
    const theirs = (session.agentOptions ?? []).filter((o) => asObject(o).id !== MENU_CONFIG_ID);
    return [...theirs, this.menuOption(session)];
  }

  private menuOption(session: SessionState): Record<string, unknown> {
    const value = (a: MenuAction) => `${session.menuNonce}.${a}`;
    const pending = this.pending(session);
    // A short, near-constant label: a longer one ("Rewake · Scheduled 03:19 PM") made Zed wrap the
    // toolbar and pull the send button off the edge.
    const options = [
      { value: value("home"), name: pending.length > 0 ? `Rewake (${pending.length})` : "Rewake" },
    ];
    if (session.delivering)
      options.push({ value: value("stop"), name: "Stop the scheduled reply" });
    // Picked again while a resume is waiting, it adds messages to send after it.
    if (session.limit)
      options.push({
        value: value("resume"),
        name: pending.some((s) => s.kind !== "user")
          ? "Add a message after the resume…"
          : "Resume after the usage limit…",
      });
    options.push({ value: value("open"), name: "Schedules" });
    options.push({ value: value("new"), name: "Schedule a message…" });
    if (pending.length > 0)
      options.push({ value: value("change"), name: "Change a scheduled message…" });
    {
      const auto = this.threads.get(session.sessionId)?.autoResume === true;
      options.push({
        value: value("auto"),
        name: auto ? "Turn off auto-resume after limits" : "Turn on auto-resume after limits…",
      });
    }
    options.push({ value: value("settings"), name: "Settings…" });
    return {
      id: MENU_CONFIG_ID,
      name: "Rewake",
      // Zed shows the description in the menu's hover tooltip, so the version fits there.
      description: `Agent Rewake ${VERSION}: schedule messages in this thread`,
      category: "_rewake",
      type: "select",
      currentValue: value("home"),
      options,
    };
  }

  /** Re-send the config options when Rewake's menu changed (new schedule, running, limit…). */
  private refreshMenu(session: SessionState): void {
    if (!this.menuEnabled(session)) return;
    const configOptions = this.withMenu(session);
    const json = JSON.stringify(configOptions);
    if (json === session.menuSent) return;
    session.menuSent = json;
    this.router?.notifyClient("session/update", {
      sessionId: session.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions },
    });
  }

  /**
   * A pick in a Mode or Model option that Rewake made from the agent's legacy `modes`/`models`:
   * ask the agent with the legacy request, then answer Zed with the updated options. If the agent
   * refuses, Zed gets the error and keeps the old value.
   */
  private async applyLegacyPick(
    session: SessionState,
    id: JsonRpcId,
    configId: string,
    value: string,
    legacy: { method: string; params: Record<string, unknown> },
  ): Promise<void> {
    const router = this.router;
    if (!router) return;
    const response = await router.requestAgent(legacy.method, legacy.params);
    if (response.error) {
      router.respondToClient(id, { error: response.error });
      return;
    }
    session.agentOptions = withValue(session.agentOptions ?? [], configId, value);
    if (configId === BRIDGED_MODE_ID) session.permissionMode = value;
    const configOptions = this.withMenu(session);
    session.menuSent = JSON.stringify(configOptions);
    router.respondToClient(id, { result: { configOptions } });
  }

  /**
   * Zed's `default_mode` setting applies only to its legacy mode picker, which Rewake replaces
   * with a toolbar option for these agents; so Rewake applies it once when a new session opens.
   */
  private applyDefaultMode(session: SessionState): void {
    const agentId = this.opts.agentId;
    const modes = session.bridge?.modes;
    if (!agentId || !modes || !this.router) return;
    const wanted = zedAgentSetting(agentId, "default_mode", this.env);
    if (typeof wanted !== "string" || !modes.has(wanted) || wanted === session.permissionMode)
      return;
    const sessionId = session.sessionId;
    void this.router.requestAgent("session/set_mode", { sessionId, modeId: wanted }).then((r) => {
      if (r.error) return;
      session.agentOptions = withValue(session.agentOptions ?? [], BRIDGED_MODE_ID, wanted);
      session.permissionMode = wanted;
      this.refreshMenu(session);
    });
  }

  /** A pick in Rewake's menu: answer at once (the menu snaps back), then run the action. */
  private onSetConfigOption(m: JsonRpcMessage): Action {
    const params = asObject(m.params);
    if (m.id == null) return FORWARD;
    if (params.configId !== MENU_CONFIG_ID) {
      const bridged =
        typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
      const legacy = bridged
        ? legacyRequest(bridged.bridge, bridged.sessionId, params.configId, params.value)
        : undefined;
      if (!bridged || !legacy) return FORWARD;
      const id = m.id;
      void this.applyLegacyPick(bridged, id, String(params.configId), String(params.value), legacy);
      return CONSUME;
    }
    const session =
      typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
    if (!session) {
      this.router?.respondToClient(m.id, {
        error: { code: -32602, message: "Unknown session" },
      });
      return CONSUME;
    }
    this.router?.respondToClient(m.id, { result: { configOptions: this.withMenu(session) } });
    session.menuSent = undefined;
    const [nonce, action] = String(params.value ?? "").split(".");
    // A value from an earlier opening is Zed re-applying a saved pick, not a click: ignore it.
    if (nonce === session.menuNonce && action && MENU_ACTIONS.has(action))
      setImmediate(() => void this.runMenu(session, action as MenuAction));
    else setImmediate(() => this.refreshMenu(session));
    return CONSUME;
  }

  private async runMenu(session: SessionState, action: MenuAction): Promise<void> {
    this.opts.log.info("menu.action", { action });
    try {
      switch (action) {
        case "new":
          await this.formNewSchedule(session);
          break;
        case "open":
          await this.formSchedules(session);
          break;
        case "change":
          await this.formChange(session);
          break;
        case "settings":
          await this.formSettings(session);
          break;
        case "resume":
          await this.offerResume(session);
          break;
        case "auto":
          await this.formAuto(session);
          break;
        case "stop":
          this.status(session, this.cmdStop(session));
          break;
        case "home":
          // The menu's own label ("Rewake"): picking it shows what Rewake is and how to use it.
          this.status(session, this.aboutCard());
          break;
      }
    } catch (err) {
      this.status(session, `Rewake: Couldn't do that. ${(err as Error).message}`);
    }
    this.refreshMarker(session);
  }

  /**
   * Show a form in the thread. Resolves with the answers on
   * Accept, or undefined on Decline, cancel, or when a form is already open.
   */
  private async form(
    session: SessionState,
    message: string,
    properties: Record<string, unknown>,
    required: string[] = [],
    { exclusive = true }: { exclusive?: boolean } = {},
  ): Promise<Record<string, unknown> | undefined> {
    const router = this.router;
    if (!router || !this.clientSupportsForms || (exclusive && session.formOpen)) return undefined;
    if (!exclusive) {
      // A question the user may leave unanswered: it never holds up Rewake's other forms.
      const response = await router.requestClient("elicitation/create", {
        sessionId: session.sessionId,
        mode: "form",
        message,
        requestedSchema: { type: "object", properties, required },
      });
      const result = asObject(response.result);
      return result.action === "accept" ? asObject(result.content) : undefined;
    }
    session.formOpen = true;
    try {
      const response = await router.requestClient("elicitation/create", {
        sessionId: session.sessionId,
        mode: "form",
        message,
        requestedSchema: { type: "object", properties, required },
      });
      const result = asObject(response.result);
      return result.action === "accept" ? asObject(result.content) : undefined;
    } finally {
      session.formOpen = false;
    }
  }

  /**
   * The "When" choices: a few presets with their actual times, and "Custom time
   * (cron)…", which opens its own step. No free-text time field: cron covers every other case.
   */
  private whenField(session: SessionState): Record<string, unknown> {
    const now = this.now();
    const at = (when: string) => {
      const r = parseWhen(when, now);
      return r.ok ? formatWhen(r.at, now, this.opts.locale) : when;
    };
    const choices: unknown[] = [];
    const resetAt = session.limit?.resetAt;
    const limited = resetAt !== undefined && resetAt > now;
    if (limited)
      choices.push({
        const: "limit",
        title: `When the usage limit resets (${formatWhen(resetAt, now, this.opts.locale)})`,
      });
    for (const [when, label] of [
      ["in 30m", "In 30 minutes"],
      ["in 1h", "In 1 hour"],
      ["in 3h", "In 3 hours"],
      ["tomorrow 09:00", "Tomorrow morning"],
    ] as const)
      choices.push({ const: when, title: `${label} (${at(when)})` });
    choices.push({
      const: "custom",
      title: "Custom time…",
      description: "Any time, or a repeat such as every weekday at 09:00. Opens the next step",
    });
    return { type: "string", title: "When", oneOf: choices, default: limited ? "limit" : "in 1h" };
  }

  /** A preset choice as a time, or undefined for "custom". */
  private presetTime(session: SessionState, choice: string): number | undefined {
    if (choice === "custom") return undefined;
    if (choice === "limit") {
      const resetAt = session.limit?.resetAt;
      return resetAt !== undefined ? this.resumeAt(resetAt) : undefined;
    }
    const r = parseWhen(choice, this.now());
    return r.ok ? r.at : undefined;
  }

  /**
   * "Custom time…": one field for the expression, then what Rewake understood and the next
   * runs, with "Every time it matches" or "Only once". Undefined when cancelled.
   */
  async askCustomTime(
    session: SessionState,
    draft = "",
  ): Promise<{ first: number; cron?: string; custom: true } | undefined> {
    let problem = "";
    for (;;) {
      const entered = await this.form(
        session,
        problem
          ? `Rewake: ${problem} Try again, or Decline to cancel.`
          : "Custom time: type a cron expression (minute hour day month weekday), in your local time.",
        {
          cron: {
            type: "string",
            title: "Cron expression",
            description: `"30 14 * * *" = ${clockTime(14, 30)} · "0 9 * * 1-5" = weekdays at ${clockTime(9, 0)} · "*/30 * * * *" = every 30 minutes · @daily`,
            minLength: 1,
            default: draft,
          },
        },
        ["cron"],
      );
      if (!entered) return undefined;
      draft = String(entered.cron ?? "").trim();
      const parsed = parseCron(draft);
      if (!parsed.ok) {
        problem = parsed.error;
        continue;
      }
      const now = this.now();
      const first = nextRun(parsed.cron, now);
      if (first === undefined) {
        problem = `"${draft}" never runs.`;
        continue;
      }
      const runs = [first, ...nextRuns(parsed.cron, first, 2)]
        .map((t) => formatWhen(t, now, this.opts.locale))
        .join("; ");
      const perDay = runsPerDay(parsed.cron);
      const how = await this.form(
        session,
        `Rewake understood "${parsed.cron.source}" as: ${describeCron(parsed.cron)}. Next runs: ${runs}.${
          perDay > 24 ? ` That's about ${perDay} runs a day.` : ""
        }`,
        {
          how: {
            type: "string",
            title: "How often",
            oneOf: [
              { const: "repeat", title: "Every time it matches" },
              { const: "once", title: `Only once (${formatWhen(first, now, this.opts.locale)})` },
            ],
            default: "repeat",
          },
        },
        ["how"],
      );
      if (!how) return undefined;
      return how.how === "once"
        ? { first, custom: true }
        : { first, cron: parsed.cron.source, custom: true };
    }
  }

  /** "When?" on its own (changing a message's time): presets, or the custom step. */
  private async askWhen(
    session: SessionState,
    title: string,
  ): Promise<{ first: number; cron?: string; custom?: true } | undefined> {
    const picked = await this.form(session, title, { time: this.whenField(session) }, ["time"]);
    if (!picked) return undefined;
    const choice = String(picked.time ?? "in 1h");
    const at = this.presetTime(session, choice);
    if (at !== undefined) return { first: at };
    return choice === "custom" ? this.askCustomTime(session) : undefined;
  }

  /**
   * "Schedule a message…" in small steps:
   *  1. when automatic resume is off: a message, or "resume when the limit resets";
   *  2. the message and a "When" with presets;
   *  3–4. only for "Custom time": the cron expression, then what Rewake understood.
   */
  async formNewSchedule(session: SessionState, draft = ""): Promise<void> {
    if (!draft && !this.threads.get(session.sessionId)?.autoResume) {
      const what = await this.form(
        session,
        "What would you like to schedule?",
        {
          what: {
            type: "string",
            title: "Schedule",
            oneOf: [
              { const: "message", title: "A message, at a time you pick" },
              {
                const: "resume",
                title: "Resume this thread when the usage limit resets",
                description: `Sends your resume message automatically whenever ${this.agentName} stops at its limit`,
              },
            ],
            default: "message",
          },
        },
        ["what"],
      );
      if (!what) return;
      if (what.what === "resume") return this.turnOnAutoResume(session);
    }
    const content = await this.form(
      session,
      "Schedule a message. Rewake sends it at that time, as if you typed it.",
      {
        message: {
          type: "string",
          title: "Message",
          description: `What ${this.agentName} should get`,
          minLength: 1,
          default: draft,
        },
        time: this.whenField(session),
      },
      ["message", "time"],
    );
    if (!content) return;
    const text = String(content.message ?? "").trim();
    if (!text) {
      this.status(session, "Rewake: Not scheduled yet. Type the message to send.");
      return this.formNewSchedule(session, " ");
    }
    const choice = String(content.time ?? "in 1h");
    const preset = this.presetTime(session, choice);
    const when: { first: number; cron?: string } | undefined =
      preset !== undefined
        ? { first: preset }
        : choice === "custom"
          ? await this.askCustomTime(session)
          : undefined;
    if (!when) {
      this.status(session, "Rewake: Not scheduled.");
      return;
    }
    const now = this.now();
    const s = this.store.create({
      sessionId: session.sessionId,
      cwd: session.cwd,
      text,
      dueAt: when.first,
      createdBy: "form",
      now,
      ...(when.cron && { repeat: { cron: when.cron } }),
    });
    this.opts.log.info("schedule.created", { scheduleId: s.scheduleId, dueAt: s.dueAt });
    this.status(session, this.scheduledLine(session, when.first, when.cron));
    if (when.first <= now) setImmediate(() => this.deliverDue(session));
  }

  /** Give a message a new time; a custom cron choice also sets (or clears) its repeat. */
  private moveTo(
    session: SessionState,
    scheduleId: string,
    when: { first: number; cron?: string; custom?: true },
  ) {
    const now = this.now();
    const moved = this.store.update(
      scheduleId,
      (x) => {
        // A preset moves only the next run; a custom time also replaces the repeat.
        if (!when.custom) return { ...x, status: "scheduled", dueAt: when.first, attempts: [] };
        const { repeat: _old, ...rest } = x;
        return {
          ...rest,
          status: "scheduled",
          dueAt: when.first,
          attempts: [],
          ...(when.cron && { repeat: { cron: when.cron } }),
        };
      },
      now,
    );
    const parsed = moved?.repeat ? parseCron(moved.repeat.cron) : undefined;
    this.status(
      session,
      `Rewake: Moved. It will be sent at ${formatWhen(when.first, now, this.opts.locale)}.${parsed?.ok ? ` Repeats: ${describeCron(parsed.cron)}.` : ""}`,
    );
    if (when.first <= now) setImmediate(() => this.deliverDue(session));
  }

  /** Step 1's "Resume when the limit resets": nothing more to ask; it's on, with your message. */
  private turnOnAutoResume(session: SessionState): void {
    this.threads.update(session.sessionId, session.cwd, { autoResume: true }, this.now());
    this.introOnce(session);
    this.status(
      session,
      "Rewake: Done. Whenever this thread hits a usage limit, Rewake resumes it when the limit resets. To turn it off or change the message, use the Rewake menu.",
    );
    // Already stopped at a limit? Schedule this one now.
    const limit = session.limit;
    if (
      limit?.resetAt !== undefined &&
      limit.resetAt > this.now() &&
      !this.pending(session).some((s) => s.kind !== "user")
    )
      this.scheduleResume(
        session,
        "limit_resume",
        this.threads.resumePrompt(session.sessionId),
        "form",
      );
    this.refreshMarker(session);
  }

  /**
   * The first time someone schedules or turns on automatic resume in a thread: a short note on
   * when Rewake can and can't send, once per thread, after the confirmation.
   */
  private introOnce(session: SessionState): void {
    if (this.opts.firstUseNote === false || this.threads.get(session.sessionId)?.introShown) return;
    this.threads.update(session.sessionId, session.cwd, { introShown: true }, this.now());
    const tools =
      Boolean(this.opts.selfCommand) && this.opts.agentTools !== false && !this.toolsRefused;
    setImmediate(() =>
      this.status(session, introNote(capitalize(this.agentName), this.menuEnabled(session), tools)),
    );
  }

  private scheduledLine(session: SessionState, at: number, cron?: string): string {
    this.introOnce(session);
    const parsed = cron ? parseCron(cron) : undefined;
    const repeats = parsed?.ok ? ` Repeats: ${describeCron(parsed.cron)}.` : "";
    return `Rewake: Scheduled for ${formatWhen(at, this.now(), this.opts.locale)}.${repeats} ${this.manageHint(session)}${
      this.lock.holds(session.sessionId)
        ? ""
        : " Another Zed window owns this thread, so that window will send it."
    }`;
  }

  /**
   * "Schedules…": a table of this thread's messages and of other threads (with a
   * link to open each), followed by a form with every action. Each choice carries its command as
   * a hint, so people who like typing learn it on the way.
   */
  async formSchedules(session: SessionState): Promise<void> {
    // "Schedules…" is a request to *see*: show the table and nothing else. Changing a message is
    // its own menu entry.
    this.status(session, this.schedulesCard(session, this.now()));
  }

  /**
   * "Change a scheduled message…", one decision per step: which message
   * (skipped when there's only one), what to do with it, then only what that action needs.
   */
  async formChange(session: SessionState): Promise<void> {
    const now = this.now();
    const list = this.pending(session);
    if (list.length === 0) {
      this.status(session, "Rewake: Nothing is scheduled in this thread.");
      return;
    }
    let s = list[0];
    if (list.length > 1) {
      const picked = await this.form(
        session,
        "Which message do you want to change?",
        {
          item: {
            type: "string",
            title: "Message",
            oneOf: list.map((x, i) => ({
              const: x.scheduleId,
              title: `${i + 1}. ${formatWhen(x.dueAt, now, this.opts.locale)} · ${preview(x.text)}`,
            })),
            default: list[0]?.scheduleId,
          },
        },
        ["item"],
      );
      if (!picked) return;
      s = list.find((x) => x.scheduleId === picked.item);
    }
    if (!s) return;
    const n = list.indexOf(s) + 1;
    const paused = s.status === "paused";
    const content = await this.form(
      session,
      `"${preview(s.text)}" · ${formatWhen(s.dueAt, now, this.opts.locale)}. What do you want to do?`,
      {
        action: {
          type: "string",
          title: "Do this",
          oneOf: [
            { const: "move", title: "Change the time…", description: `/rewake move ${n} <when>` },
            {
              const: "edit",
              title: "Change the message…",
              description: `/rewake edit ${n} <text>`,
            },
            { const: "now", title: "Send it now", description: `/rewake now ${n}` },
            {
              const: "pause",
              title: paused ? "Resume it" : "Pause it",
              description: `/rewake ${paused ? "resume" : "pause"} ${n}`,
            },
            { const: "delete", title: "Delete it…", description: `/rewake cancel ${n}` },
          ],
          default: "move",
        },
      },
      ["action"],
    );
    if (!content) return;
    switch (content.action) {
      case "move": {
        const when = await this.askWhen(session, `New time for: "${preview(s.text)}"`);
        if (!when) return;
        this.moveTo(session, s.scheduleId, when);
        return;
      }
      case "edit": {
        const edited = await this.form(
          session,
          `Change the message scheduled for ${formatWhen(s.dueAt, this.now(), this.opts.locale)}`,
          { message: { type: "string", title: "Message", minLength: 1, default: s.text } },
          ["message"],
        );
        const text = String(edited?.message ?? "").trim();
        if (!text) return;
        this.status(session, this.cmdText(session, `edit ${n} ${text}`));
        return;
      }
      case "now":
        this.status(session, this.cmdText(session, `now ${n}`));
        return;
      case "pause":
        this.status(
          session,
          this.cmdText(session, `${s.status === "paused" ? "resume" : "pause"} ${n}`),
        );
        return;
      case "delete": {
        const sure = await this.form(
          session,
          `Delete the message scheduled for ${formatWhen(s.dueAt, this.now(), this.opts.locale)}: "${preview(s.text)}"? Submit deletes it; Decline keeps it.`,
          {},
        );
        if (sure) this.status(session, this.cmdText(session, `cancel ${n}`));
        return;
      }
    }
  }

  /** "Settings…": one form, each setting a single choice with its current value. */
  private async formSettings(session: SessionState): Promise<void> {
    const current = loadSettings(this.opts.stateDir);
    // One question for automatic resume: who it applies to and whether
    // threads that skip permission prompts are included. Zed lists fields by key, alphabetically,
    // so "autoResume" comes before "clock".
    const now: AutoResumeChoice =
      current.newThreads === "off"
        ? "off"
        : current.newThreads === "ask"
          ? "ask"
          : current.autoWhenPromptsSkipped
            ? "all"
            : "exceptBypass";
    const content = await this.form(
      session,
      `Agent Rewake ${VERSION} settings.`,
      {
        autoResume: {
          type: "string",
          title: "Automatic resume after usage limits",
          oneOf: [
            { const: "all", title: "On, even when permissions are bypassed" },
            { const: "exceptBypass", title: "On, except when permissions are bypassed" },
            { const: "ask", title: "Ask when a new thread opens" },
            { const: "off", title: "Off" },
          ],
          default: now,
        },
        clock: {
          type: "string",
          title: "Time format",
          oneOf: [
            { const: "12h", title: `12-hour (${clockTime(15, 19, "12h")})` },
            { const: "24h", title: `24-hour (${clockTime(15, 19, "24h")})` },
          ],
          default: current.clock,
        },
        // Only where Rewake can actually do it (rule A5).
        ...(this.wake.supported && {
          keepAwake: {
            type: "string",
            title: "Keep this computer awake for resumes and scheduled messages",
            oneOf: [
              { const: "plugged-in", title: "While it's plugged in" },
              { const: "always", title: "Always, also on battery" },
              { const: "never", title: "Never" },
            ],
            default: current.keepAwake,
          },
        }),
      },
      ["autoResume", "clock"],
    );
    if (!content) return;
    const clock = content.clock === "24h" ? "24h" : "12h";
    const choice: AutoResumeChoice = (["all", "exceptBypass", "ask", "off"] as const).includes(
      content.autoResume as AutoResumeChoice,
    )
      ? (content.autoResume as AutoResumeChoice)
      : now;
    const newThreads = choice === "off" ? "off" : choice === "ask" ? "ask" : "on";
    const autoWhenPromptsSkipped = choice !== "exceptBypass";
    const keepAwake: KeepAwake = (["plugged-in", "always", "never"] as const).includes(
      content.keepAwake as KeepAwake,
    )
      ? (content.keepAwake as KeepAwake)
      : current.keepAwake;
    saveSettings(this.opts.stateDir, {
      ...current,
      clock,
      newThreads,
      autoWhenPromptsSkipped,
      keepAwake,
    });
    applySettings(this.opts.stateDir);
    const changed: string[] = [];
    if (clock !== current.clock) changed.push(`Times now show like ${clockTime(15, 19)}.`);
    if (keepAwake !== current.keepAwake)
      changed.push(
        {
          "plugged-in":
            "Rewake keeps this computer awake for resumes and scheduled messages while it's plugged in.",
          always:
            "Rewake keeps this computer awake for resumes and scheduled messages, also on battery.",
          never: "Rewake lets this computer sleep, even with messages scheduled.",
        }[keepAwake],
      );
    if (choice !== now)
      changed.push(
        {
          all: "New threads, and threads Rewake sees for the first time, resume automatically after usage limits, including threads that bypass permissions.",
          exceptBypass:
            "New threads, and threads Rewake sees for the first time, resume automatically after usage limits, except threads that bypass permissions.",
          ask: "Rewake asks about automatic resume when a new thread opens.",
          off: "Rewake won't resume new threads automatically or ask about it.",
        }[choice],
      );
    this.status(
      session,
      changed.length === 0 ? "Rewake: No change." : `Rewake: Saved. ${changed.join(" ")}`,
    );
  }

  /** "About Rewake", shown when the menu's own "Rewake" entry is picked. */
  private aboutCard(): string {
    return [
      `**About Agent Rewake** · ${VERSION}`,
      "",
      "Resumes this thread when a usage limit resets, so the work continues while you're away, and sends messages into it at the times you choose.",
      "",
      "- **Schedules…** shows this thread's scheduled messages and lets you change them.",
      "- **Schedule a message…** adds one: pick a time, or a repeat such as every weekday at 09:00.",
      `- You can also type \`/rewake\`, or ask ${this.agentName} to schedule something; you approve it here.`,
      "",
      `Open source: [Agent Rewake on GitHub](${REPO_URL}). If it saves you time, a star there helps others find it, and you can [support it on Ko-fi](${SUPPORT_URL}).`,
    ].join("\n");
  }

  /** The Markdown table shown by "Schedules…": this thread's messages only. */
  schedulesCard(session: SessionState, now: number): string {
    const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
    const list = this.pending(session);
    const lines = ["**Rewake · Scheduled messages**", ""];
    if (list.length === 0) {
      lines.push(
        "Nothing is scheduled in this thread yet. To add one, pick **Schedule a message…** in the Rewake menu, or type `/rewake in 1h Run the tests`.",
      );
    } else {
      const anyRepeat = list.some((s) => s.repeat);
      lines.push(
        anyRepeat ? "| # | When | Message | Repeats | Status |" : "| # | When | Message | Status |",
        anyRepeat ? "|---|---|---|---|---|" : "|---|---|---|---|",
      );
      for (const [i, s] of list.entries()) {
        const parsed = s.repeat ? parseCron(s.repeat.cron) : undefined;
        const repeats = parsed?.ok ? describeCron(parsed.cron) : "—";
        lines.push(
          `| ${i + 1} | ${cell(formatWhen(s.dueAt, now, this.opts.locale))} | ${cell(preview(s.text))}${s.kind === "user" ? "" : " _(resume)_"}${followUpNote(s)}${anyRepeat ? ` | ${cell(repeats)}` : ""} | ${STATUS_WORDS[s.status]} |`,
        );
      }
    }
    // One quiet line, so it never outweighs the table.
    lines.push(
      "",
      list.length > 0
        ? 'To change one: Rewake menu → Change a scheduled message…. Every thread at once: the "Agent Rewake: schedules" task.'
        : 'Every thread at once: the "Agent Rewake: schedules" task (command palette → task: spawn).',
    );
    return lines.join("\n");
  }

  /**
   * A new thread, with any agent: ask once whether to resume it automatically after usage
   * limits, or apply the user's standing answer. The question doesn't block Rewake's other forms:
   * the user can ignore it and start typing.
   */
  async offerAutoOnNewThread(session: SessionState, onlyWhenOn = false): Promise<void> {
    if (
      !this.clientSupportsForms ||
      this.opts.askOnNewThreads === false ||
      this.opts.allowAutomaticResume === false ||
      this.threads.get(session.sessionId)?.autoResume
    )
      return;
    const settings = loadSettings(this.opts.stateDir);
    if (settings.newThreads === "off") return;
    // An existing thread opened for the first time is never asked, only switched on.
    if (onlyWhenOn && settings.newThreads !== "on") return;
    const bypassNote =
      isBypassMode(session.permissionMode) && !settings.autoWhenPromptsSkipped
        ? " This thread bypasses permissions, and your setting excludes those threads: at a limit Rewake asks you instead."
        : "";
    if (settings.newThreads === "on") {
      this.threads.update(
        session.sessionId,
        session.cwd,
        { autoResume: true, ...(settings.resumePrompt && { resumePrompt: settings.resumePrompt }) },
        this.now(),
      );
      this.refreshMenu(session);
      if (bypassNote)
        this.status(session, `Rewake: Automatic resume is on for this thread.${bypassNote}`);
      return;
    }
    // Don't offer what can't run here: a thread that skips permission prompts
    // never resumes unattended, so it isn't asked.
    if (bypassNote) return;
    const content = await this.form(
      session,
      `Resume this thread automatically if ${this.agentName} hits its usage limit? Rewake sends your resume message when the limit resets, says so in the thread, and never approves permission requests. Decline: ask again in the next new thread.`,
      {
        choice: {
          type: "string",
          title: "Automatic resume",
          oneOf: [
            { const: "all", title: "Yes, in this and every new thread (don't ask again)" },
            { const: "this", title: "Yes, in this thread only" },
            { const: "never", title: "No, and don't ask again" },
          ],
          default: "all",
        },
        // One decision: the message is changed elsewhere (the auto-resume entry,
        // /rewake prompt), not here.
      },
      ["choice"],
      { exclusive: false },
    );
    if (!content) return;
    const text = settings.resumePrompt ?? "";
    const current = loadSettings(this.opts.stateDir);
    if (content.choice === "never") {
      saveSettings(this.opts.stateDir, { ...current, newThreads: "off" });
      this.status(
        session,
        "Rewake: Won't ask in new threads. Change it in Rewake menu → Settings…, or turn automatic resume on for a thread from its Rewake menu.",
      );
      return;
    }
    this.threads.update(
      session.sessionId,
      session.cwd,
      { autoResume: true, ...(text && { resumePrompt: text }) },
      this.now(),
    );
    this.introOnce(session);
    if (content.choice === "all") {
      const { resumePrompt: _old, ...rest } = current;
      saveSettings(this.opts.stateDir, {
        ...rest,
        newThreads: "on",
        ...(text && text !== DEFAULT_RESUME_PROMPT && { resumePrompt: text }),
      });
    }
    this.refreshMenu(session);
    this.status(
      session,
      content.choice === "all"
        ? "Rewake: Automatic resume is on for this thread and every new one. Change it in Rewake menu → Settings…."
        : "Rewake: Automatic resume is on for this thread. Turn it off from the Rewake menu.",
    );
  }

  /** The auto-resume switch: turning it on asks first and explains it; turning it off doesn't. */
  private async formAuto(session: SessionState): Promise<void> {
    const now = this.now();
    if (this.threads.get(session.sessionId)?.autoResume) {
      this.status(session, this.cmdText(session, "auto off"));
      return;
    }
    const content = await this.form(
      session,
      `Resume this thread automatically whenever it hits a usage limit? Rewake sends your message when the limit resets, follows the new reset time if ${this.agentName} is still limited (or, if it never says when, waits the time you last picked, 1 hour at first), says so in the thread each time, and never approves permission requests.`,
      {
        prompt: {
          type: "string",
          title: "Message to send",
          default: this.threads.resumePrompt(session.sessionId),
        },
      },
      ["prompt"],
    );
    if (!content) return;
    const text = String(content.prompt ?? "").trim();
    this.threads.update(
      session.sessionId,
      session.cwd,
      { autoResume: true, ...(text && { resumePrompt: text }) },
      now,
    );
    this.introOnce(session);
    this.status(
      session,
      "Rewake: Automatic resume is on for this thread. Turn it off from the Rewake menu.",
    );
  }

  /** The limit moved more than a day out during an automatic resume: ask before following it. */
  private async confirmFarResume(
    session: SessionState,
    scheduleId: string,
    resetAt: number,
    dueAt: number,
  ): Promise<void> {
    const when = formatWhen(resetAt, this.now(), this.opts.locale);
    const question = `Rewake: ${capitalize(this.agentName)} is still at its usage limit, now until ${when}. Resume this thread then?`;
    if (!this.clientSupportsForms || session.formOpen) {
      this.status(
        session,
        `${question} ${this.menuEnabled(session) ? "Use the Rewake menu to send or reschedule it." : "Type /rewake list, then /rewake now N or /rewake move N <when>."}`,
      );
      this.refreshMarker(session);
      return;
    }
    const yes = await this.form(session, question, {});
    if (yes) {
      // Confirmed by the user, so it's no longer an automatic resume.
      this.store.update(
        scheduleId,
        (x) => ({ ...x, status: "scheduled", dueAt, kind: "limit_resume" }),
        this.now(),
      );
      this.status(session, `Rewake: This thread will resume when the limit resets (${when}).`);
    }
    this.refreshMarker(session);
  }

  /** A yes/no question for a message that needs the user (missed, failed, still limited). */
  private async offerRetry(
    session: SessionState,
    scheduleId: string,
    question: string,
  ): Promise<void> {
    const s = this.store.get(scheduleId);
    if (!s || !this.clientSupportsForms) return;
    const content = await this.form(
      session,
      question,
      {
        what: {
          type: "string",
          title: "Do this",
          oneOf: [
            { const: "now", title: "Send it now" },
            { const: "move", title: "Pick a new time…" },
            { const: "delete", title: "Delete it" },
          ],
          default: "now",
        },
      },
      ["what"],
    );
    if (!content) return;
    const now = this.now();
    if (content.what === "delete") {
      this.store.remove(scheduleId);
      this.status(session, "Rewake: Deleted.");
    } else if (content.what === "move") {
      const when = await this.askWhen(session, `New time for: "${preview(s.text)}"`);
      if (!when) return;
      this.moveTo(session, scheduleId, when);
    } else {
      this.store.update(
        scheduleId,
        (x) => ({ ...x, status: "scheduled", dueAt: now, attempts: [] }),
        now,
      );
      setImmediate(() => this.deliverDue(session));
    }
    this.refreshMarker(session);
  }

  /** Where to manage schedules: the menu when Zed shows it, otherwise the command. */
  private manageHint(session: SessionState): string {
    return this.menuEnabled(session)
      ? "To change it, use the Rewake menu under the message box."
      : "Type /rewake list to see or change it.";
  }

  private stopHint(session: SessionState, lead = "To stop the reply"): string {
    return this.menuEnabled(session)
      ? `${lead}, pick "Stop the scheduled reply" in the Rewake menu, or type /rewake stop.`
      : `${lead}, type /rewake stop.`;
  }

  // ---- commands -------------------------------------------------------------------------------

  private runCommand(session: SessionState, id: JsonRpcId, args: string): void {
    const command = parseRewake(args);
    if (command.kind === "home" && this.clientSupportsForms) {
      // A bare /rewake opens a form: the resume question at a usage limit, otherwise the same
      // "Schedule a message" form as the menu.
      this.router?.respondToClient(id, { result: { stopReason: "end_turn" } });
      void this.runMenu(session, this.limitToContinue(session) ? "resume" : "new");
      return;
    }
    if (
      command.kind === "cancel" &&
      command.which === "all" &&
      this.clientSupportsForms &&
      this.pending(session).length > 0
    ) {
      // Deleting every message asks first, like the menu's Delete.
      this.router?.respondToClient(id, { result: { stopReason: "end_turn" } });
      void this.confirmCancelAll(session);
      return;
    }
    let reply: string;
    try {
      reply = this.cmdRewake(session, command, args.trim());
    } catch (err) {
      reply = `Rewake: Couldn't do that. ${(err as Error).message}`;
    }
    this.status(session, reply);
    this.router?.respondToClient(id, { result: { stopReason: "end_turn" } });
    this.refreshMarker(session);
  }

  /** `/rewake cancel all` where forms work: one question, then delete or keep. */
  private async confirmCancelAll(session: SessionState): Promise<void> {
    const n = this.pending(session).length;
    const sure = await this.form(
      session,
      n === 1
        ? "Delete the scheduled message in this thread? Submit deletes it; Decline keeps it."
        : `Delete all ${n} scheduled messages in this thread? Submit deletes them; Decline keeps them.`,
      {},
    );
    this.status(
      session,
      sure
        ? this.cmdText(session, "cancel all")
        : n === 1
          ? "Rewake: Kept your scheduled message."
          : "Rewake: Kept your scheduled messages.",
    );
    this.refreshMarker(session);
  }

  /** At a usage limit, with no resume scheduled yet: what a bare /rewake continues. */
  private limitToContinue(session: SessionState): boolean {
    return session.limit !== undefined && !this.pending(session).some((s) => s.kind !== "user");
  }

  private pending(session: SessionState): Schedule[] {
    return this.store
      .listForSession(session.sessionId)
      .filter((s) => !TERMINAL_STATUSES.has(s.status));
  }

  private byNumber(session: SessionState, arg: string | undefined): Schedule {
    const n = Number(arg);
    const list = this.pending(session);
    const s = Number.isInteger(n) && n >= 1 ? list[n - 1] : undefined;
    if (!s)
      throw new Error(
        `There's no scheduled message number ${arg ?? ""} in this thread. Type /rewake list.`,
      );
    return s;
  }

  private cmdRewake(session: SessionState, command: RewakeCommand, args: string): string {
    const now = this.now();
    switch (command.kind) {
      case "home":
        return this.limitToContinue(session)
          ? this.cmdResumeAfterLimit(session)
          : `${helpBlock()}\n\n${this.listText(session)}`;
      case "help":
        return helpBlock();
      case "list":
        return this.schedulesCard(session, now);
      case "stop":
        return this.cmdStop(session);
      case "continue": {
        if (!command.when) return this.cmdResumeAfterLimit(session);
        const when = parseWhen(command.when.replace(/^at\s+/i, ""), now);
        if (!when.ok) throw new Error(when.error);
        return this.cmdResumeAfterLimit(session, when.at);
      }
      case "cancel": {
        if (command.which === undefined) {
          const resumes = this.pending(session).filter((s) => s.kind !== "user");
          if (resumes.length === 0)
            return `Rewake: Nothing is set to continue this thread after a usage limit. To delete a scheduled message, type /${COMMAND_NAME} list, then /${COMMAND_NAME} cancel N.`;
          for (const s of resumes) this.store.remove(s.scheduleId);
          return "Rewake: Cancelled. This thread won't be resumed after the usage limit.";
        }
        if (command.which === "all") {
          const all = this.pending(session);
          if (all.length === 0) return "Rewake: No messages are scheduled in this thread.";
          for (const s of all) this.store.remove(s.scheduleId);
          return all.length === 1
            ? "Rewake: Deleted the scheduled message."
            : `Rewake: Deleted ${all.length} scheduled messages.`;
        }
        const s = this.byNumber(session, command.which);
        this.store.remove(s.scheduleId);
        return `Rewake: Deleted the message scheduled for ${formatWhen(s.dueAt, now, this.opts.locale)}.`;
      }
      case "item":
        return this.cmdItem(session, command.action, command.n, command.rest);
      case "auto": {
        if (command.on === undefined) {
          const t = this.threads.get(session.sessionId);
          return `Rewake: Automatic resume after usage limits is ${t?.autoResume ? "on" : "off"} for this thread. Type /${COMMAND_NAME} auto on or /${COMMAND_NAME} auto off.`;
        }
        this.threads.update(session.sessionId, session.cwd, { autoResume: command.on }, now);
        return command.on
          ? `Rewake: Automatic resume is on for this thread. After a usage limit, Rewake sends your resume message when the limit resets, follows the new reset time if ${this.agentName} is still limited, and never approves permission requests. Turn it off with /${COMMAND_NAME} auto off.`
          : "Rewake: Automatic resume is off for this thread. After a usage limit, Rewake will ask first.";
      }
      case "page": {
        const file = join(ensurePrivateDir(this.opts.stateDir), "Schedules.md");
        writeFileSync(file, overviewMarkdown(overview(this.opts.stateDir), now, this.opts.locale), {
          mode: 0o600,
        });
        return `Rewake: [Open the overview of all scheduled messages](${pathToFileURL(file).href}) (a snapshot). To manage them, run the "Agent Rewake: schedules" task (\`${rewake("setup zed")}\` prints it).`;
      }
      case "repeat":
        return this.cmdRepeat(session, command.sub, command.words);
      case "prompt": {
        const text = command.text.trim();
        if (!text) {
          return `Rewake: This thread's resume message is: "${this.threads.resumePrompt(session.sessionId)}". Change it with /${COMMAND_NAME} prompt <text>.`;
        }
        this.threads.update(session.sessionId, session.cwd, { resumePrompt: text }, now);
        return "Rewake: Saved this thread's resume message.";
      }
      case "at": {
        const { at, text } = splitWhen(args, now);
        if (!text) {
          // A time alone: continue after the usage limit then.
          if (session.limit) return this.cmdResumeAfterLimit(session, at);
          throw new Error(
            `Add the message after the time, for example: /${COMMAND_NAME} 9:00 Continue the refactor.`,
          );
        }
        const s = this.store.create({
          sessionId: session.sessionId,
          cwd: session.cwd,
          text,
          dueAt: at,
          createdBy: "command",
          now,
        });
        this.opts.log.info("schedule.created", { scheduleId: s.scheduleId, dueAt: s.dueAt });
        return this.scheduledLine(session, at);
      }
    }
  }

  /** Run `/rewake <args>` for a form's choice; the reply line. */
  private cmdText(session: SessionState, args: string): string {
    return this.cmdRewake(session, parseRewake(args), args);
  }

  /** `/rewake now|pause|resume|move|edit N …`: change one of this thread's messages. */
  private cmdItem(
    session: SessionState,
    action: "now" | "pause" | "resume" | "move" | "edit",
    n: string | undefined,
    rest: string,
  ): string {
    const now = this.now();
    const s = this.byNumber(session, n);
    switch (action) {
      case "pause":
        this.store.update(s.scheduleId, (x) => ({ ...x, status: "paused" }), now);
        return `Rewake: Paused. The message scheduled for ${formatWhen(s.dueAt, now, this.opts.locale)} won't be sent until you resume it.`;
      case "resume": {
        const late = s.dueAt <= now;
        this.store.update(
          s.scheduleId,
          (x) => ({ ...x, status: "scheduled", ...(late && { dueAt: now }) }),
          now,
        );
        if (late) setImmediate(() => this.deliverDue(session));
        return late
          ? "Rewake: Resumed. Its time has passed, so it will be sent now."
          : `Rewake: Resumed. It will be sent at ${formatWhen(s.dueAt, now, this.opts.locale)}.`;
      }
      case "now":
        this.store.update(s.scheduleId, (x) => ({ ...x, status: "scheduled", dueAt: now }), now);
        setImmediate(() => this.deliverDue(session));
        return "Rewake: Sending it now.";
      case "move": {
        const when = parseWhen(rest.replace(/^at\s+/i, ""), now);
        if (!when.ok) throw new Error(when.error);
        this.store.update(
          s.scheduleId,
          (x) => ({ ...x, dueAt: when.at, status: "scheduled" }),
          now,
        );
        return `Rewake: Moved. It will be sent at ${formatWhen(when.at, now, this.opts.locale)}.`;
      }
      case "edit": {
        const text = rest.trim();
        if (!text) throw new Error("Give the new message text after the number.");
        this.store.update(s.scheduleId, (x) => ({ ...x, text }), now);
        return `Rewake: Updated the message scheduled for ${formatWhen(s.dueAt, now, this.opts.locale)}.`;
      }
    }
  }

  /**
   * `/rewake every day 09:00 <message>` and `/rewake cron 0 9 * * 1-5 <message>`. The reply
   * says what Rewake understood and the next runs; `/rewake cancel N` undoes it.
   */
  private cmdRepeat(session: SessionState, sub: string, words: string[]): string {
    const now = this.now();
    let cron: string;
    let rest: string[];
    if (sub === "cron") {
      const joined = words.join(" ");
      const quoted = /^"([^"]+)"\s*([\s\S]*)$/.exec(joined);
      if (quoted) {
        cron = quoted[1] ?? "";
        rest = (quoted[2] ?? "").split(/\s+/).filter(Boolean);
      } else if (words[0]?.startsWith("@")) {
        cron = words[0];
        rest = words.slice(1);
      } else {
        cron = words.slice(0, 5).join(" ");
        rest = words.slice(5);
      }
    } else {
      const unit = (words[0] ?? "").toLowerCase();
      const clockWord =
        words[1] && /^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(words[1]) ? words[1] : undefined;
      rest = words.slice(clockWord ? 2 : 1);
      const day = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ].indexOf(unit);
      let at = { h: 9, m: 0 };
      if (clockWord) {
        const t = parseWhen(clockWord, now);
        if (!t.ok) throw new Error(t.error);
        at = { h: new Date(t.at).getHours(), m: new Date(t.at).getMinutes() };
      }
      if (unit === "hour") cron = `${clockWord ? at.m : 0} * * * *`;
      else if (unit === "day") cron = `${at.m} ${at.h} * * *`;
      else if (unit === "weekday") cron = `${at.m} ${at.h} * * 1-5`;
      else if (unit === "week") cron = `${at.m} ${at.h} * * ${new Date(now).getDay()}`;
      else if (day !== -1) cron = `${at.m} ${at.h} * * ${day}`;
      else
        throw new Error(
          "After /rewake every, use hour, day, weekday, week or a day name, for example: /rewake every day 09:00 Run the tests.",
        );
    }
    const text = rest.join(" ").trim();
    const parsed = parseCron(cron);
    if (!parsed.ok) throw new Error(parsed.error);
    if (!text)
      throw new Error(
        "Add the message after the schedule, for example: /rewake every day 09:00 Run the tests.",
      );
    const first = nextRun(parsed.cron, now);
    if (first === undefined) throw new Error(`"${cron}" never runs.`);
    const s = this.store.create({
      sessionId: session.sessionId,
      cwd: session.cwd,
      text,
      dueAt: first,
      createdBy: "command",
      now,
      repeat: { cron: parsed.cron.source },
    });
    this.opts.log.info("schedule.created", {
      scheduleId: s.scheduleId,
      dueAt: s.dueAt,
      repeat: true,
    });
    const runs = [first, ...nextRuns(parsed.cron, first, 2)].map((t) =>
      formatWhen(t, now, this.opts.locale),
    );
    return `Rewake: Scheduled to repeat. Rewake understood "${parsed.cron.source}" as: ${describeCron(parsed.cron)}. Next runs: ${runs.join("; ")}. ${this.manageHint(session)}`;
  }

  /** `/rewake` (or `/rewake continue`) at a limit: resume at the reset, or at `at` when given. */
  private cmdResumeAfterLimit(session: SessionState, at?: number): string {
    const limit = session.limit;
    if (!limit)
      return `Rewake: This thread isn't at a usage limit. To schedule a message, type /${COMMAND_NAME} <when> <message>, for example /${COMMAND_NAME} in 1h Run the tests.`;
    const waiting = this.pending(session).find((s) => s.kind !== "user");
    if (waiting && at !== undefined) {
      this.store.update(
        waiting.scheduleId,
        (x) => ({ ...x, dueAt: at, status: "scheduled" }),
        this.now(),
      );
      return `Rewake: Moved. This thread will resume at ${formatWhen(at, this.now(), this.opts.locale)}.`;
    }
    if (waiting) {
      return this.menuEnabled(session)
        ? 'Rewake: A resume is already scheduled for this thread. To send more messages after it, pick "Resume after the usage limit…" in the Rewake menu.'
        : `Rewake: A resume is already scheduled for this thread. Type /${COMMAND_NAME} list to see it.`;
    }
    if (at !== undefined) limit.resetAt = at - this.margin();
    if (limit.resetAt === undefined) {
      return `Rewake: ${capitalize(this.agentName)} didn't say when the limit resets. Give a time, for example: /${COMMAND_NAME} 3:30pm or /${COMMAND_NAME} in 1h.`;
    }
    setImmediate(() =>
      this.scheduleResume(
        session,
        "limit_resume",
        this.threads.resumePrompt(session.sessionId),
        "command",
      ),
    );
    return "Rewake: Scheduling the resume.";
  }

  private listText(session: SessionState): string {
    const now = this.now();
    const list = this.pending(session);
    if (list.length === 0) return "Rewake: No messages are scheduled in this thread.";
    const lines = list.map(
      (s, i) =>
        `${i + 1}. ${formatWhen(s.dueAt, now, this.opts.locale)} · ${STATUS_WORD[s.status]}${s.kind === "user" ? "" : " · resume"} · ${preview(s.text)}${followUpNote(s)}`,
    );
    return `Rewake: Scheduled messages in this thread:\n\n${lines.join("\n")}`;
  }

  private cmdStop(session: SessionState): string {
    if (!session.delivering)
      return "Rewake: Nothing is running. No scheduled reply is in progress in this thread.";
    this.router?.notifyAgent("session/cancel", { sessionId: session.sessionId });
    return "Rewake: Stopping the scheduled reply.";
  }

  // ---- scheduling and delivery ---------------------------------------------------------------

  /** Heartbeat: re-read the store (picks up edits from other processes) and deliver what's due. */
  tick(): void {
    for (const session of this.sessions.values()) {
      if (this.lock.holds(session.sessionId) || this.lock.acquire(session.sessionId))
        this.deliverDue(session);
    }
    this.processRequests();
    // Settings changed in another window or on the schedules page apply here within a heartbeat.
    applySettings(this.opts.stateDir);
    this.updateWake();
  }

  /** This computer's sleep settings, re-read at most every ten minutes. */
  private sleepSettingsNow(now: number): SleepSettings {
    if (!this.sleepRead || now - this.sleepRead.at > 10 * 60_000)
      this.sleepRead = { at: now, settings: (this.opts.sleepSettings ?? readSleepSettings)() };
    return this.sleepRead.settings;
  }

  /**
   * Keep the computer from idling to sleep while a thread this process owns has a message due
   * within a few hours, or a scheduled reply runs; otherwise let it sleep. One store read per call.
   */
  private updateWake(): void {
    const settings = loadSettings(this.opts.stateDir);
    const now = this.now();
    const owned = [...this.sessions.values()].filter((s) => this.lock.holds(s.sessionId));
    const ids = new Set(owned.map((s) => s.sessionId));
    const due =
      ids.size === 0
        ? []
        : this.store
            .list()
            .filter(
              (s) =>
                ids.has(s.sessionId) &&
                (s.status === "scheduled" || s.status === "queued") &&
                s.dueAt - now <= WAKE_HORIZON_MS,
            );
    const delivering = owned.find((s) => s.delivering !== undefined);
    const want = due.length > 0 || delivering !== undefined;
    const held = this.wake.set(want, settings.keepAwake);
    if (!want || settings.keepAwake === "never") return;
    if (!this.wakeUnsupportedSaid) {
      // Rewake's own hold doesn't cover everything (battery, Linux, Windows): check what this
      // computer's own settings will do, and say so once, with where to change them.
      const hold = this.wake.supported ? settings.keepAwake : "none";
      const sleep = this.sleepSettingsNow(now);
      const known = sleep.pluggedInSleepMin !== undefined || sleep.onBattery !== undefined;
      const risks = sleepRisks(sleep, hold);
      const where = this.sessions.get(due[0]?.sessionId ?? "") ?? delivering;
      const first = due[0];
      if (where && (risks.length > 0 || (!known && !held))) {
        this.wakeUnsupportedSaid = true;
        const what = first
          ? ` before ${first.kind === "user" ? "the scheduled message" : "the resume"} at ${formatWhen(first.dueAt, now, this.opts.locale)}`
          : "";
        this.status(
          where,
          risks.length > 0
            ? `Rewake: This computer may sleep${what}: ${risks.join("; ")}. Change that so it stays awake while you're away; the best settings: ${SLEEP_DOCS_URL}`
            : `Rewake: Make sure this computer won't sleep${what}: Rewake couldn't check its sleep settings. The best settings: ${SLEEP_DOCS_URL}`,
        );
      }
    }
    if (!held) return;
    for (const s of due) {
      // Once per message, not per run: an hourly repeat would otherwise say it every hour.
      const key = s.scheduleId;
      const session = this.sessions.get(s.sessionId);
      if (this.wakeAnnounced.has(key) || !session) continue;
      this.wakeAnnounced.add(key);
      const what = s.kind === "user" ? "the scheduled message" : "the resume";
      this.status(
        session,
        `Rewake: Keeping this computer awake until ${what} at ${formatWhen(s.dueAt, now, this.opts.locale)}${settings.keepAwake === "plugged-in" ? ", while it's plugged in" : ""}. Closing the lid still puts it to sleep.`,
      );
    }
  }

  // ---- the agent's requests ------------------------------------------------------

  /** Ask the user about the agent's pending requests, one at a time per thread. */
  processRequests(): void {
    for (const session of this.sessions.values()) {
      if (!this.lock.holds(session.sessionId) || session.formOpen || session.askingAgent) continue;
      const next = this.requests.pendingFor(session.sessionId)[0];
      if (next) void this.askAboutRequest(session, next);
    }
  }

  private async askAboutRequest(session: SessionState, r: AgentRequest): Promise<void> {
    session.askingAgent = true;
    try {
      const answer = (status: AgentRequest["status"], text: string) =>
        this.requests.put({ ...r, status, answer: text });
      if (!this.clientSupportsForms) {
        answer("declined", "This client can't show the approval form, so nothing was changed.");
        return;
      }
      const now = this.now();
      const who = capitalize(this.agentName);
      const why = r.reason ? ` Reason: "${oneLine(r.reason)}".` : "";
      if (r.kind === "cancel") {
        const s = r.scheduleId ? this.store.get(r.scheduleId) : undefined;
        if (!s || s.sessionId !== session.sessionId) {
          answer("declined", "That scheduled message no longer exists.");
          return;
        }
        const ok = await this.form(
          session,
          `${who} wants to delete the message scheduled for ${formatWhen(s.dueAt, now, this.opts.locale)}: "${preview(s.text)}".${why} Submit deletes it; Decline keeps it.`,
          {},
        );
        if (this.expired(session, r)) return;
        if (ok) {
          this.store.remove(s.scheduleId);
          this.status(session, "Rewake: Deleted, as the agent asked and you approved.");
          answer("approved", "The user approved: it's deleted.");
        } else answer("declined", "The user declined: it stays scheduled.");
        this.refreshMarker(session);
        return;
      }
      if (r.kind === "update") {
        await this.askAboutUpdate(session, r, answer, why);
        return;
      }
      const dueAt = r.dueAt ?? now;
      const parsed = r.cron ? parseCron(r.cron) : undefined;
      const ends = endsText(r.until, r.times, now, this.opts.locale);
      const repeats = parsed?.ok ? ` Repeats: ${describeCron(parsed.cron)}${ends}.` : "";
      const twin = r.duplicateOf ? this.store.get(r.duplicateOf) : undefined;
      const dup =
        twin && twin.sessionId === session.sessionId
          ? ` The same message is already scheduled for ${formatWhen(twin.dueAt, now, this.opts.locale)}.`
          : "";
      const content = await this.form(
        session,
        `${who} wants to schedule a message in this thread for ${formatWhen(dueAt, now, this.opts.locale)}.${repeats}${why}${dup} You can edit the message. Submit schedules it; Decline refuses.`,
        {
          message: {
            type: "string",
            title: "Message",
            minLength: 1,
            default: r.message ?? "",
          },
        },
        ["message"],
      );
      if (this.expired(session, r)) return;
      const text = String(content?.message ?? "").trim();
      if (!content || !text) {
        answer("declined", "The user declined: nothing was scheduled.");
        return;
      }
      const s = this.store.create({
        sessionId: session.sessionId,
        cwd: session.cwd,
        text,
        dueAt: Math.max(dueAt, this.now()),
        createdBy: "agent",
        now: this.now(),
        ...(parsed?.ok && {
          repeat: {
            cron: parsed.cron.source,
            ...(r.until !== undefined && { until: r.until }),
            ...(r.times !== undefined && { remaining: r.times }),
          },
        }),
      });
      this.opts.log.info("schedule.created", { scheduleId: s.scheduleId, by: "agent" });
      this.status(session, this.scheduledLine(session, s.dueAt, s.repeat?.cron));
      this.requests.put({
        ...r,
        scheduleId: s.scheduleId,
        status: "approved",
        answer: `The user approved it${text !== r.message ? ", after editing the message" : ""}.`,
      });
      this.refreshMarker(session);
    } finally {
      session.askingAgent = false;
      setImmediate(() => this.processRequests());
    }
  }

  /**
   * The agent's tool call stops waiting after 10 minutes and tells it nothing changed (mcp.ts),
   * removing the request. An answer after that changes nothing either, and says so
   *.
   */
  private expired(session: SessionState, r: AgentRequest): boolean {
    if (this.requests.get(r.requestId)) return false;
    this.status(
      session,
      `Rewake: Nothing changed. ${capitalize(this.agentName)} stopped waiting for your answer after 10 minutes. Ask it again if you still want this.`,
    );
    return true;
  }

  /**
   * The agent asks to change one of the thread's messages: its text, time,
   * repeat, end, or paused state. The user sees old and new, and can edit the message.
   */
  private async askAboutUpdate(
    session: SessionState,
    r: AgentRequest,
    answer: (status: AgentRequest["status"], text: string) => void,
    why: string,
  ): Promise<void> {
    const now = this.now();
    const s = r.scheduleId ? this.store.get(r.scheduleId) : undefined;
    if (!s || s.sessionId !== session.sessionId || TERMINAL_STATUSES.has(s.status)) {
      answer("declined", "That scheduled message no longer exists.");
      return;
    }
    const at = (t: number) => formatWhen(t, now, this.opts.locale);
    const changes: string[] = [];
    const parsed = r.cron ? parseCron(r.cron) : undefined;
    if (r.cron && !parsed?.ok) {
      answer("declined", "That cron expression isn't valid; nothing was changed.");
      return;
    }
    const cron = parsed?.ok ? parsed.cron : undefined;
    const newDue = cron ? nextRun(cron, now) : r.dueAt;
    if (newDue !== undefined && newDue !== s.dueAt)
      changes.push(`move it from ${at(s.dueAt)} to ${at(newDue)}`);
    if (cron) changes.push(`repeat it ${describeCron(cron).toLowerCase()}`);
    if (r.stopRepeating && s.repeat) changes.push("stop repeating it after the next run");
    if (r.until !== undefined || r.times !== undefined)
      changes.push(`end the repeat${endsText(r.until, r.times, now, this.opts.locale)}`);
    if (r.paused === true && s.status !== "paused") changes.push("pause it");
    if (r.paused === false && s.status === "paused")
      changes.push(
        s.dueAt <= now ? "resume it (its time has passed, so it's sent now)" : "resume it",
      );
    const editing = r.message !== undefined && r.message !== s.text;
    if (editing) changes.push("change its message");
    if (changes.length === 0) {
      answer("declined", "That would change nothing, so nothing was changed.");
      return;
    }
    const content = await this.form(
      session,
      `${capitalize(this.agentName)} wants to change the message scheduled for ${at(s.dueAt)} ("${preview(s.text)}"): ${changes.join("; ")}.${why}${editing ? " You can edit the new message." : ""} Submit changes it; Decline keeps it as it is.`,
      editing
        ? { message: { type: "string", title: "Message", minLength: 1, default: r.message } }
        : {},
      editing ? ["message"] : [],
    );
    if (this.expired(session, r)) return;
    const text = editing ? String(content?.message ?? "").trim() : s.text;
    if (!content || !text) {
      answer("declined", "The user declined: nothing was changed.");
      return;
    }
    const resumeLate = r.paused === false && s.status === "paused" && s.dueAt <= this.now();
    this.store.update(
      s.scheduleId,
      (x) => {
        const repeat = cron
          ? { cron: cron.source }
          : r.stopRepeating
            ? undefined
            : x.repeat && { ...x.repeat };
        if (repeat && r.until !== undefined) repeat.until = r.until;
        if (repeat && r.times !== undefined) repeat.remaining = r.times;
        const { repeat: _old, ...rest } = x;
        return {
          ...rest,
          text,
          ...(repeat && { repeat }),
          ...(newDue !== undefined && { dueAt: newDue }),
          ...(r.paused === true && { status: "paused" as const }),
          ...(r.paused === false && x.status === "paused" && { status: "scheduled" as const }),
          ...(resumeLate && { dueAt: this.now() }),
        };
      },
      this.now(),
    );
    if (resumeLate) setImmediate(() => this.deliverDue(session));
    this.status(session, "Rewake: Changed, as the agent asked and you approved.");
    answer(
      "approved",
      `The user approved it${editing && text !== r.message ? ", after editing the message" : ""}.`,
    );
    this.refreshMarker(session);
  }

  private deliverDue(session: SessionState): void {
    if (!this.lock.holds(session.sessionId)) return;
    const now = this.now();
    for (const s of this.pending(session)) {
      if (s.status === "sending" && session.delivering !== s.scheduleId) {
        this.recoverInterrupted(session, s, now);
        continue;
      }
      if (s.status !== "scheduled" && s.status !== "queued") continue;
      if (s.dueAt > now) continue;
      if (now - s.dueAt > this.missedGraceMs && s.attempts.length === 0 && s.repeat) {
        // A repeating message doesn't pile up missed runs: it skips to the next one.
        const missedAt = formatWhen(s.dueAt, now, this.opts.locale);
        const next = this.repeatNext(session, s.scheduleId, now, false);
        this.status(
          session,
          `Rewake: Skipped the run due at ${missedAt}, because Zed or this computer wasn't running then.${next ? ` Next run: ${formatWhen(next, now, this.opts.locale)}.` : ""}`,
        );
        this.refreshMarker(session);
        continue;
      }
      // A resume paused again by the limit is held to its new time as well.
      const late =
        decideFire({
          resume: { dueAt: s.dueAt, status: s.status },
          now,
          alreadySent: false,
          lateMs: this.missedGraceMs,
        }).action === "notify";
      if (late && (s.attempts.length === 0 || s.kind !== "user")) {
        this.store.update(s.scheduleId, (x) => ({ ...x, status: "missed" }), now);
        const when = formatWhen(s.dueAt, now, this.opts.locale);
        if (this.clientSupportsForms && !session.formOpen) {
          void this.offerRetry(
            session,
            s.scheduleId,
            `Rewake: A message scheduled for ${when} wasn't sent, because Zed or this computer wasn't running then: "${preview(s.text)}". Send it now?`,
          );
        } else {
          this.status(
            session,
            `Rewake: Missed. A message scheduled for ${when} wasn't sent because Zed or this computer wasn't running then. ${
              this.menuEnabled(session)
                ? "To send or delete it, use the Rewake menu under the message box."
                : "Type /rewake list, then /rewake now N to send it or /rewake cancel N to delete it."
            }`,
          );
        }
        this.refreshMarker(session);
        continue;
      }
      if (session.userTurn !== undefined || session.delivering) {
        if (s.status !== "queued") {
          this.store.update(s.scheduleId, (x) => ({ ...x, status: "queued" }), now);
          this.status(
            session,
            `Rewake: Queued. A scheduled message is due and will be sent when ${this.agentName} finishes the current reply.`,
          );
        }
        return;
      }
      this.deliver(session, s);
      return; // one delivery at a time per thread
    }
  }

  /**
   * A message left "sending" by a process that's gone (Zed quit during its reply): this process
   * holds the thread now, so it isn't being sent. Ask, rather than resend on its own; a repeating
   * message moves on to its next run.
   */
  private recoverInterrupted(session: SessionState, s: Schedule, now: number): void {
    const due = formatWhen(s.dueAt, now, this.opts.locale);
    if (s.repeat) {
      this.store.update(s.scheduleId, (x) => ({ ...x, status: "failed" }), now);
      this.status(
        session,
        `Rewake: The run due at ${due} was interrupted, because Zed closed during its reply.`,
      );
      this.repeatNext(session, s.scheduleId, now);
    } else {
      this.store.update(
        s.scheduleId,
        (x) => ({ ...x, status: "needs_attention", failureReason: "interrupted" }),
        now,
      );
      const question = `Rewake: The message scheduled for ${due} was interrupted, because Zed closed during its reply: "${preview(s.text)}". Send it again?`;
      if (this.clientSupportsForms && !session.formOpen)
        void this.offerRetry(session, s.scheduleId, question);
      else
        this.status(
          session,
          `Rewake: The message scheduled for ${due} was interrupted, because Zed closed during its reply. Type /rewake list, then /rewake now N to send it again.`,
        );
    }
    this.refreshMarker(session);
  }

  private deliver(session: SessionState, s: Schedule): void {
    const router = this.router;
    if (!router) return;
    const now = this.now();
    const n = s.attempts.length + 1;
    const sending = this.store.update(
      s.scheduleId,
      (x) => ({
        ...x,
        status: "sending",
        attempts: [...x.attempts, { n, idempotencyKey: `${x.scheduleId}:${n}`, startedAt: now }],
      }),
      now,
    );
    if (!sending) return; // deleted in the meantime
    session.delivering = s.scheduleId;
    this.updateWake();
    this.startTurn(session);
    const late = now - s.dueAt > 60_000;
    const what = s.kind === "user" ? "message" : "resume message";
    if (s.attempts.length > 0 && this.shown.has(s.scheduleId)) {
      // Already in the thread from an earlier attempt: say it's going again, don't repeat it.
      this.status(
        session,
        `Rewake: Sending your scheduled ${what} again (shown above). ${this.stopHint(session)}`,
      );
    } else {
      this.shown.add(s.scheduleId);
      this.status(
        session,
        `Rewake: Sending your scheduled ${what}${late ? ` (it was due at ${formatWhen(s.dueAt, now, this.opts.locale)})` : ""}. ${this.stopHint(session)}`,
      );
      router.notifyClient("session/update", {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: randomUUID(),
          content: { type: "text", text: s.text },
        },
      });
    }
    // An automatic resume tells Claude that no human typed it.
    const textForAgent =
      s.kind === "auto_limit_resume"
        ? `${AUTO_LABEL} ${s.text}`
        : s.createdBy === "agent"
          ? `${AGENT_SCHEDULED_LABEL} ${s.text}`
          : s.text;
    const ready = session.needsReattach ? this.reattach(session) : Promise.resolve(true);
    this.opts.log.info("schedule.delivering", { scheduleId: s.scheduleId, attempt: n });
    this.refreshMarker(session);
    void ready
      .then((ok) =>
        ok
          ? router.requestAgent("session/prompt", {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: textForAgent }],
            })
          : ({ error: REATTACH_FAILED } as JsonRpcMessage),
      )
      .then((response) => this.settle(session, s.scheduleId, response));
  }

  private settle(session: SessionState, scheduleId: string, response: JsonRpcMessage): void {
    const now = this.now();
    session.delivering = undefined;
    setImmediate(() => this.updateWake());
    const stopReason = asObject(response.result).stopReason;
    const schedule = this.store.get(scheduleId);
    const limited: LimitClassification = this.classifyTurn(session, response) ?? {
      kind: "other",
      text: "",
    };

    if (
      response.error &&
      schedule &&
      isSessionLost(response.error) &&
      schedule.attempts.length < 2
    ) {
      // The agent lost the session: re-attach before the retry.
      session.needsReattach = true;
      this.store.update(scheduleId, (x) => ({ ...x, status: "scheduled", dueAt: now }), now);
    } else if (limited.kind === "usage_limit" && schedule) {
      // Still limited: follow the new reset time the agent gives, as often as it moves later. Stop
      // and ask only when there's no reset time, or the same one again, which would otherwise
      // retry in a loop.
      const resetAt = this.resolveReset(
        session,
        limited.text,
        schedule.attempts.at(-1)?.startedAt ?? now,
        limited.resetAt,
      );
      const delay = this.threads.get(session.sessionId)?.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS;
      const started = session.limit?.startedAt ?? schedule.createdAt;
      const dueAt = resetAt === undefined ? undefined : this.resumeAt(resetAt);
      const farAway = resetAt !== undefined && resetAt - now > 24 * 3_600_000;
      if (
        schedule.kind === "auto_limit_resume" &&
        farAway &&
        resetAt !== undefined &&
        dueAt !== undefined &&
        dueAt > schedule.dueAt
      ) {
        // Automatic resumes never reach more than a day out on their own: ask once instead.
        this.store.update(
          scheduleId,
          (x) => ({ ...x, status: "needs_attention", failureReason: "reset_far_away" }),
          now,
        );
        void this.confirmFarResume(session, scheduleId, resetAt, dueAt);
      } else if (
        resetAt !== undefined &&
        dueAt !== undefined &&
        dueAt > schedule.dueAt &&
        dueAt > now
      ) {
        this.store.update(scheduleId, (x) => ({ ...x, status: "scheduled", dueAt }), now);
        if (session.limit) session.limit.resetAt = resetAt;
        this.status(
          session,
          `Rewake: Paused again. ${capitalize(this.agentName)} is still at its usage limit, now until ${formatWhen(resetAt, now, this.opts.locale)}. Rewake will try again when it resets.`,
        );
      } else if (
        resetAt === undefined &&
        schedule.kind === "auto_limit_resume" &&
        delay &&
        now + delay - started <= 24 * 3_600_000
      ) {
        // The agent never says when it resets: wait the chosen time again, for up to a day (C2).
        const next = now + delay;
        this.store.update(scheduleId, (x) => ({ ...x, status: "scheduled", dueAt: next }), now);
        this.status(
          session,
          `Rewake: Paused again. ${capitalize(this.agentName)} is still at its usage limit. Rewake will try again at ${formatWhen(next, now, this.opts.locale)}.`,
        );
      } else {
        this.store.update(
          scheduleId,
          (x) => ({ ...x, status: "needs_attention", failureReason: "still_limited" }),
          now,
        );
        if (this.clientSupportsForms && !session.formOpen)
          void this.offerRetry(
            session,
            scheduleId,
            `Rewake: Stopped. ${capitalize(this.agentName)} is still at its usage limit and didn't give a new reset time, so this thread won't continue on its own. Try again now?`,
          );
        else
          this.status(
            session,
            `Rewake: Stopped. ${capitalize(this.agentName)} is still at its usage limit and didn't give a new reset time. This thread won't continue on its own. Type /rewake list, then /rewake now N to try again.`,
          );
      }
    } else if (response.error) {
      this.store.update(
        scheduleId,
        (x) => ({
          ...x,
          status: "failed",
          failureReason: response.error?.message.slice(0, 200) ?? "error",
        }),
        now,
      );
      const said = `${capitalize(this.agentName)} returned an error: "${oneLine(response.error.message)}".`;
      if (schedule?.repeat) this.status(session, `Rewake: Couldn't send this run. ${said}`);
      else if (this.clientSupportsForms && !session.formOpen)
        void this.offerRetry(session, scheduleId, `Rewake: Couldn't send. ${said} Try again?`);
      else
        this.status(
          session,
          `Rewake: Couldn't send. ${said} Type /rewake list to retry with /rewake now N.`,
        );
    } else if (stopReason === "cancelled") {
      this.store.update(scheduleId, (x) => ({ ...x, status: "stopped" }), now);
      const kept = this.keepFollowUps(session, schedule);
      this.status(
        session,
        kept
          ? `Rewake: Stopped the scheduled reply.${kept}`
          : "Rewake: Stopped. The scheduled reply was stopped.",
      );
    } else {
      this.store.update(
        scheduleId,
        ({ followUps: _sent, ...x }) => ({ ...x, status: "sent" }),
        now,
      );
      if (limited.kind === "not_recoverable" && limited.reason === "billing")
        this.onNotResumable(session);
      else if (schedule && schedule.kind !== "user") session.limit = undefined; // the limit episode is over
      // The next waiting message goes now, after this reply, carrying the rest.
      const [next, ...rest] = schedule?.followUps ?? [];
      if (schedule && next)
        this.store.create({
          sessionId: session.sessionId,
          cwd: session.cwd,
          text: next,
          dueAt: now,
          createdBy: schedule.createdBy,
          now,
          followUps: rest,
        });
    }
    // A finished run of a repeating message moves on; one waiting for a limit reset stays put.
    const after = this.store.get(scheduleId)?.status;
    if (schedule?.repeat && (after === "sent" || after === "failed" || after === "stopped"))
      this.repeatNext(session, scheduleId, now);
    this.refreshMarker(session);
    this.opts.log.info("schedule.settled", {
      scheduleId,
      outcome: response.error || limited.kind !== "other" ? limited.kind : String(stopReason),
    });
    const held = session.heldPrompts.shift();
    if (held) {
      session.userTurn = held.id ?? undefined;
      session.userTurnStartedAt = this.now();
      session.userTurnCommand = promptText(asObject(held.params).prompt).trim().startsWith("/");
      this.startTurn(session);
      this.router?.forwardClientRequest(held);
    } else {
      setImmediate(() => this.deliverDue(session));
    }
  }

  /**
   * Move a repeating schedule to its next run after a run finished (`ran`) or was skipped. Its end
   * rule counts finished runs and stops at `until`: after the last run the schedule
   * keeps that run's outcome; a skipped last run is marked missed, so the user can still send it.
   * Returns the next run, if any.
   */
  private repeatNext(
    session: SessionState,
    scheduleId: string,
    now: number,
    ran = true,
  ): number | undefined {
    const s = this.store.get(scheduleId);
    const parsed = s?.repeat ? parseCron(s.repeat.cron) : undefined;
    if (!s?.repeat || !parsed?.ok) return undefined;
    // Only "sent", "failed" and "stopped" runs (and skipped ones) move on; others keep their state.
    if (!["sent", "failed", "stopped", "scheduled", "queued"].includes(s.status)) return undefined;
    const remaining =
      s.repeat.remaining === undefined ? undefined : s.repeat.remaining - (ran ? 1 : 0);
    const lastRun = { at: s.dueAt, outcome: ran ? s.status : ("skipped" as const) };
    const next = nextRun(parsed.cron, Math.max(now, s.dueAt));
    const until = s.repeat.until;
    if (next === undefined || remaining === 0 || (until !== undefined && next > until)) {
      if (!ran) this.store.update(scheduleId, (x) => ({ ...x, status: "missed", lastRun }), now);
      else {
        this.store.update(scheduleId, (x) => ({ ...x, lastRun }), now);
        if (next !== undefined)
          this.status(session, "Rewake: That was the last run of this repeating message.");
      }
      return undefined;
    }
    this.store.update(
      scheduleId,
      (x) => ({
        ...x,
        status: "scheduled",
        dueAt: next,
        attempts: [],
        lastRun,
        ...(x.repeat && {
          repeat: { ...x.repeat, ...(remaining !== undefined && { remaining }) },
        }),
      }),
      now,
    );
    if (ran) this.status(session, `Rewake: Next run: ${formatWhen(next, now, this.opts.locale)}.`);
    return next;
  }

  /**
   * Thread-title marker: "Running scheduled", "Needs you" or
   * "Scheduled 09:00". Sent only when it changes, and only once the agent has given the thread a
   * title to restore. A title the user set in Zed always wins (Zed's title_override).
   */
  refreshMarker(session: SessionState): void {
    this.refreshMenu(session);
    if (this.opts.titleMarkers !== true || session.baseTitle === undefined) return;
    const marker = this.markerFor(session);
    if (marker === session.marker) return;
    session.marker = marker;
    this.router?.notifyClient("session/update", {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: marker ? `${marker} · ${session.baseTitle}` : session.baseTitle,
      },
    });
  }

  private markerFor(session: SessionState): string | undefined {
    if (session.delivering) return "Running scheduled";
    const list = this.pending(session);
    if (list.some((s) => s.status === "missed" || s.status === "needs_attention"))
      return "Needs you";
    const next = list.find((s) => s.status === "scheduled" || s.status === "queued");
    if (!next) return undefined;
    const now = this.now();
    const time = formatClock(next.dueAt);
    const sameDay = new Date(next.dueAt).toDateString() === new Date(now).toDateString();
    const day = sameDay
      ? ""
      : `${new Intl.DateTimeFormat(this.opts.locale ?? TEXT_LOCALE, { weekday: "short" }).format(next.dueAt)} `;
    return `${next.kind === "user" ? "Scheduled" : "Resume"} ${day}${time}`;
  }

  private status(session: SessionState, text: string): void {
    this.router?.notifyClient("session/update", {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: randomUUID(),
        content: { type: "text", text },
      },
    });
  }
}

const STATUS_WORD: Record<Schedule["status"], string> = {
  scheduled: "scheduled",
  paused: "paused",
  queued: "queued (waiting for the current reply)",
  waiting_for_limit: "waiting for the usage limit",
  sending: "sending",
  sent: "sent",
  failed: "failed",
  missed: "missed",
  stopped: "stopped",
  cancelled: "cancelled",
  needs_attention: "needs you",
};

/** `/rewake help` in the thread: in a text block, so Zed keeps the columns and the <placeholders>. */
function helpBlock(): string {
  const [, ...rest] = rewakeHelp(ACP_PLACE).split("\n");
  return `Rewake: ${ACP_PLACE.typed} in this thread:\n\n\`\`\`text\n${rest.join("\n").trim()}\n\`\`\``;
}

function mergeCommands(agentCommands: unknown[]): unknown[] {
  const ours = new Set(REWAKE_COMMANDS.map((c) => c.name));
  const theirs = agentCommands.filter(
    (c) => !(c && typeof c === "object" && ours.has(String((c as { name?: unknown }).name))),
  );
  return [...theirs, ...REWAKE_COMMANDS];
}

/** The current value of the adapter's permission-mode option (category "mode"). */
function modeFrom(configOptions: unknown): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const mode = configOptions.find((o) => asObject(o).category === "mode");
  const value = asObject(mode).currentValue;
  return typeof value === "string" ? value : undefined;
}

function replaceUpdate(
  m: JsonRpcMessage,
  params: Record<string, unknown>,
  update: Record<string, unknown>,
): Action {
  return { kind: "replace", message: { ...m, params: { ...params, update } } };
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  const first = prompt.find(
    (b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text",
  ) as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** ", ending after 3 runs", ", until 09:00 on …": a repeat's end, for forms. */
function endsText(
  until: number | undefined,
  times: number | undefined,
  now: number,
  locale?: string,
): string {
  const parts: string[] = [];
  if (times !== undefined) parts.push(`after ${times} run${times === 1 ? "" : "s"}`);
  if (until !== undefined) parts.push(`no later than ${formatWhen(until, now, locale)}`);
  return parts.length > 0 ? `, ending ${parts.join(" or ")}` : "";
}

function preview(text: string): string {
  const one = oneLine(text);
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The agent no longer knows the session (claude-agent-acp evicts it when its process dies; zed#55501). */
/**
 * Waits offered when an agent doesn't say when its limit resets. The
 * second is the default.
 */
/** " (then 2 more)" after a message that has others waiting behind it. */
function followUpNote(s: Schedule): string {
  const n = s.followUps?.length ?? 0;
  return n === 0 ? "" : ` (then ${n} more ${n === 1 ? "message" : "messages"})`;
}

/** The one Settings question about automatic resume. */
type AutoResumeChoice = "all" | "exceptBypass" | "ask" | "off";

/** How long after a session opens Rewake sends its commands again (zed#59281). */
const COMMANDS_RESEND_MS = 400;

/** The wait automatic resume uses when the agent gives no reset time and none was ever picked. */
const DEFAULT_RESUME_DELAY_MS = 60 * 60_000;

const UNKNOWN_RESET_DELAYS: Array<[number, string]> = [
  [30 * 60_000, "In 30 minutes"],
  [60 * 60_000, "In 1 hour"],
  [3 * 3_600_000, "In 3 hours"],
  [5 * 3_600_000, "In 5 hours"],
];

/** How far ahead a due message keeps the computer awake: covers a 5-hour limit. */
const WAKE_HORIZON_MS = 6 * 3_600_000;

/** Resumes that will still run on their own. */
const LIVE_RESUME: ReadonlySet<Schedule["status"]> = new Set([
  "scheduled",
  "queued",
  "sending",
  "waiting_for_limit",
]);

/** How much of the agent's last message is kept: enough for any limit text. */
const MESSAGE_KEPT = 4000;

/** A mode that skips permission prompts, in any agent's words. */
function isBypassMode(mode: string | undefined): boolean {
  return !!mode && /bypass|full.?access|yolo|dangerous|skip.?permission/i.test(mode);
}

const REATTACH_FAILED = {
  code: -32603,
  message: "Rewake couldn't reconnect this thread to the agent.",
  data: {
    details:
      "Rewake: Couldn't reconnect. The agent lost this session and it couldn't be reopened. Your conversation is saved in the agent's history: start a new thread, or use Zed's Reload Agent.",
  },
};
