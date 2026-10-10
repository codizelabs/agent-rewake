import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  choosePlaces,
  defaultChoice,
  defaultPlaceText,
  type Keypress,
  keyOf,
  type Place,
  PREVIEW_NOTE,
  placesFrom,
  press,
  quickSetupPrompt,
  renderChoice,
  UNREACHABLE,
} from "../src/install/select.js";
import { ESC, withoutStyle } from "../src/util/style.js";

/** A key press as the test data below names it, built the same shape `emitKeypressEvents` gives. */
function key(name: string, sequence = name): Keypress {
  return { sequence, name };
}

/** For assertions about wording, not colour: strip every SGR code `renderChoice` adds. */
const strip = withoutStyle;

const older = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) < 0;
const places: Place[] = placesFrom(
  [
    { id: "claude-code", name: "Claude Code", version: "2.1.292", surfaces: ["terminal"] },
    { id: "codex", name: "Codex", version: "0.140.0", surfaces: ["terminal"] },
    { id: "grok", name: "Grok Build", version: "1.0.46", surfaces: ["terminal"] },
  ],
  { found: true, version: "1.22.0" },
  new Set(["grok"]),
  (id) => ({ "claude-code": "2.1.287", codex: "0.149.0", grok: "1.0.46" })[id as string],
  older,
);

describe("the install screen", () => {
  it("lists Zed and each agent, too-old ones shown but not offered", () => {
    expect(places.map((p) => [p.id, p.state])).toEqual([
      ["zed", "ready"],
      ["claude-code", "ready"],
      ["codex", "too-old"],
      ["grok", "installed"],
    ]);
    // Installed places start unticked: one Enter doesn't redo what already works.
    expect([...defaultChoice(places)]).toEqual(["zed", "claude-code"]);
    const lines = renderChoice(places, defaultChoice(places), 0, ["Gemini CLI"]).map(strip);
    expect(lines[0]).toBe("❯ ● Zed 1.22.0");
    expect(lines).toContain(
      "  · Codex 0.140.0: too old for Rewake (it needs 0.149.0 or newer). Update it: see its own docs",
    );
    expect(lines).toContain("  ○ Grok Build 1.0.46 · set up here, tick to update");
    expect(lines).toContain("  · Gemini CLI: not found.");
    // No per-row description any more (that's what made six or seven places long to read): only
    // the highlighted row's, as a single trailing line. PREVIEW_NOTE and UNREACHABLE aren't part
    // of this at all any more: they're always true, not tied to the cursor, so the caller prints
    // them once before the checklist starts instead of redrawing them on every key press.
    expect(lines).not.toContain("      Resumes and schedules messages in Zed's agent threads.");
    expect(lines).not.toContain(PREVIEW_NOTE);
    expect(lines).not.toContain(UNREACHABLE);
    expect(lines.slice(-2)).toEqual(["", "Resumes and schedules messages in Zed's agent threads."]);
    // Moving the cursor changes whose hint shows, and a too-old row has nothing to add there.
    expect(renderChoice(places, defaultChoice(places), 1, []).map(strip).at(-1)).toBe(
      "Asks at a usage limit, then continues the same session when the limit resets.",
    );
    expect(renderChoice(places, defaultChoice(places), 2, []).map(strip).at(-1)).toBe("");
  });

  it("colours by default, and NO_COLOR keeps bold and dim but drops colour", () => {
    const chosen = defaultChoice(places);
    const withColor = renderChoice(places, chosen, 0, []).join("\n");
    const plain = renderChoice(places, chosen, 0, [], true).join("\n");
    // Cyan (accent, the ticked mark and the cursor) only appears with colour on.
    expect(withColor).toContain("\x1b[36m");
    expect(plain).not.toContain("\x1b[36m");
    // Bold and dim are attributes, not colour: NO_COLOR keeps them so state is still visible.
    expect(plain).toContain("\x1b[1m");
    expect(plain).toContain("\x1b[2m");
    // Every styled run is closed, with or without colour.
    const OPEN = new RegExp(`${ESC}\\[(?:1|2|36|33)m`, "g");
    const CLOSE = new RegExp(`${ESC}\\[0m`, "g");
    for (const s of [withColor, plain]) {
      expect((s.match(OPEN) ?? []).length).toBe((s.match(CLOSE) ?? []).length);
    }
    expect(strip(withColor)).toBe(strip(plain));
  });

  it("moves, ticks and unticks with the keys, and never ticks a too-old agent", () => {
    const chosen = defaultChoice(places);
    const state = { cursor: 0 };
    press(keyOf(key("space", " ")), places, chosen, state);
    expect(chosen.has("zed")).toBe(false);
    press(keyOf(key("down", "\u001b[B")), places, chosen, state);
    press(keyOf(key("down", "\u001b[B")), places, chosen, state);
    press(keyOf(key("space", " ")), places, chosen, state);
    expect(chosen.has("codex")).toBe(false);
    press(keyOf(key("a")), places, chosen, state);
    expect([...chosen].sort()).toEqual(["claude-code", "grok", "zed"]);
    expect(press(keyOf(key("return", "\r")), places, chosen, state)).toBe("done");
    expect(press(keyOf(key("q")), places, chosen, state)).toBe("quit");
  });

  // Arrow keys also work by their other common name (vim-style j/k) and the Ctrl-C/Escape quits.
  it("also quits on Escape and Ctrl-C, and moves with j/k", () => {
    const state = { cursor: 0 };
    expect(keyOf(key("escape", "\u001b"))).toBe("quit");
    expect(keyOf({ sequence: "\u0003", name: "c", ctrl: true })).toBe("quit");
    expect(keyOf(key("k"))).toBe("up");
    press(keyOf(key("j")), places, defaultChoice(places), state);
    expect(state.cursor).toBe(1);
  });

  it("answers with the ticked places on Enter, and nothing on q", async () => {
    async function* keys(k: Keypress[]) {
      for (const x of k) yield x;
    }
    const io = (k: Keypress[]) => ({ keys: keys(k), write: () => {} });
    expect(await choosePlaces(places, [], io([key("space", " "), key("return", "\r")]))).toEqual([
      "claude-code",
    ]);
    expect(await choosePlaces(places, [], io([key("q")]))).toBeUndefined();
  });

  // The actual bug the owner saw: in a terminal narrow enough to wrap the descriptions, pressing
  // an arrow key duplicated the whole list. The redraw moved the cursor up by the number of array
  // entries from the last frame, not the number of rows those entries actually took once wrapped,
  // so the next redraw didn't reach back far enough and the old frame was never fully cleared.
  it("moves the cursor up by the wrapped row count on a narrow terminal, not the line count", async () => {
    async function* keys(k: Keypress[]) {
      for (const x of k) yield x;
    }
    const writes: string[] = [];
    const columns = 40; // narrow enough that every description in `places` wraps at least once
    await choosePlaces(places, [], {
      keys: keys([key("down", "\u001b[B")]),
      write: (t) => writes.push(t),
      columns: () => columns,
    });
    // Two frames were drawn: the first has no "move up" (drawn starts at 0), the second does.
    const MOVE_UP = new RegExp(`^${ESC}\\[\\d+A$`);
    const MOVE_UP_N = new RegExp(`^${ESC}\\[(\\d+)A$`);
    const moves = writes.filter((w) => MOVE_UP.test(w));
    expect(moves).toHaveLength(1);
    const movedUp = Number(MOVE_UP_N.exec(moves[0] ?? "")?.[1]);
    // The actual row count the first frame occupied at 40 columns, counted independently of
    // `choosePlaces`'s own bookkeeping: every logical line, plus the blank line and the help line,
    // each contributing ceil(width / 40) rows.
    const firstFrame = writes[0] ?? "";
    const frameLines = firstFrame.split("\n").slice(0, -1); // drop the empty entry after the last \n
    const strippedWidths = frameLines.map(
      (l) => withoutStyle(l).replace(new RegExp(`^${ESC}\\[2K`), "").length,
    );
    const expectedRows = strippedWidths.reduce(
      (n, w) => n + Math.max(1, Math.ceil(w / columns)),
      0,
    );
    expect(movedUp).toBe(expectedRows);
    // And it's strictly more than the old (wrong) line count would have given, proving this
    // terminal width really does wrap something — otherwise the fix and the bug look identical.
    expect(movedUp).toBeGreaterThan(frameLines.length);
  });

  // The actual bug this fixes: a terminal can split an escape sequence across more than one
  // `data` event, or send arrow keys as the application-cursor-mode form (`ESC O A`) instead of
  // the normal form (`ESC [ A`). A match on whole raw chunks got both wrong — a split sequence's
  // lone leading ESC byte read as "quit", and the `O` form wasn't recognised as an arrow key at
  // all. This drives Node's own `readline.emitKeypressEvents` (what `pickPlaces` in cli.ts uses)
  // with a fake stream, writing the bytes exactly as a terminal could deliver them.
  describe("decodes real terminal byte streams, however they're split or encoded", () => {
    async function pressesFrom(writes: string[]): Promise<Keypress[]> {
      const stream = new PassThrough();
      emitKeypressEvents(stream);
      const seen: Keypress[] = [];
      stream.on("keypress", (_s, k) => k && seen.push(k));
      for (const w of writes) {
        stream.write(w);
        // emitKeypressEvents waits a short beat before deciding a lone ESC isn't the start of a
        // longer sequence; give it room between writes that are meant to arrive separately.
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, 60));
      return seen;
    }

    it("a whole escape sequence in one write", async () => {
      const [k] = await pressesFrom(["\u001b[A"]);
      expect(keyOf(k as Keypress)).toBe("up");
    });

    it("the same sequence split across two writes", async () => {
      const [k] = await pressesFrom(["\u001b", "[B"]);
      expect(keyOf(k as Keypress)).toBe("down");
    });

    it("the application-cursor-mode form some terminals send", async () => {
      const [k] = await pressesFrom(["\u001bOA"]);
      expect(keyOf(k as Keypress)).toBe("up");
    });

    it("a real Escape press alone is still a quit, not an arrow key", async () => {
      // Node waits out its own escape-sequence timeout before deciding no more bytes are coming.
      const stream = new PassThrough();
      emitKeypressEvents(stream);
      const seen: Keypress[] = [];
      stream.on("keypress", (_s, k) => k && seen.push(k));
      stream.write("\u001b");
      await new Promise((r) => setTimeout(r, 600));
      expect(keyOf(seen[0] as Keypress)).toBe("quit");
    });
  });
});

describe("the quick question before the checklist (F3: a preset first)", () => {
  it("names the places, not what each does, and names a too-old place in its own aside", () => {
    expect(quickSetupPrompt(places)).toBe(
      "Agent Rewake found Zed, Claude Code and Grok Build on this computer " +
        "(Codex is too old to set up).\nInstall Rewake for the rest of them? [Y/n] (default: yes) ",
    );
  });

  it("says 'all of them' when nothing is excluded, and lists two names with 'and'", () => {
    const [zed, claude] = places;
    expect(quickSetupPrompt(zed && claude ? [zed, claude] : [])).toBe(
      "Agent Rewake found Zed and Claude Code on this computer.\nInstall Rewake for all of them? [Y/n] (default: yes) ",
    );
  });

  // gh CLI's accessible prompter does the same ("Clone the new repository locally? (default:
  // yes)", internal/prompter/prompter.go): a screen reader doesn't announce letter case, so
  // the capital Y in "[Y/n]" alone doesn't say what pressing Enter does.
  it("says the default in words, not only as a capital letter in [Y/n]", () => {
    expect(quickSetupPrompt(places)).toContain("(default: yes)");
  });

  it("never mentions a place that wasn't found at all: there's no decision to make about it here (C1)", () => {
    // The function doesn't take a `missing` list any more — there's nothing to pass it, and
    // nothing in its output can say "wasn't found". The checklist (Stage 2) still lists it.
    expect(quickSetupPrompt(places)).not.toMatch(/not found|wasn't found|weren't found/);
  });

  it("asks nothing when there's only one place and nothing else to explain (F4)", () => {
    const [zed] = places;
    expect(quickSetupPrompt(zed ? [zed] : [])).toBeUndefined();
  });

  it("still asks when there's one ready place but a too-old one alongside it", () => {
    const [zed] = places;
    const withTooOld = zed ? [zed, ...places.filter((p) => p.state === "too-old")] : [];
    expect(quickSetupPrompt(withTooOld)).toBeDefined();
  });
});

describe("the result lines after installing several places", async () => {
  const { summaryText } = await import("../src/cli.js");
  it("says done with the place's next step, or not changed with its reason", () => {
    expect(
      summaryText([
        ["zed", 0, "Agent Rewake will set up Zed…\nDone.\nQuit Zed and open it again.\n"],
        ["codex", 1, "…\nCodex couldn't add the plugin, so nothing was changed.\n"],
      ]),
    ).toBe(
      "\nResult:\n  Zed    done: Quit Zed and open it again.\n  Codex  not changed: Codex couldn't add the plugin, so nothing was changed. Try it on its own: agent-rewake install --only codex\n",
    );
  });
});

describe("install with no place named and no terminal (--yes)", () => {
  it("starts from the places found when there is no Zed", () => {
    const noZed = places.filter((p) => p.id !== "zed");
    expect(defaultPlaceText(noZed)).toBe(
      "Zed wasn't found on this computer, but these were: Claude Code. Setting up Zed (the default) anyway. To set up what was found instead, run: agent-rewake install --only claude-code\n",
    );
  });

  it("names every agent that can be set up, not the ones too old or already set up", () => {
    const more = placesFrom(
      [
        { id: "claude-code", name: "Claude Code", surfaces: ["terminal"] },
        { id: "gemini-cli", name: "Gemini CLI", surfaces: ["terminal"] },
      ],
      { found: false },
      new Set(),
      () => undefined,
      older,
    );
    expect(defaultPlaceText(more)).toContain("these were: Claude Code, Gemini CLI.");
    expect(defaultPlaceText(more)).toContain("install --only claude-code,gemini-cli");
  });

  it("keeps the old line when Zed is here, or when nothing else was found", () => {
    const old =
      "Setting up Zed (the default). To choose other places, run install in a terminal without --yes, or name them: --only claude-code,codex\n";
    expect(defaultPlaceText(places)).toBe(old);
    expect(defaultPlaceText([])).toBe(old);
  });
});
