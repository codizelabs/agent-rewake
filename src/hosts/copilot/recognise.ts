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
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** "reset on April 20, 2026 at 2:00 AM" (local time) or "try again in 58 hours". */
export function parseCopilotReset(text: string, now: number): number | undefined {
  const on = /reset on ([A-Za-z]+) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) ?([AP]M)/i.exec(text);
  if (on) {
    const month = MONTHS.indexOf((on[1] ?? "").toLowerCase());
    if (month < 0) return undefined;
    let h = Number(on[4]) % 12;
    if ((on[6] ?? "").toUpperCase() === "PM") h += 12;
    const d = new Date(Number(on[3]), month, Number(on[2]), h, Number(on[5]), 0, 0);
    return Number.isFinite(d.getTime()) ? d.getTime() : undefined;
  }
  const after = /try again in (\d+) ?(seconds?|minutes?|hours?|days?)/i.exec(text);
  if (after) {
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[(after[2] ?? "s")[0]?.toLowerCase() as "s"];
    return now + Number(after[1]) * unit;
  }
  return undefined;
}

/** A usage limit in Copilot CLI's error text, or undefined for any other error. */
export function classifyCopilotError(
  text: unknown,
  now: number,
): Omit<SessionLimit, "seenAt"> | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  const t = text.slice(0, 4096);
  if (/AI credits|spending limit|additional usage limit|billing/i.test(t))
    return { kind: "billing", billing: true };
  let kind: string;
  if (/weekly rate limit/i.test(t)) kind = "weekly";
  else if (/session rate limit/i.test(t)) kind = "session";
  else if (/rate limit for this model/i.test(t)) kind = "model";
  else if (/rate limit/i.test(t)) kind = "other";
  else return undefined;
  const resetsAt = parseCopilotReset(t, now);
  return { kind, billing: false, ...(resetsAt !== undefined && { resetsAt }) };
}
