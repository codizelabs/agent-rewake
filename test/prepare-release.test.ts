import { describe, expect, it } from "vitest";
import { moveUnreleased } from "../scripts/prepare-release.mjs";

const LOG = `# Changelog

Intro.

## [Unreleased]

### Fixed

- A fix.

## [0.1.1] - 2026-10-01

- Old.
`;

describe("prepare-release", () => {
  it("moves [Unreleased] under the new version and leaves an empty [Unreleased]", () => {
    const out = moveUnreleased(LOG, "0.2.0", "2026-10-07");
    expect(out).toContain(
      "## [Unreleased]\n\n## [0.2.0] - 2026-10-07\n\n### Fixed\n\n- A fix.\n\n## [0.1.1]",
    );
  });

  it("refuses an empty [Unreleased] or a version already there", () => {
    expect(() => moveUnreleased(LOG.replace("### Fixed\n\n- A fix.\n", ""), "0.2.0", "d")).toThrow(
      "nothing to release",
    );
    expect(() => moveUnreleased(LOG, "0.1.1", "d")).toThrow("already has a section");
  });
});
