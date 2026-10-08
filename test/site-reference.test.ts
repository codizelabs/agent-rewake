import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACP_PLACE } from "../src/addon.js";
import { rewakeHelp } from "../src/core/command.js";
import { STATUS_WORDS } from "../src/ui/overview.js";

// The docs site's reference page must match the code.
const root = join(import.meta.dirname, "..");
// The docs are one page; its Reference section holds the tables.
const reference = readFileSync(join(root, "site/src/content/docs/docs.mdx"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("the version people are told they have", () => {
  // The site reads it from package.json; the README and docs say it in words. A release that
  // forgets one of them tells a visitor they are on an older version than npm serves.
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
  const majorMinor = version.split(".").slice(0, 2).join(".");

  for (const file of ["README.md", "site/src/content/docs/docs.mdx"]) {
    it(`${file}'s Status says ${majorMinor}`, () => {
      const said = /^Version (\d+\.\d+)\./m.exec(readFileSync(join(root, file), "utf8"))?.[1];
      expect(said).toBe(majorMinor);
    });
  }

  it("the landing page takes the version from package.json, never a literal", () => {
    const page = readFileSync(join(root, "site/src/pages/index.astro"), "utf8");
    expect(page).toContain('import { version } from "../../../package.json"');
    expect(page).not.toMatch(/Early release[^<]*\d+\.\d+/);
  });
});

describe("docs site reference page", () => {
  it("documents every /rewake form that the command's help lists", () => {
    const forms = rewakeHelp(ACP_PLACE)
      .split("\n")
      .filter((l) => l.startsWith("/rewake"))
      .flatMap((l) => (l.split(/\s{3,}/)[0] ?? "").split(" · "))
      .map((f) => f.replace(/^\/rewake\s*/, "").split(/[\s|]/)[0] ?? "")
      .filter((w) => /^[a-z]+$/.test(w));
    expect(forms.length).toBeGreaterThan(8);
    for (const sub of forms) expect(reference, sub).toContain(`/rewake ${sub}`);
    for (const sub of ["help", "continue", "stop"]) expect(reference).toContain(`/rewake ${sub}`);
  });

  it("documents every scheduled-message state", () => {
    for (const word of Object.values(STATUS_WORDS))
      expect(reference, word).toContain(`| ${word} |`);
  });

  it("documents every AGENT_REWAKE_ environment variable the code reads", () => {
    const vars = new Set<string>();
    for (const file of sourceFiles(join(root, "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/AGENT_REWAKE_[A-Z_]+/g)) vars.add(m[0]);
    }
    expect(vars.size).toBeGreaterThan(3);
    for (const v of vars) expect(reference, v).toContain(v);
  });

  it("documents every command-line command", () => {
    for (const cmd of [
      "doctor",
      "ui",
      "schedules",
      "install",
      "uninstall",
      "setup zed",
      "--version",
    ]) {
      expect(reference, cmd).toContain(`agent-rewake ${cmd}`);
    }
  });
});
