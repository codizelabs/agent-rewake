import { classifyTurnEnd } from "../../adapters/profiles.js";
import type { SessionLimit } from "../sessions.js";

/**
 * GitHub Copilot CLI's usage limits, from the error text its `errorOccurred` hook receives. The
 * hook carries no reset field, so the reset comes from the text.
 *
 * Texts seen (Copilot CLI 1.0.92 strings; github/copilot-cli issues #2828, #2696, #2385):
 *   "You've reached your weekly rate limit. Please wait for your limit to reset on April 20, 2026
 *    at 2:00 AM or switch to auto model to continue."
 *   "… Please try again in 58 hours."
 *   "You've hit your session rate limit." / "You've hit the rate limit for this model."
 * Billing (never resumed): "You've run out of your AI credits", "included AI credits for the
 * month", "spending limit for this session", "additional usage limit".
 * Whether `errorOccurred` carries exactly these texts is experiment E-C1.
 */

/**
 * A usage limit in Copilot CLI's error text, or undefined for any other error, a short-term rate
 * limit Copilot rides out itself, or an error it recovered from. The hook's text is what the ACP
 * client gets after "Error: ", so the rules are the shared ones (`classifyTurnEnd("copilot", …)`):
 * Copilot's own sentences, "reset in 2 hours", and reset dates printed in UTC.
 */
export function classifyCopilotError(
  text: unknown,
  now: number,
  recoverable = false,
): Omit<SessionLimit, "seenAt"> | undefined {
  if (recoverable || typeof text !== "string" || text === "") return undefined;
  const t = text.slice(0, 4096);
  const c = classifyTurnEnd("copilot", `Error: ${t}`, "end_turn", now);
  if (c?.kind === "not_recoverable") return { kind: "billing", billing: true };
  if (c?.kind === "usage_limit")
    return {
      kind: c.limitType,
      billing: false,
      ...(c.resetAt !== undefined && { resetsAt: c.resetAt }),
    };
  // Wordings the shared rules don't name, kept as billing: waiting doesn't bring them back.
  if (/run out of your AI credits|additional usage limit/i.test(t))
    return { kind: "billing", billing: true };
  return undefined;
}
