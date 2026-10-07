import { describe, expect, it } from "vitest";
import {
  choosePlaces,
  defaultChoice,
  keyOf,
  type Place,
  PREVIEW_NOTE,
  placesFrom,
  press,
  renderChoice,
  UNREACHABLE,
} from "../src/install/select.js";

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
    const lines = renderChoice(places, defaultChoice(places), 0, ["Gemini CLI"]);
    expect(lines[0]).toBe("> [x] Zed 1.22.0");
    expect(lines).toContain(
      "   -  Codex 0.140.0: too old for Rewake (it needs 0.149.0 or newer). Update it: see its own docs",
    );
    expect(lines).toContain("  [ ] Grok Build 1.0.46: Rewake is set up here (tick to update)");
    expect(lines).toContain("   -  Gemini CLI: not found.");
    expect(lines.slice(-3)).toEqual(["", PREVIEW_NOTE, UNREACHABLE]);
  });

  it("moves, ticks and unticks with the keys, and never ticks a too-old agent", () => {
    const chosen = defaultChoice(places);
    const state = { cursor: 0 };
    press(keyOf(" "), places, chosen, state);
    expect(chosen.has("zed")).toBe(false);
    press(keyOf("\u001b[B"), places, chosen, state);
    press(keyOf("\u001b[B"), places, chosen, state);
    press(keyOf(" "), places, chosen, state);
    expect(chosen.has("codex")).toBe(false);
    press(keyOf("a"), places, chosen, state);
    expect([...chosen].sort()).toEqual(["claude-code", "grok", "zed"]);
    expect(press(keyOf("\r"), places, chosen, state)).toBe("done");
    expect(press(keyOf("q"), places, chosen, state)).toBe("quit");
  });

  it("answers with the ticked places on Enter, and nothing on q", async () => {
    async function* keys(k: string[]) {
      for (const x of k) yield x;
    }
    const io = (k: string[]) => ({ keys: keys(k), write: () => {} });
    expect(await choosePlaces(places, [], io([" ", "\r"]))).toEqual(["claude-code"]);
    expect(await choosePlaces(places, [], io(["q"]))).toBeUndefined();
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
