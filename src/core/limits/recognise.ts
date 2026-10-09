import { type AgentProfile, classifyLimit } from "../../adapters/profiles.js";
import {
  classifyAntigravityStop,
  classifyCopilotError,
  classifyCursorError,
  classifyGeminiError,
  classifyGrokFailure,
  classifyQwenFailure,
} from "./agents.js";
import type { HostLimit, LimitSignal, LimitVerdict } from "./types.js";

/**
 * The one way to ask whether an agent's signal is a usage limit, and when it resets (plan §3.4).
 * Undefined: not a usage limit (another error, or a short wait the agent rides out itself).
 */
export function recognise(signal: LimitSignal, now: number): LimitVerdict | undefined {
  const limit = hostLimit(signal, now);
  if (!limit) return undefined;
  return verdictOf(limit, signal);
}

function hostLimit(s: LimitSignal, now: number): HostLimit | undefined {
  const text = s.text ?? "";
  // Zed's add-on: an ACP error, read with the agent's own profile (src/adapters/profiles.ts).
  if (s.source === "acp-error") {
    const c = classifyLimit(
      s.agent as AgentProfile,
      { code: s.status ?? -32603, message: text },
      now,
    );
    if (c.kind === "not_recoverable") return { kind: "billing", billing: true };
    if (c.kind !== "usage_limit") return undefined;
    const resetsAt = s.resetsAt ?? c.resetAt;
    return { kind: c.limitType, billing: false, ...(resetsAt !== undefined && { resetsAt }) };
  }
  switch (s.agent) {
    case "copilot":
      return classifyCopilotError(text, now, s.recovered === true);
    case "gemini":
      return classifyGeminiError(text, now);
    case "antigravity":
      return classifyAntigravityStop({ terminationReason: s.code, error: text }, now);
    case "cursor":
      return classifyCursorError(text);
    case "qwen":
      return classifyQwenFailure({ error: s.code, errorDetails: text }, now);
    case "grok":
      return classifyGrokFailure(
        { error: s.code, errorDetails: text },
        s.period ?? { full: false },
      );
    default:
      return undefined;
  }
}

function verdictOf(l: HostLimit, s: LimitSignal): LimitVerdict {
  const window = (
    ["session", "weekly", "monthly", "daily"].includes(l.kind) ? l.kind : "other"
  ) as LimitVerdict["window"];
  // Grok's reset comes from its billing log's period, a structured field; the others from text.
  const fromField =
    l.resetsAt !== undefined &&
    (s.resetsAt === l.resetsAt || (s.agent === "grok" && s.period?.resetsAt === l.resetsAt));
  return {
    isUsageLimit: !l.billing,
    isBilling: l.billing,
    ...(window && { window }),
    ...(l.resetsAt !== undefined && { resetsAt: l.resetsAt }),
    confidence: fromField ? "structured" : l.resetsAt !== undefined ? "text" : "guess",
  };
}

/** A verdict as a host's session record keeps it. */
export function asHostLimit(v: LimitVerdict): HostLimit {
  return {
    kind: v.isBilling ? "billing" : (v.window ?? "other"),
    billing: v.isBilling,
    ...(v.resetsAt !== undefined && { resetsAt: v.resetsAt }),
    confidence: v.confidence,
  };
}

/** `recognise` for a host: the limit to record, or nothing. */
export function recogniseForHost(signal: LimitSignal, now: number): HostLimit | undefined {
  const v = recognise(signal, now);
  return v ? asHostLimit(v) : undefined;
}
