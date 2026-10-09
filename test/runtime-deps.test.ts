import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_RUNTIME_DEPENDENCIES,
  runtimeDependencyProblems,
} from "../scripts/runtime-deps.mjs";

const ACP = "@agentclientprotocol/claude-agent-acp";

describe("runtime-deps", () => {
  it("allows only the Claude ACP adapter", () => {
    expect(ALLOWED_RUNTIME_DEPENDENCIES).toEqual([ACP]);
  });

  it("finds nothing wrong with the repository's own package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(runtimeDependencyProblems(pkg)).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["the allowed package at an exact version", { dependencies: { [ACP]: "0.85.1" } }],
    ["an exact prerelease", { dependencies: { [ACP]: "0.86.0-beta.1" } }],
    ["no dependencies field", { name: "x" }],
    ["an empty dependencies object", { dependencies: {} }],
    [
      "empty optional, peer and bundle fields",
      {
        dependencies: { [ACP]: "0.85.1" },
        optionalDependencies: {},
        peerDependencies: {},
        bundleDependencies: [],
        bundledDependencies: [],
      },
    ],
  ])("accepts %s", (_, pkg) => {
    expect(runtimeDependencyProblems(pkg)).toEqual([]);
  });

  it("reports a dependency that isn't allowed, by name", () => {
    const problems = runtimeDependencyProblems({
      dependencies: { [ACP]: "0.85.1", "left-pad": "1.3.0" },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("left-pad");
  });

  it.each([
    "^0.85.1",
    "~0.85.1",
    "0.85.x",
    "*",
    "latest",
    ">=0.85.1",
    "0.85.1 - 0.86.0",
    "npm:other@1.0.0",
    "github:a/b",
    "file:../x",
  ])("reports the allowed package at %j, which isn't one exact version", (version) => {
    const problems = runtimeDependencyProblems({ dependencies: { [ACP]: version } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(ACP);
  });

  it.each<[string, unknown]>([
    ["optionalDependencies", { "left-pad": "1.3.0" }],
    ["peerDependencies", { react: "19.0.0" }],
    ["bundleDependencies", ["left-pad"]],
    ["bundleDependencies", true],
    ["bundledDependencies", ["left-pad"]],
    ["bundledDependencies", true],
  ])("reports a non-empty %s (%j)", (field, value) => {
    const problems = runtimeDependencyProblems({
      dependencies: { [ACP]: "0.85.1" },
      [field]: value,
    });
    expect(problems.length).toBeGreaterThanOrEqual(1);
    expect(problems.some((p) => p.includes(field))).toBe(true);
  });

  it("reports every problem, not just the first", () => {
    const problems = runtimeDependencyProblems({
      dependencies: { [ACP]: "0.85.1", "left-pad": "1.3.0" },
      peerDependencies: { react: "19.0.0" },
    });
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.some((p) => p.includes("left-pad"))).toBe(true);
    expect(problems.some((p) => p.includes("peerDependencies"))).toBe(true);
  });
});
