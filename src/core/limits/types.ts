/**
 * Limit recognition, one interface for every agent and every place Rewake hears from it
 * (plan-universal §3.4). A host turns what it got into a `LimitSignal`; `recognise()` answers with
 * a `LimitVerdict`, or nothing when it isn't a usage limit.
 */

export type AgentKind =
  | "claude"
  | "codex"
  | "copilot"
  | "grok"
  | "gemini"
  | "antigravity"
  | (string & {});

export interface LimitSignal {
  agent: AgentKind;
  /** Where it came from: Zed's ACP error, a hook's input, a session file, a usage API, the mod. */
  source: "acp-error" | "hook" | "session-file" | "usage-api" | "mod-event";
  /** A structured code when the agent gives one ("rate_limit", "usage_limit_exceeded"). */
  code?: string;
  /** The HTTP status when known. */
  status?: number;
  /** Error text, only for parsing; never logged. */
  text?: string;
  /** A structured reset time when the agent gives one (ms). */
  resetsAt?: number;
  /** Whether the agent recovered from it by itself (Copilot's `recoverable`). */
  recovered?: boolean;
  /** Grok: the usage period from its billing log (src/hosts/grok/host.ts billingReset). */
  period?: { resetsAt?: number; full: boolean; seen?: boolean };
}

export interface LimitVerdict {
  /** A wait fixes it. */
  isUsageLimit: boolean;
  /** Credit, spend or billing: never resumed on its own. */
  isBilling: boolean;
  window?: "session" | "weekly" | "monthly" | "daily" | "other";
  /** Structured, else parsed from the text, else unknown (the person picks a time). */
  resetsAt?: number;
  /**
   * How the reset was known: from a structured field, from the agent's own text, or not at all.
   * A guess never resumes on its own.
   */
  confidence: "structured" | "text" | "guess";
}

/** What a host's session record keeps of a limit (src/hosts/sessions.ts adds when it was seen). */
export interface HostLimit {
  /** "session", "weekly", "daily", "model", "other", or "billing". */
  kind: string;
  billing: boolean;
  resetsAt?: number;
  confidence?: LimitVerdict["confidence"];
}
