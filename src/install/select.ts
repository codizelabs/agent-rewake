import type { Found, PlaceId } from "./detect.js";

/**
 * `agent-rewake install` with no place named (plan §4.1): what was found on this computer, what
 * Rewake does in each place, and a checklist to pick from. Places Rewake can't reach are named, not
 * offered; an agent too old for Rewake is shown with what it needs, not offered.
 */

export interface Place {
  id: PlaceId;
  name: string;
  version?: string;
  /** One line: what Rewake does there. */
  what: string;
  /** "ready" can be picked; the others are shown so the person knows why not. */
  state: "ready" | "installed" | "too-old";
  /** For too-old: the version Rewake needs, and how to update. */
  needs?: string;
  update?: string;
  /** Where it was found, when not a terminal ("ChatGPT app"). */
  surface?: string;
}

/** What Rewake does in each place, in one line. */
export const WHAT: Record<PlaceId, string> = {
  zed: "Resumes and schedules messages in Zed's agent threads.",
  jetbrains: "Adds Claude Agent and Codex with Rewake to AI Assistant in your JetBrains IDEs.",
  "devin-desktop": "Adds Claude Agent and Codex with Rewake to Devin Desktop's agent selector.",
  cursor:
    "At a usage limit in Cursor's own agent, continues the chat at the time you choose (within 4 hours), while its window stays open.",
  "claude-code": "Asks at a usage limit, then continues the same session when the limit resets.",
  codex: 'Type "rewake" in a thread at a usage limit; it continues when the limit resets.',
  "copilot-cli": "Continues a closed session when its usage limit resets.",
  grok: "Continues a closed session when its usage limit resets.",
  "gemini-cli": "Continues a closed session when its usage limit resets.",
  antigravity:
    "Continues a closed CLI conversation when its limit resets; in the app and IDE, says when it resets.",
};

/** The places Rewake can't reach, always named so nobody looks for them in the list. */
export const UNREACHABLE =
  "Rewake can't reach claude.ai, the Claude desktop app's chat, or Zed's own agent.";

/** The checklist's starting state: every place Rewake isn't in yet (installed ones stay as they are). */
export function defaultChoice(places: Place[]): Set<PlaceId> {
  return new Set(places.filter((p) => p.state === "ready").map((p) => p.id));
}

/** Said once under the list: everything outside Zed is new. */
export const PREVIEW_NOTE = "Everything except Zed is a preview: new, and may change.";

/** The lines of the checklist, the cursor's line marked. No colours: works in any terminal. */
export function renderChoice(
  places: Place[],
  chosen: ReadonlySet<PlaceId>,
  cursor: number,
  missing: string[],
): string[] {
  const lines: string[] = [];
  places.forEach((p, i) => {
    const pointer = i === cursor ? ">" : " ";
    const label = `${p.name}${p.version ? ` ${p.version}` : ""}${p.surface ? ` (${p.surface})` : ""}`;
    if (p.state === "too-old") {
      lines.push(
        `${pointer}  -  ${label}: too old for Rewake (it needs ${p.needs} or newer). Update it: ${p.update ?? "see its own docs"}`,
      );
      return;
    }
    const box = chosen.has(p.id) ? "[x]" : "[ ]";
    const note = p.state === "installed" ? ": Rewake is set up here (tick to update)" : "";
    lines.push(`${pointer} ${box} ${label}${note}`);
    lines.push(`        ${p.what}`);
  });
  for (const name of missing) lines.push(`   -  ${name}: not found.`);
  lines.push("", PREVIEW_NOTE, UNREACHABLE);
  return lines;
}

/** The question under the list, with how many places are ticked. */
export function keysHelp(ticked: number): string {
  return `Set up Rewake in the ${ticked === 1 ? "1 ticked place" : `${ticked} ticked places`}? Up and Down move, Space ticks or unticks, a ticks all, Enter continues, q quits.`;
}

export type Key = "up" | "down" | "toggle" | "all" | "enter" | "quit" | "other";

/** A terminal key press as a choice action. */
export function keyOf(data: string): Key {
  if (data === "\u001b[A" || data === "k") return "up";
  if (data === "\u001b[B" || data === "j") return "down";
  if (data === " ") return "toggle";
  if (data === "a") return "all";
  if (data === "\r" || data === "\n") return "enter";
  if (data === "q" || data === "\u0003" || data === "\u001b") return "quit";
  return "other";
}

/** One key press applied to the checklist; returns "done", "quit" or undefined (keep going). */
export function press(
  key: Key,
  places: Place[],
  chosen: Set<PlaceId>,
  state: { cursor: number },
): "done" | "quit" | undefined {
  const pickable = (i: number) => places[i]?.state !== "too-old";
  if (key === "up") state.cursor = Math.max(0, state.cursor - 1);
  if (key === "down") state.cursor = Math.min(places.length - 1, state.cursor + 1);
  if (key === "toggle" && pickable(state.cursor)) {
    const id = places[state.cursor]?.id;
    if (id) chosen.has(id) ? chosen.delete(id) : chosen.add(id);
  }
  if (key === "all") for (const p of places) if (p.state !== "too-old") chosen.add(p.id);
  if (key === "enter") return "done";
  if (key === "quit") return "quit";
  return undefined;
}

/** The places found, from detection: Zed first, then each agent, as `install` offers them. */
export function placesFrom(
  found: Found[],
  zed: { found: boolean; version?: string },
  installed: ReadonlySet<PlaceId>,
  minimum: (id: PlaceId) => string | undefined,
  older: (a: string, b: string) => boolean,
  update: (id: PlaceId) => string | undefined = () => undefined,
): Place[] {
  const out: Place[] = [];
  if (zed.found)
    out.push({
      id: "zed",
      name: "Zed",
      ...(zed.version && { version: zed.version }),
      what: WHAT.zed,
      state: "ready",
    });
  for (const f of found) {
    const min = minimum(f.id);
    const tooOld = Boolean(min && f.version && older(f.version, min));
    out.push({
      id: f.id,
      name: f.name,
      ...(f.version && { version: f.version }),
      what: WHAT[f.id],
      state: tooOld ? "too-old" : installed.has(f.id) ? "installed" : "ready",
      ...(tooOld && min && { needs: min }),
      ...(tooOld && update(f.id) && { update: update(f.id) as string }),
      ...(f.surfaces.length > 0 &&
        !f.surfaces.includes("terminal") && { surface: f.surfaces.join(", ") }),
    });
  }
  return out;
}

export interface ChoiceIO {
  /** Raw key presses from the terminal. */
  keys: AsyncIterable<string>;
  write: (text: string) => void;
}

/**
 * The interactive checklist. Resolves with the chosen places, or undefined when the person quits
 * (nothing is changed then).
 */
export async function choosePlaces(
  places: Place[],
  missing: string[],
  io: ChoiceIO,
): Promise<PlaceId[] | undefined> {
  const chosen = defaultChoice(places);
  const state = { cursor: 0 };
  let drawn = 0;
  const draw = () => {
    const lines = [
      ...renderChoice(places, chosen, state.cursor, missing),
      "",
      keysHelp(chosen.size),
    ];
    // Back to the first line of the last drawing, then overwrite it.
    if (drawn > 0) io.write(`\u001b[${drawn}A`);
    io.write(`${lines.map((l) => `\u001b[2K${l}`).join("\n")}\n`);
    drawn = lines.length;
  };
  draw();
  for await (const data of io.keys) {
    const result = press(keyOf(data), places, chosen, state);
    if (result === "quit") return undefined;
    if (result === "done") return places.filter((p) => chosen.has(p.id)).map((p) => p.id);
    draw();
  }
  return undefined;
}
