import { describe, expect, it } from "vitest";
import { oneLine } from "../src/ui/overview.js";
import { printable } from "../src/util/printable.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("text from outside Rewake, shown in a terminal", () => {
  it("replaces escapes, other control characters and text-reordering marks", () => {
    const clipboard = `${ESC}]52;c;ZXZpbA==${BEL}`;
    expect(printable(`a${clipboard}b`)).not.toContain(ESC);
    expect(printable(`a${clipboard}b`)).not.toContain(BEL);
    expect(printable(`x${String.fromCharCode(0x202e)}y`)).toBe("x�y");
    expect(printable(`one${String.fromCharCode(0x85)}two\tthree`)).toBe("one two three");
    expect(printable("plain text, ünïcode and emoji 🙂 stay")).toBe(
      "plain text, ünïcode and emoji 🙂 stay",
    );
  });

  it("covers the schedule listing's one-line text", () => {
    expect(oneLine(`resume${ESC}[2J now`)).not.toContain(ESC);
  });
});
