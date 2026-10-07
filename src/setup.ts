import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { AGENT_NAME, unwrappedEntry } from "./install.js";
import { readText } from "./util/fs.js";
import { CLAUDE_REGISTRY_ID, registryAgent } from "./wrap.js";

/**
 * Where Rewake can work for this person, for `doctor` and `install`. It reads only a few keys of
 * Zed's settings.json (the file `install` edits) and Rewake's own logs: never their values beyond
 * on/off, never Zed's databases or threads, and nothing about other apps.
 *
 * Facts it relies on (Zed 1.22.0, 2026-09-30):
 *   - `disable_ai: true` turns off every AI feature, the Agent Panel included (assets/settings/default.json).
 *   - `agent.enabled: false` turns off the agent (same file).
 *   - `agent.default_model` is the model of Zed's own agent; it's in a person's settings when they
 *     picked one (Zed's default isn't written there).
 *   - Zed starts an external agent only when a thread with it is opened or started; opening the
 *     Agent Panel connects only Zed's own agent (agent_panel.rs `ensure_native_agent_connection`,
 *     conversation_view.rs `request_connection`). So restarting Zed alone never starts Rewake.
 */
export interface ZedSetup {
  /** Zed's settings file: not there yet, not valid JSON, or read. */
  settings: "missing" | "invalid" | "ok";
  /** `disable_ai: true`: Zed's AI features, the Agent Panel included, are off. */
  aiOff: boolean;
  /** `agent.enabled: false`: the agent is off. */
  agentOff: boolean;
  /** External agents in Zed's settings, by id (Rewake's earlier separate agent left out). */
  agents: string[];
  /** Of those, the ones that run through Rewake. */
  withRewake: string[];
  /** The person picked a model for Zed's own agent, so they probably use it. */
  usesZedAgent: boolean;
  /** When Zed last started Rewake, from Rewake's own logs. */
  lastStart?: { at: number; agent: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function detectSetup(zedConfigDir: string, stateDir: string): ZedSetup {
  const file = join(zedConfigDir, "settings.json");
  const setup: ZedSetup = {
    settings: "missing",
    aiOff: false,
    agentOff: false,
    agents: [],
    withRewake: [],
    usesZedAgent: false,
  };
  const started = lastStart(stateDir);
  if (started) setup.lastStart = started;
  if (!existsSync(file)) return setup;
  const errors: ParseError[] = [];
  const value = parse(readText(file) || "{}", errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) return { ...setup, settings: "invalid" };
  setup.settings = "ok";
  setup.aiOff = value.disable_ai === true;
  const agent = isRecord(value.agent) ? value.agent : {};
  setup.agentOff = agent.enabled === false;
  setup.usesZedAgent = isRecord(agent.default_model);
  const servers = isRecord(value.agent_servers) ? value.agent_servers : {};
  for (const [id, entry] of Object.entries(servers)) {
    if (id === AGENT_NAME || !isRecord(entry)) continue;
    setup.agents.push(id);
    if (unwrappedEntry(entry) !== undefined) setup.withRewake.push(id);
  }
  return setup;
}

/** An agent's name as Zed shows it, from Zed's copy of the ACP Registry, or its id. */
export function agentName(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const name = registryAgent(id, env)?.name;
  if (name) return name;
  return id === CLAUDE_REGISTRY_ID ? "Claude Agent" : id;
}

/** The most recent time a Zed agent connection started Rewake, from its metadata-only logs. */
export function lastStart(stateDir: string): { at: number; agent: string } | undefined {
  const dir = join(stateDir, "logs");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => /^rewake-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse();
  } catch {
    return undefined;
  }
  for (const f of files) {
    const lines = readFileSync(join(dir, f), "utf8").trim().split("\n").reverse();
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as { t?: string; event?: string; agent?: string };
        if (r.event === "proxy.start" && r.t)
          return { at: Date.parse(r.t), agent: r.agent ?? "agent" };
      } catch {
        // A torn or foreign line: skipped.
      }
    }
  }
  return undefined;
}
