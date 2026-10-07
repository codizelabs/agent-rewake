import { basename } from "node:path";
import { decideArm, FAR_RESET_MS, RESET_MARGIN_MS } from "../core/resume.js";
import { loadSettings, type Settings } from "../core/settings.js";
import { type Schedule, ScheduleStore, TERMINAL_STATUSES } from "../core/store.js";
import { DEFAULT_RESUME_PROMPT } from "../core/threads.js";
import { formatAt } from "../core/time.js";
import { type AgentProcess, stillRunning } from "../util/proc.js";
import type { HostAdapter, HostFacts, SendResult } from "./host.js";
import { type SessionLimit, type SessionRecord, SessionRecords } from "./sessions.js";

/**
 * The hosts whose sessions Rewake continues after they're closed: Copilot CLI, Grok, Gemini CLI,
 * Antigravity CLI. Their hooks record the session (open or closed, when the person last typed,
 * the last usage limit); when the person agrees, a one-shot timer runs `fire`, which resumes the
 * closed session headless with the agent's own resume command. An open session is never written
 * to (one writer): the person is told instead.
 *
 * The person agrees in one of two ways: automatic resume is on and the reset is within a day
 * (rule 2), or they run `agent-rewake continue` (src/continue.ts), which the notification at the
 * end of the session names.
 */

/** Set by `fire` on the agent it starts, so that run's own hooks aren't taken for the person. */
export const FIRE_ENV = "AGENT_REWAKE_FIRE";

export interface ClosedHost {
  id: string;
  /** As people know it: "GitHub Copilot CLI". */
  name: string;
  /**
   * Continue the session headless. Resolves with the agent's verdict: "limited" when the run hit
   * the usage limit again (Rewake waits and tries later).
   */
  resume(record: SessionRecord, text: string, env: NodeJS.ProcessEnv): Promise<SendResult>;
  /** Whether the agent itself says the session is open (beyond Rewake's own record). */
  isOpen?(record: SessionRecord): boolean;
  /** How the person gets back into a closed session: 'resume it with "copilot --resume"'. */
  reopen?: string;
}

export interface ClosedDeps {
  stateDir: string;
  now: number;
  env: NodeJS.ProcessEnv;
  arm: (id: string, at: number) => void;
  disarm: (id: string) => void;
  notify: (title: string, body: string) => void;
  /** The agent process running this hook (src/util/proc.ts); absent where unknown. */
  agent?: () => AgentProcess | undefined;
  /** Whether a recorded agent process still runs (tests replace it). */
  running?: (p: AgentProcess) => boolean;
}

/** The agent processes a record has seen open the session (one, in records of earlier versions). */
function agentsOf(r: SessionRecord): AgentProcess[] {
  if (r.agents) return r.agents;
  return r.agentPid !== undefined && r.agentName ? [{ pid: r.agentPid, name: r.agentName }] : [];
}

/**
 * Whether a session is still open: its record says so and, when Rewake saw the agents' processes at
 * session start, one of them still runs. A session whose agent crashed or was killed never ran
 * its session-end hook, and would otherwise stay "open" for ever.
 */
export function stillOpen(
  r: SessionRecord,
  running: (p: AgentProcess) => boolean = (p) => stillRunning(p),
): boolean {
  if (!r.open) return false;
  const agents = agentsOf(r);
  return agents.length === 0 || agents.some(running);
}

/** "GitHub Copilot CLI in shop": the agent and the project folder's name. */
export function placeOf(host: Pick<ClosedHost, "name">, cwd: string): string {
  const folder = cwd ? basename(cwd) : "";
  return folder ? `${host.name} in the "${folder}" folder` : host.name;
}

/**
 * Resumes still to come for a session. Missed ones and ones that need the person's attention were
 * already reported: they don't stand in the way of a new limit.
 */
export function pendingFor(stateDir: string, host: string, sessionId: string): Schedule[] {
  return new ScheduleStore(stateDir)
    .listForSession(sessionId, host)
    .filter((s) => !TERMINAL_STATUSES.has(s.status) && !REPORTED.has(s.status));
}

const REPORTED = new Set<Schedule["status"]>(["missed", "needs_attention"]);

/** A limit the person hasn't answered: not billing, not followed by a prompt, nothing armed. */
export function unanswered(stateDir: string, r: SessionRecord): SessionLimit | undefined {
  const l = r.limit;
  if (!l || l.billing) return undefined;
  if ((r.lastPromptAt ?? 0) > l.seenAt) return undefined;
  if (pendingFor(stateDir, r.host, r.sessionId).length > 0) return undefined;
  return l;
}

/**
 * Automatic resume outside Zed, from the same setting as Zed's new threads. Zed's "except when
 * permissions are bypassed" doesn't apply: a resume outside Zed never bypasses permissions (each
 * agent is run with its default approval mode), so "on" means on.
 */
export function autoFor(settings: Settings): "always" | "never" | "ask" {
  return settings.newThreads === "on" ? "always" : settings.newThreads === "off" ? "never" : "ask";
}

/** What Rewake says once a closed session's resume is armed. */
export function armedText(host: ClosedHost, cwd: string, at: number, now: number): string {
  return `Rewake will continue ${placeOf(host, cwd)} ${formatAt(at, now)}. Keep this computer on and awake until then. Reopening that session and typing in it before then cancels this resume. To cancel all planned resumes: agent-rewake continue --cancel`;
}

/** Arm a resume of a closed session at `at`. */
export function armClosed(host: ClosedHost, r: SessionRecord, at: number, d: ClosedDeps): Schedule {
  const store = new ScheduleStore(d.stateDir);
  const settings = loadSettings(d.stateDir);
  const s = store.create({
    sessionId: r.sessionId,
    cwd: r.cwd,
    text: settings.resumePrompt ?? DEFAULT_RESUME_PROMPT,
    dueAt: at,
    kind: "limit_resume",
    createdBy: "auto",
    now: d.now,
  });
  const resume: Schedule = {
    ...s,
    host: host.id,
    sessionRef: { sessionId: r.sessionId, cwd: r.cwd },
  };
  store.put(resume);
  d.arm(resume.scheduleId, at);
  return resume;
}

/** What each hook event does to the session's record. */
export function onSessionStart(
  host: ClosedHost,
  sessionId: string,
  cwd: string,
  d: ClosedDeps,
  program?: string,
): void {
  // Rewake's own resume run isn't the person opening the session. Marked open, the session would
  // stay so when the run ends without a session-end hook (Gemini CLI skips it when a headless run
  // stops at an API error), and every later resume would be held back as "open".
  if (d.env[FIRE_ENV]) return;
  const agent = d.agent?.();
  const running = d.running ?? ((p: AgentProcess) => stillRunning(p));
  new SessionRecords(d.stateDir, host.id).update(sessionId, cwd, d.now, (r) => {
    const { agentPid: _p, agentName: _n, agents: _a, ...rest } = r;
    // The same session still open in another terminal stays counted.
    const others = r.open ? agentsOf(r).filter((p) => p.pid !== agent?.pid && running(p)) : [];
    const agents = agent ? [...others, agent] : others;
    return {
      ...rest,
      open: true,
      openedAt: d.now,
      ...(program && { program }),
      ...(agents.length > 0 && { agents }),
    };
  });
}

/**
 * Fill in the agent's program when the record has none: any hook can find it, and the session-start
 * hook may race another one or be missed.
 */
export function ensureProgram(
  host: ClosedHost,
  sessionId: string,
  cwd: string,
  d: ClosedDeps,
  program: () => string | undefined,
): void {
  const records = new SessionRecords(d.stateDir, host.id);
  if (records.get(sessionId)?.program) return;
  const found = program();
  if (found)
    records.update(sessionId, cwd, d.now, (r) => (r.program ? r : { ...r, program: found }));
}

export function onPrompt(host: ClosedHost, sessionId: string, cwd: string, d: ClosedDeps): void {
  // Rewake's own resume run sends the continue message: that isn't the person typing.
  if (d.env[FIRE_ENV]) return;
  new SessionRecords(d.stateDir, host.id).update(sessionId, cwd, d.now, (r) => ({
    ...r,
    open: true,
    lastPromptAt: d.now,
  }));
  // The person carried on: a pending resume of this session is no longer wanted.
  const store = new ScheduleStore(d.stateDir);
  for (const s of pendingFor(d.stateDir, host.id, sessionId)) {
    store.update(s.scheduleId, (x) => ({ ...x, status: "cancelled" }), d.now);
    d.disarm(s.scheduleId);
  }
}

export function onLimit(
  host: ClosedHost,
  sessionId: string,
  cwd: string,
  limit: Omit<SessionLimit, "seenAt">,
  d: ClosedDeps,
): void {
  new SessionRecords(d.stateDir, host.id).update(sessionId, cwd, d.now, (r) => ({
    ...r,
    limit: { ...limit, seenAt: d.now },
  }));
}

/**
 * The session closed. A limit nobody answered is armed when automatic resume is on and the reset
 * is within a day; otherwise one notification says how to continue it.
 */
export function onSessionEnd(
  host: ClosedHost,
  sessionId: string,
  cwd: string,
  d: ClosedDeps,
): void {
  const agent = d.env[FIRE_ENV] ? undefined : d.agent?.();
  const running = d.running ?? ((p: AgentProcess) => stillRunning(p));
  const r = new SessionRecords(d.stateDir, host.id).update(sessionId, cwd, d.now, (x) => {
    // Still open in another terminal: closing one isn't the end of the session.
    const left = agent ? agentsOf(x).filter((p) => p.pid !== agent.pid && running(p)) : [];
    if (x.open && left.length > 0) return { ...x, agents: left };
    const { agentPid: _p, agentName: _n, agents: _a, ...rest } = x;
    return { ...rest, open: false, closedAt: d.now };
  });
  if (!r || r.open || d.env[FIRE_ENV]) return;
  followLaterReset(host, r, d);
  const limit = unanswered(d.stateDir, r);
  if (!limit) return;
  const settings = loadSettings(d.stateDir);
  const decision = decideArm({
    now: d.now,
    ...(limit.resetsAt !== undefined && { resetsAt: limit.resetsAt }),
    isBilling: false,
    auto: autoFor(settings),
  });
  if (decision.action === "arm") {
    armClosed(host, r, decision.fireAt, d);
    d.notify("Agent Rewake", armedText(host, r.cwd, decision.fireAt, d.now));
    return;
  }
  if (decision.action !== "offer") return;
  const how = limit.resetsAt
    ? `to continue it ${formatAt(limit.resetsAt + RESET_MARGIN_MS, d.now)}, after the limit resets`
    : "and choose when to continue it";
  d.notify(
    "Agent Rewake",
    `${placeOf(host, r.cwd)} hit its usage limit. Run "agent-rewake continue" ${how}.`,
  );
}

/**
 * A limit seen after a resume was planned, with a later reset (Antigravity has no prompt hook, so
 * carrying on into a new limit doesn't cancel the resume): the resume moves to the new reset, or,
 * when that is more than a day away, is cancelled so the limit is offered like a new one.
 */
function followLaterReset(host: ClosedHost, r: SessionRecord, d: ClosedDeps): void {
  const l = r.limit;
  if (!l || l.billing || l.resetsAt === undefined) return;
  const at = l.resetsAt + RESET_MARGIN_MS;
  const store = new ScheduleStore(d.stateDir);
  for (const s of pendingFor(d.stateDir, host.id, r.sessionId)) {
    if (s.status !== "scheduled" || l.seenAt <= s.createdAt || at <= s.dueAt) continue;
    if (l.resetsAt - d.now > FAR_RESET_MS) {
      store.update(s.scheduleId, (x) => ({ ...x, status: "cancelled" }), d.now);
      d.disarm(s.scheduleId);
      continue;
    }
    store.update(s.scheduleId, (x) => ({ ...x, dueAt: at }), d.now);
    d.arm(s.scheduleId, at);
    d.notify("Agent Rewake", armedText(host, r.cwd, at, d.now));
  }
}

/** The `fire` side for a closed-session host. */
export function closedAdapter(
  host: ClosedHost,
  stateDir: string,
  env: NodeJS.ProcessEnv,
): HostAdapter {
  const records = new SessionRecords(stateDir, host.id);
  return {
    id: host.id,
    name: host.name,
    noun: "session",
    reopen: host.reopen ?? `open the session in ${host.name}`,
    async check(s): Promise<HostFacts> {
      const r = records.get(s.sessionRef?.sessionId ?? s.sessionId);
      if (!r) return {};
      return {
        userTypedSince: (r.lastPromptAt ?? 0) > s.createdAt,
        sessionOpen: stillOpen(r) || host.isOpen?.(r) === true,
      };
    },
    async send(s): Promise<SendResult> {
      const r = records.get(s.sessionRef?.sessionId ?? s.sessionId);
      if (!r) return { ok: false, reason: "closed", detail: "deleted" };
      return host.resume(r, s.text, { ...env, [FIRE_ENV]: s.scheduleId });
    },
  };
}

/**
 * Sessions whose agent is gone though their session-end hook never ran: handled now as closed, so
 * a limit in them is armed or offered as at a normal end. Run by every hook and command that sweeps.
 */
export function reapClosed(hosts: readonly ClosedHost[], d: ClosedDeps): number {
  let n = 0;
  for (const host of hosts)
    for (const r of new SessionRecords(d.stateDir, host.id).list()) {
      if (!r.open || agentsOf(r).length === 0 || stillOpen(r, d.running)) continue;
      onSessionEnd(host, r.sessionId, r.cwd, { ...d, env: {} });
      n++;
    }
  return n;
}
