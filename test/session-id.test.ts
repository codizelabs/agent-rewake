import { describe, expect, it } from "vitest";
import { safeSessionId } from "../src/hosts/sessions.js";

describe("session ids", () => {
  it("accept the shapes agents use", () => {
    for (const id of ["8114c47b-80eb-47b5-bb6d-53ad1c731995", "s_1", "abc-def", "A".repeat(128)])
      expect(safeSessionId(id)).toBe(true);
  });

  it("refuse a leading dash (an option to a command), paths, spaces and long text", () => {
    for (const id of [
      "-rf",
      "--resume",
      "-",
      "../x",
      "a/b",
      "a b",
      "",
      "A".repeat(129),
      42,
      undefined,
    ])
      expect(safeSessionId(id)).toBe(false);
  });
});
