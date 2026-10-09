import { rewake } from "../util/command.js";
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
  "qwen-code": "Continues a closed session when its usage limit resets.",
  opencode: "Continues a closed session when its usage limit resets.",
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

/** "a, b and c" (or just "a" for one, "a and b" for two): used wherever a list of names is read out loud. */
function listNames(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The quick question before the checklist (plan §4.1 revised; F3: a preset first, the full
 * checklist only on request). Names only, not what each one does — the checklist already says
 * that, and repeating it here is exactly the clutter a short question is meant to avoid. Returns
 * undefined when there's only one ready place and nothing else to explain (too-old): F4, there's
 * nothing to customize, so nothing is asked.
 *
 * A too-old place is never silently part of "all of them" (G1: say what "yes" actually does):
 * it's named in its own short aside, and the question becomes "the rest". A place that wasn't
 * found at all isn't mentioned here — there's no decision to make about something that isn't on
 * this computer, so naming it is noise, not information (C1); the checklist still lists it, for
 * whoever opens it to look.
 */
export function quickSetupPrompt(places: Place[]): string | undefined {
  const offered = places.filter((p) => p.state !== "too-old");
  const tooOld = places.filter((p) => p.state === "too-old").map((p) => p.name);
  if (tooOld.length === 0 && offered.length <= 1) return undefined;
  const list = listNames(offered.map((p) => p.name));
  const aside =
    tooOld.length > 0
      ? ` (${listNames(tooOld)} ${tooOld.length === 1 ? "is" : "are"} too old to set up)`
      : "";
  const which = tooOld.length > 0 ? "the rest of them" : "all of them";
  return `Agent Rewake found ${list} on this computer${aside}.\nInstall Rewake for ${which}? [Y/n] `;
}

/**
 * The same small palette `src/ui/page.ts` uses for the schedules page, so the picker looks like
 * the rest of Rewake's terminal output rather than its own style. `NO_COLOR` (or `TERM=dumb`)
 * turns colour into bold, the same degrade `page.ts` applies; bold, dim and reverse stay, since
 * they're not colour and every terminal, including a screen reader, can still tell the difference.
 */
type Tone = "plain" | "bold" | "dim" | "reverse" | "accent" | "warn";
const SGR: Record<Exclude<Tone, "plain">, string> = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reverse: "\x1b[7m",
  accent: "\x1b[36m",
  warn: "\x1b[33m",
};

function paint(text: string, tone: Tone, noColor: boolean): string {
  if (tone === "plain" || text === "") return text;
  let t = tone;
  if (noColor && (t === "accent" || t === "warn")) t = "bold";
  return `${SGR[t]}${text}\x1b[0m`;
}

/** The lines of the checklist, the cursor's line marked. */
export function renderChoice(
  places: Place[],
  chosen: ReadonlySet<PlaceId>,
  cursor: number,
  missing: string[],
  noColor = false,
): string[] {
  const c = (text: string, tone: Tone) => paint(text, tone, noColor);
  const lines: string[] = [];
  places.forEach((p, i) => {
    const onCursor = i === cursor;
    const pointer = onCursor ? c("❯", "accent") : " ";
    const label = `${p.name}${p.version ? ` ${p.version}` : ""}${p.surface ? ` (${p.surface})` : ""}`;
    if (p.state === "too-old") {
      lines.push(
        `${pointer} ${c("·", "dim")} ${c(label, "dim")}${c(": too old for Rewake", "warn")}` +
          c(` (it needs ${p.needs} or newer). Update it: ${p.update ?? "see its own docs"}`, "dim"),
      );
      return;
    }
    const mark = chosen.has(p.id) ? c("●", "accent") : c("○", "dim");
    const name = onCursor ? c(label, "bold") : label;
    const note = p.state === "installed" ? c(" · set up here, tick to update", "dim") : "";
    lines.push(`${pointer} ${mark} ${name}${note}`);
  });
  for (const name of missing) lines.push(`  ${c("·", "dim")} ${c(`${name}: not found.`, "dim")}`);
  // One line, for the highlighted place only (V2: content first, help second, one hint line) —
  // not a description under every row, which is what made a list of six or seven places long to
  // read. A too-old row already says what it needs, so it has nothing more to add here.
  // PREVIEW_NOTE and UNREACHABLE aren't here: they're always true, not something that changes as
  // the cursor moves, so they're said once before this screen starts (like the intro line above
  // it), not redrawn on every key press — three lines of explanation every time was still a lot to
  // read on the one path (saying "no" to the quick question) a person takes to look closely.
  const onRow = places[cursor];
  const hint = onRow && onRow.state !== "too-old" ? c(onRow.what, "dim") : "";
  lines.push("", hint);
  return lines;
}

/** The question under the list, with how many places are ticked. */
export function keysHelp(ticked: number, noColor = false): string {
  const c = (text: string, tone: Tone) => paint(text, tone, noColor);
  const n = ticked === 1 ? "1 ticked place" : `${ticked} ticked places`;
  const key = (k: string) => c(k, "bold");
  return (
    `Set up Rewake in the ${c(n, "accent")}?  ` +
    `${key("↑↓")} move   ${key("space")} tick   ${key("a")} all   ${key("enter")} continue   ${key("q")} quit`
  );
}

export type Key = "up" | "down" | "toggle" | "all" | "enter" | "quit" | "other";

/**
 * A key press as Node's own `readline.emitKeypressEvents` reports it: already reassembled from
 * however many bytes the terminal split an escape sequence across, and already the same whether
 * the terminal sent the arrow keys as `ESC [ A` (cursor mode) or `ESC O A` (application mode). A
 * hand-rolled match on the raw bytes got both wrong, which is why arrow keys could do nothing, or
 * a lone leading ESC byte (arriving before the rest of the sequence) could be read as "quit".
 */
export interface Keypress {
  /** The raw bytes this key press decoded from. */
  sequence: string;
  /** Node's name for the key ("up", "down", "return", "escape", "a", "space", …), when it has one. */
  name?: string;
  ctrl?: boolean;
}

/** A terminal key press, already decoded by Node, as a choice action. */
export function keyOf(k: Keypress): Key {
  if (k.name === "up" || k.name === "k") return "up";
  if (k.name === "down" || k.name === "j") return "down";
  if (k.name === "space" || k.sequence === " ") return "toggle";
  if (k.name === "a" && !k.ctrl) return "all";
  if (k.name === "return" || k.name === "enter") return "enter";
  if (k.name === "q" || k.name === "escape" || (k.ctrl && k.name === "c")) return "quit";
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

/**
 * What `install --yes` (or a run with no terminal) says when no place was named: it sets up Zed.
 * With no Zed here but agents found, it names them first, and how to set them up instead.
 */
export function defaultPlaceText(places: readonly Place[]): string {
  const others = places.filter((p) => p.id !== "zed" && p.state === "ready");
  if (!places.some((p) => p.id === "zed") && others.length > 0)
    return `Zed wasn't found on this computer, but these were: ${others.map((p) => p.name).join(", ")}. Setting up Zed (the default) anyway. To set up what was found instead, run: ${rewake(`install --only ${others.map((p) => p.id).join(",")}`)}\n`;
  return "Setting up Zed (the default). To choose other places, run install in a terminal without --yes, or name them: --only claude-code,codex\n";
}

export interface ChoiceIO {
  /** Decoded key presses from the terminal (Node's `readline.emitKeypressEvents`). */
  keys: AsyncIterable<Keypress>;
  write: (text: string) => void;
  /** `NO_COLOR` or `TERM=dumb`: colour becomes bold instead. Default false (colour on). */
  noColor?: boolean;
  /** The terminal's current width, read fresh on every redraw (it can be resized). Default 80. */
  columns?: () => number;
}

/** A line's length on screen: an SGR code moves no cursor, so it doesn't count towards width. */
function visibleWidth(line: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI codes themselves
  return line.replace(/\x1b\[\d*m/g, "").length;
}

/**
 * How many terminal rows a line takes once the terminal wraps it: 1 for anything that fits,
 * more for anything wider than the terminal. Moving the cursor up by the number of *array*
 * entries from the last draw — what this used to do — undercounts whenever a description wraps,
 * so the next redraw doesn't reach back far enough and the frame above it is never cleared: this
 * is the actual cause of the picker appearing to duplicate itself on narrower terminals.
 */
function rowsFor(line: string, columns: number): number {
  if (columns <= 0) return 1;
  return Math.max(1, Math.ceil(visibleWidth(line) / columns));
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
  const noColor = io.noColor ?? false;
  let drawn = 0;
  const draw = () => {
    const lines = [
      ...renderChoice(places, chosen, state.cursor, missing, noColor),
      "",
      keysHelp(chosen.size, noColor),
    ];
    const columns = io.columns?.() ?? 80;
    // Back to the first row of the last drawing, then overwrite it. The terminal's own width is
    // read fresh here, not cached, in case the person resized between redraws.
    if (drawn > 0) io.write(`\u001b[${drawn}A`);
    io.write(`${lines.map((l) => `\u001b[2K${l}`).join("\n")}\n`);
    drawn = lines.reduce((rows, l) => rows + rowsFor(l, columns), 0);
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
