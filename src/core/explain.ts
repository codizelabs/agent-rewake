import { decideFire, LATE_MS } from "./resume.js";
import { formatWhen } from "./time.js";

/**
 * `agent-rewake schedules --explain <id>`: what will happen at a planned resume's time, in plain
 * words, and what could stop it. Built from the same rules `fire` and the add-on decide with
 * (src/core/resume.ts), so the answer can't drift from what Rewake does. It only reads: nothing is
 * checked in the agent and nothing is sent. Pure: no I/O.
 */

export interface ExplainInput {
  dueAt: number;
  /** The schedule's status word, e.g. "scheduled". */
  status: string;
  kind: "user" | "limit_resume" | "auto_limit_resume";
  /** The message that will be sent. */
  text: string;
  /** Where it goes: `Codex in the "shop" folder`, or the Zed thread's title. */
  where: string;
  /** What the agent calls a conversation: "thread" or "session". */
  noun: string;
  /** The status as a person reads it: "Sent", "Needs you". */
  statusWord: string;
  /** A resume Rewake delivers from outside Zed's add-on (so a session can be open elsewhere). */
  outsideZed: boolean;
  /** How late counts as too late to send without asking (Zed's add-on: 15 min). */
  lateMs?: number;
  /** How to cancel it, in words: a command or a page. */
  cancel: string;
}

/** Statuses a planned resume still waits in. */
const PENDING = new Set(["scheduled", "waiting_for_limit"]);

const oneLine = (text: string, max = 70): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function explainResume(r: ExplainInput, now: number, locale?: string): string[] {
  const lines = [`${r.where}`];
  if (!PENDING.has(r.status)) {
    lines.push(
      `  That resume was already ${r.statusWord.toLowerCase()}. Rewake won't do anything more with it.`,
      "  To see what is still planned: agent-rewake schedules",
    );
    return lines;
  }
  const lateMs = r.lateMs ?? LATE_MS;
  const when = formatWhen(r.dueAt, now, locale);
  if (r.kind === "user") {
    lines.push(
      `  When: ${when}`,
      `  What Rewake will do: send your message "${oneLine(r.text)}" into the ${r.noun} once.`,
      `  Nothing is sent now: this view only reads. ${r.cancel}`,
    );
    return lines;
  }
  // The shared rule, asked as if the time were now: late is the one answer that depends on the clock.
  const asNow = decideFire({
    resume: { dueAt: r.dueAt, status: r.status },
    now,
    alreadySent: false,
    lateMs,
  });
  lines.push(
    `  When: ${when}`,
    `  What Rewake will do: continue the ${r.noun} by sending "${oneLine(r.text)}" once, as if you had typed it.`,
  );
  if (asNow.action === "notify" && asNow.why === "late")
    lines.push(
      "  Its time has already passed by too long, so Rewake won't send it by itself. It will tell you.",
    );
  // One pattern for every bullet: what happens, then what Rewake does about it.
  lines.push("  What could stop it:");
  lines.push(
    `  - You type in the ${r.noun} before then: Rewake sends nothing.`,
    "  - The agent continues on its own first: Rewake sends nothing.",
  );
  if (r.outsideZed)
    lines.push(
      `  - The ${r.noun} is open in a window or terminal then: Rewake sends nothing and tells you.`,
    );
  lines.push(
    "  - The agent is still at its usage limit: Rewake waits for the new reset and tries again, or tells you if it can't.",
    "  - The computer is off or asleep then: Rewake sends nothing if it runs much later, and tells you.",
    "  - A credit or billing limit: Rewake never resumes it, because waiting doesn't fix it.",
    `  Nothing is sent now: this view only reads. ${r.cancel}`,
  );
  return lines;
}
