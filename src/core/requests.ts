import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../util/paths.js";
import { MAX_TEXT_BYTES, writeFileAtomic } from "./store.js";

/**
 * Requests from the agent: the agent's tool server writes one file per request,
 * the Rewake process that owns the thread asks the user in the thread and writes the answer
 * back, and the tool server returns that answer to the agent. Nothing is scheduled or deleted
 * until the user accepts.
 */
export interface AgentRequest {
  schemaVersion: 1;
  requestId: string;
  sessionId: string;
  kind: "schedule" | "cancel" | "update";
  /** schedule, update: the message, its (next) run and an optional repeat. */
  message?: string;
  dueAt?: number;
  cron?: string;
  /** schedule, update: when a repeat ends. */
  until?: number;
  times?: number;
  /** update: turn the repeat off; pause (true) or resume (false). */
  stopRepeating?: boolean;
  paused?: boolean;
  /** cancel, update: which scheduled message. schedule: the one created, once approved. */
  scheduleId?: string;
  /** schedule: a scheduled message in the thread with the same text, shown to the user. */
  duplicateOf?: string;
  /** Why the agent asks, in its own words (shown to the user). */
  reason?: string;
  status: "pending" | "approved" | "declined";
  /** What the user decided, in words for the agent. */
  answer?: string;
  createdAt: number;
}

export class RequestStore {
  readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "requests");
  }

  create(input: Omit<AgentRequest, "schemaVersion" | "requestId" | "status">): AgentRequest {
    const r: AgentRequest = {
      ...input,
      schemaVersion: 1,
      requestId: randomUUID(),
      status: "pending",
    };
    if (r.message !== undefined && Buffer.byteLength(r.message) > MAX_TEXT_BYTES)
      throw new Error("The message is too long.");
    this.put(r);
    return r;
  }

  put(r: AgentRequest): void {
    writeFileAtomic(ensurePrivateDir(this.dir), `${r.requestId}.json`, `${JSON.stringify(r)}\n`);
  }

  get(requestId: string): AgentRequest | undefined {
    if (!/^[0-9a-f-]{36}$/.test(requestId)) return undefined;
    try {
      const r = JSON.parse(
        readFileSync(join(this.dir, `${requestId}.json`), "utf8"),
      ) as AgentRequest;
      return r.schemaVersion === 1 && r.requestId === requestId ? r : undefined;
    } catch {
      return undefined;
    }
  }

  pendingFor(sessionId: string): AgentRequest[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .map((n) => this.get(n.slice(0, -5)))
      .filter((r): r is AgentRequest => r?.sessionId === sessionId && r.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  remove(requestId: string): void {
    if (/^[0-9a-f-]{36}$/.test(requestId))
      rmSync(join(this.dir, `${requestId}.json`), { force: true });
  }
}

/**
 * Links a tool-server process to its thread. Rewake gives the tool server a random token when it
 * opens a session, and records token → session here once the session id is known.
 */
export class LinkStore {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "links");
  }

  set(token: string, sessionId: string, cwd: string): void {
    if (!/^[0-9a-f-]{36}$/.test(token)) return;
    writeFileAtomic(
      ensurePrivateDir(this.dir),
      `${token}.json`,
      `${JSON.stringify({ sessionId, cwd })}\n`,
    );
  }

  get(token: string): { sessionId: string; cwd: string } | undefined {
    if (!/^[0-9a-f-]{36}$/.test(token)) return undefined;
    try {
      const v = JSON.parse(readFileSync(join(this.dir, `${token}.json`), "utf8"));
      return typeof v.sessionId === "string"
        ? { sessionId: v.sessionId, cwd: String(v.cwd ?? "") }
        : undefined;
    } catch {
      return undefined;
    }
  }
}
