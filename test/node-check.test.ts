import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_NODE_MAJOR, oldNodeMessage } from "../src/node-check.js";

describe("the Node.js version check", () => {
  it("names the version and the next step for a Node.js older than 22", () => {
    for (const v of ["18.19.1", "v20.11.0", "21.7.3", "16.0.0"])
      expect(oldNodeMessage(v)).toBe(
        `Agent Rewake needs Node.js 22 or newer (you have ${v.replace(/^v/, "")}). Update Node.js (nodejs.org), then run the command again.\n`,
      );
  });

  it("says nothing for Node.js 22 and newer", () => {
    for (const v of ["22.0.0", "v22.4.1", "24.14.1", "30.0.0"])
      expect(oldNodeMessage(v)).toBeUndefined();
  });

  it("says nothing for a version it can't read, rather than refusing to run", () => {
    expect(oldNodeMessage("")).toBeUndefined();
    expect(oldNodeMessage("unknown")).toBeUndefined();
  });

  it("matches the minimum in package.json", () => {
    const { engines } = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { engines: { node: string } };
    expect(engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });

  it("runs before the rest of Rewake loads, so an old Node.js never reaches code it can't run", () => {
    const main = readFileSync(join(import.meta.dirname, "..", "src", "main.ts"), "utf8");
    // The command line is loaded with import(), after the check, never as a static import.
    expect(main).not.toMatch(/^import .* from "\.\/cli\.js"/m);
    expect(main).toContain('import("./cli.js")');
    expect(main.indexOf("oldNodeMessage(")).toBeLessThan(main.indexOf('import("./cli.js")'));
  });
});
