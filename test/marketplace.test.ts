import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The repository is also a Claude Code plugin marketplace (`claude plugin marketplace add
 * codizelabs/agent-rewake`): the file at the root names the plugin that lives under
 * src/hosts/claude-code/mod. Checked with the real CLI by hand with `claude plugin validate --strict`
 * and an install from a local folder; here, that the pointers stay right.
 */
const root = join(import.meta.dirname, "..");
type Manifest = {
  name: string;
  owner?: unknown;
  plugins?: { name: string; source: string }[];
};
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as Manifest;

describe("the root Claude Code marketplace", () => {
  const market = read(".claude-plugin/marketplace.json");
  const plugin = read("src/hosts/claude-code/mod/.claude-plugin/plugin.json");

  it("lists the plugin by the name and source it really has", () => {
    const entries = market.plugins ?? [];
    expect(entries).toHaveLength(1);
    const entry = entries[0] as { name: string; source: string };
    expect(entry.name).toBe(plugin.name);
    expect(existsSync(join(root, entry.source, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("names the same marketplace and owner as the one inside the plugin folder", () => {
    const inner = read("src/hosts/claude-code/mod/.claude-plugin/marketplace.json");
    expect(market.name).toBe(inner.name);
    expect(market.owner).toEqual(inner.owner);
  });
});
