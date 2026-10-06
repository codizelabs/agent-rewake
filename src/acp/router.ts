import type { Readable, Writable } from "node:stream";
import {
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type Line,
  LineWriter,
  readLines,
} from "./ndjson.js";

/** What to do with an intercepted message. */
export type Action =
  | { kind: "forward" }
  | { kind: "consume" }
  | { kind: "replace"; message: JsonRpcMessage };

export const FORWARD: Action = { kind: "forward" };
export const CONSUME: Action = { kind: "consume" };

export interface RouterHooks {
  /** A message from the client (Zed) on its way to the agent. */
  onClientMessage?(message: JsonRpcMessage): Action;
  /** A message from the agent on its way to the client. */
  onAgentMessage?(message: JsonRpcMessage): Action;
  /**
   * The agent's response to a client request, with the request's method and params.
   * Return a replacement message to rewrite it, undefined to forward it unchanged, or null to
   * drop it (the hook will answer the client itself, e.g. after re-attaching a lost session).
   */
  onAgentResponse?(
    method: string,
    params: unknown,
    response: JsonRpcMessage,
  ): JsonRpcMessage | undefined | null;
}

export interface RouterOptions {
  clientIn: Readable;
  clientOut: Writable;
  agentIn: Readable;
  agentOut: Writable;
  hooks?: RouterHooks;
  /** Called with metadata only (direction, method, id) — never message content. */
  onTraffic?: (event: TrafficEvent) => void;
  onClientEnd?: () => void;
  onAgentEnd?: () => void;
}

export interface TrafficEvent {
  direction: "client->agent" | "agent->client" | "rewake->agent" | "rewake->client";
  kind: "request" | "notification" | "response" | "invalid";
  method?: string;
  id?: JsonRpcId;
  action: Action["kind"];
}

/** Prefix for request ids that Agent Rewake itself originates. */
export const REWAKE_ID_PREFIX = "agent-rewake:";

const key = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

interface Pending {
  resolve: (response: JsonRpcMessage) => void;
}

/**
 * Transparent JSON-RPC relay between an ACP client (stdin/stdout from Zed) and an ACP agent
 * (a child process). Everything not intercepted by a hook is forwarded byte-for-byte.
 */
/** A client request that was waiting for the agent when the agent was replaced. */
export interface InFlightRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export class Router {
  private readonly toClient: LineWriter;
  private toAgent: LineWriter;
  /** Increments when the agent is replaced, so lines from a dead agent are ignored. */
  private agentGeneration = 0;
  /** Client requests awaiting an agent response: id → method and params. */
  private readonly clientRequests = new Map<string, InFlightRequest>();
  /** Requests Rewake sent to the agent / client, awaiting responses. */
  private readonly ownToAgent = new Map<string, Pending>();
  private readonly ownToClient = new Map<string, Pending>();
  private nextId = 1;

  constructor(private readonly opts: RouterOptions) {
    this.toClient = new LineWriter(opts.clientOut);
    this.toAgent = new LineWriter(opts.agentOut);
  }

  start(): void {
    readLines(
      this.opts.clientIn,
      (line) => this.fromClient(line),
      () => this.opts.onClientEnd?.(),
    );
    this.readAgent(this.opts.agentIn);
  }

  private readAgent(agentIn: Readable): void {
    const generation = this.agentGeneration;
    readLines(
      agentIn,
      (line) => {
        if (generation === this.agentGeneration) this.fromAgent(line);
      },
      () => {
        if (generation === this.agentGeneration) this.opts.onAgentEnd?.();
      },
    );
  }

  /**
   * Switch to a new agent process. Rewake's own pending requests to the old agent
   * fail; client requests that were waiting are returned so the caller can retry or answer them.
   */
  replaceAgent(agentIn: Readable, agentOut: Writable): InFlightRequest[] {
    this.agentGeneration += 1;
    this.toAgent = new LineWriter(agentOut);
    for (const pending of this.ownToAgent.values()) {
      pending.resolve({ error: { code: -32603, message: "The agent restarted." } });
    }
    this.ownToAgent.clear();
    const inFlight = [...this.clientRequests.values()];
    this.clientRequests.clear();
    this.readAgent(agentIn);
    return inFlight;
  }

  /** Send a request to the agent on Rewake's own behalf. The response is never forwarded. */
  requestAgent(method: string, params: unknown): Promise<JsonRpcMessage> {
    return this.ownRequest(this.toAgent, this.ownToAgent, "rewake->agent", method, params);
  }

  /** Send a request to the client on Rewake's own behalf (e.g. elicitation/create). */
  requestClient(method: string, params: unknown): Promise<JsonRpcMessage> {
    return this.ownRequest(this.toClient, this.ownToClient, "rewake->client", method, params);
  }

  notifyClient(method: string, params: unknown): void {
    this.toClient.write({ method, params });
    this.trace({ direction: "rewake->client", kind: "notification", method, action: "forward" });
  }

  notifyAgent(method: string, params: unknown): void {
    this.toAgent.write({ method, params });
    this.trace({ direction: "rewake->agent", kind: "notification", method, action: "forward" });
  }

  /**
   * Forward a client request that a hook consumed earlier (e.g. a user message held back while a
   * scheduled reply was running). Its response is routed back to the client as usual.
   */
  forwardClientRequest(message: JsonRpcMessage): void {
    if (message.id != null && message.method) {
      this.clientRequests.set(key(message.id), {
        id: message.id,
        method: message.method,
        params: message.params,
      });
    }
    this.toAgent.write(message);
    this.trace({
      direction: "client->agent",
      kind: kindOf(message),
      ...(message.method !== undefined && { method: message.method }),
      ...(message.id != null && { id: message.id }),
      action: "forward",
    });
  }

  /** Answer a client request that a hook consumed. */
  respondToClient(
    id: JsonRpcId,
    outcome: { result: unknown } | { error: NonNullable<JsonRpcMessage["error"]> },
  ): void {
    this.toClient.write({ id, ...outcome });
  }

  private ownRequest(
    writer: LineWriter,
    pending: Map<string, Pending>,
    direction: TrafficEvent["direction"],
    method: string,
    params: unknown,
  ): Promise<JsonRpcMessage> {
    const id = `${REWAKE_ID_PREFIX}${this.nextId++}`;
    return new Promise((resolve) => {
      pending.set(key(id), { resolve });
      writer.write({ id, method, params });
      this.trace({ direction, kind: "request", method, id, action: "forward" });
    });
  }

  private fromClient({ raw, message }: Line): void {
    if (!message) {
      this.trace({ direction: "client->agent", kind: "invalid", action: "forward" });
      this.toAgent.writeRaw(raw);
      return;
    }
    // A response from the client to a request Rewake originated.
    if (isResponse(message) && message.id !== undefined && message.id !== null) {
      const own = this.ownToClient.get(key(message.id));
      if (own) {
        this.ownToClient.delete(key(message.id));
        this.trace({
          direction: "client->agent",
          kind: "response",
          id: message.id,
          action: "consume",
        });
        own.resolve(message);
        return;
      }
    }
    const action = this.opts.hooks?.onClientMessage?.(message) ?? FORWARD;
    if (action.kind !== "consume" && isRequest(message) && message.id != null && message.method) {
      this.clientRequests.set(key(message.id), {
        id: message.id,
        method: message.method,
        params: message.params,
      });
    }
    this.trace({
      direction: "client->agent",
      kind: kindOf(message),
      ...(message.method !== undefined && { method: message.method }),
      ...(message.id != null && { id: message.id }),
      action: action.kind,
    });
    this.apply(action, raw, this.toAgent);
  }

  private fromAgent({ raw, message }: Line): void {
    if (!message) {
      this.trace({ direction: "agent->client", kind: "invalid", action: "forward" });
      this.toClient.writeRaw(raw);
      return;
    }
    if (isResponse(message) && message.id !== undefined && message.id !== null) {
      const own = this.ownToAgent.get(key(message.id));
      if (own) {
        this.ownToAgent.delete(key(message.id));
        this.trace({
          direction: "agent->client",
          kind: "response",
          id: message.id,
          action: "consume",
        });
        own.resolve(message);
        return;
      }
      const request = this.clientRequests.get(key(message.id));
      if (request) {
        this.clientRequests.delete(key(message.id));
        const replaced = this.opts.hooks?.onAgentResponse?.(
          request.method,
          request.params,
          message,
        );
        const action: Action =
          replaced === null ? CONSUME : replaced ? { kind: "replace", message: replaced } : FORWARD;
        this.trace({
          direction: "agent->client",
          kind: "response",
          method: request.method,
          id: message.id,
          action: action.kind,
        });
        this.apply(action, raw, this.toClient);
        return;
      }
    }
    const action = this.opts.hooks?.onAgentMessage?.(message) ?? FORWARD;
    this.trace({
      direction: "agent->client",
      kind: kindOf(message),
      ...(message.method !== undefined && { method: message.method }),
      ...(message.id != null && { id: message.id }),
      action: action.kind,
    });
    this.apply(action, raw, this.toClient);
  }

  private apply(action: Action, raw: string, writer: LineWriter): void {
    if (action.kind === "forward") writer.writeRaw(raw);
    else if (action.kind === "replace") writer.write(action.message);
  }

  private trace(event: TrafficEvent): void {
    this.opts.onTraffic?.(event);
  }
}

function kindOf(m: JsonRpcMessage): TrafficEvent["kind"] {
  if (isRequest(m)) return "request";
  if (isNotification(m)) return "notification";
  if (isResponse(m)) return "response";
  return "invalid";
}
