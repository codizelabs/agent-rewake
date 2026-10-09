import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inline, parseChangelog } from "../site/src/lib/changelog.js";

// The website's content must be true of the code: its matrix, install commands, trust claims and
// links are checked here against the README, the docs, the CLI and the source.
const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const landing = read("site/src/pages/index.astro");
const docs = read("site/src/content/docs/docs.mdx");
const privacy = read("site/src/content/docs/docs/privacy-and-security.mdx");
const readme = read("README.md");
const cli = read("src/cli.ts");

/** Starlight's heading ids: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
const docAnchors = new Set([...docs.matchAll(/^#{2,4} (.+)$/gm)].map((m) => slug(m[1] ?? "")));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : /\.(ts|js)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}
/** Source lines that aren't comments. */
const codeLines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

describe("the changelog page", () => {
  const markdown = read("CHANGELOG.md");
  const releases = parseChangelog(markdown);

  it("lists released versions only, newest first, starting with the one in package.json", () => {
    expect(releases.length).toBeGreaterThan(3);
    expect(releases[0]?.version).toBe(JSON.parse(read("package.json")).version);
    const heads = [...markdown.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
    expect(releases.map((r) => r.version)).toEqual(heads);
    const page = JSON.stringify(releases);
    expect(page).not.toContain("Unreleased");
  });

  it("leaves out an Unreleased section, even one with entries", () => {
    const out = parseChangelog(
      "## [Unreleased]\n\n### Added\n\n- Not out yet.\n\n## [1.0.0] - 2026-01-02\n\n### Fixed\n\n- A fix.\n\n[1.0.0]: https://example.com\n",
    );
    expect(out).toEqual([
      {
        version: "1.0.0",
        date: "2026-01-02",
        groups: [{ heading: "Fixed", html: "<ul><li>A fix.</li></ul>" }],
      },
    ]);
  });

  it("renders bullets, nested bullets, bold, code and links, and nothing else as markup", () => {
    const [release] = parseChangelog(
      "## [1.0.0] - 2026-01-02\n\n### Added\n\n- **Bold** and `a <b> tag` and [a link](https://example.com/x).\n  - nested one\n  - nested two\n- Next <script>alert(1)</script> [bad](javascript:alert(1)).\n",
    );
    const html = release?.groups[0]?.html ?? "";
    expect(html).toBe(
      '<ul><li><strong>Bold</strong> and <code>a &lt;b&gt; tag</code> and <a href="https://example.com/x">a link</a>.<ul><li>nested one</li><li>nested two</li></ul></li><li>Next &lt;script&gt;alert(1)&lt;/script&gt; [bad](javascript:alert(1)).</li></ul>',
    );
    expect(inline("[x](http://a.b)")).toBe('<a href="http://a.b">x</a>');
  });

  it("keeps an indented line after a bullet inside that bullet", () => {
    const [release] = parseChangelog(
      "## [1.0.0] - 2026-01-02\n\n### Added\n\n- A list:\n  - one\n  - two\n\n  It works offline.\n- Next.\n",
    );
    expect(release?.groups[0]?.html).toBe(
      "<ul><li>A list:<ul><li>one</li><li>two</li></ul><p>It works offline.</p></li><li>Next.</li></ul>",
    );
  });

  it("opens and closes every list it writes", () => {
    for (const r of releases)
      for (const g of r.groups) {
        expect(g.html.match(/<ul>/g)?.length ?? 0, `${r.version} ${g.heading}`).toBe(
          g.html.match(/<\/ul>/g)?.length ?? 0,
        );
        expect(g.html.match(/<li>/g)?.length ?? 0).toBe(g.html.match(/<\/li>/g)?.length ?? 0);
      }
  });

  it("is in the docs sidebar and the site's footer", () => {
    expect(read("site/astro.config.mjs")).toContain('link: "/changelog/"');
    expect(landing).toContain('href("changelog/")');
    expect(docs).toContain("(../changelog/)");
  });
});

describe("the agents matrix", () => {
  const statuses = [...landing.matchAll(/status: "([^"]+)"/g)].map((m) => m[1] ?? "");

  it("uses the README's status words, nothing made up", () => {
    expect(statuses.length).toBe(8);
    for (const s of statuses) expect(readme, s).toContain(`| ${s} |`);
  });

  it("carries every status the README's table has", () => {
    const table = readme.slice(
      readme.indexOf("## Where you work"),
      readme.indexOf("## Quick start"),
    );
    const readmeStatuses = [...table.matchAll(/\| ([^|\n]+) \|\n/g)]
      .map((m) => (m[1] ?? "").trim())
      .filter((s) => s !== "Status" && !s.startsWith("---"));
    expect(readmeStatuses.length).toBe(9);
    for (const s of new Set(readmeStatuses)) expect(statuses, s).toContain(s);
  });

  it("links every guide to a docs heading that exists", () => {
    const ids = [...landing.matchAll(/\["[^"]+", "([a-z-]+)"\]/g)].map((m) => m[1] ?? "");
    expect(ids.length).toBeGreaterThan(6);
    for (const id of ids) expect(docAnchors, id).toContain(id);
  });
});

describe("the install commands", () => {
  const places = new Set(
    [
      ...(/const INSTALL_PLACES = new Set\(\[([^\]]+)\]/.exec(cli)?.[1] ?? "").matchAll(
        /"([a-z-]+)"/g,
      ),
    ].map((m) => m[1]),
  );
  const flags = [...landing.matchAll(/flag: "([a-z-]+)"/g)].map((m) => m[1]);

  it("name every place `install --only` takes, spelled the way the CLI spells it", () => {
    expect(places.size).toBeGreaterThan(8);
    expect(new Set(flags)).toEqual(places);
  });

  it("are the ones the docs guides give", () => {
    for (const flag of flags) expect(docs, flag).toContain(`install --only ${flag}`);
  });
});

describe("the trust claims", () => {
  const src = sourceFiles(join(root, "src")).filter((f) => !f.includes("/tests/"));

  it("name no permission-bypass flag in any line Rewake runs", () => {
    const flags = /--dangerously|--yolo|--allow-all|--trust\b|"yolo"|bypassPermissions/;
    for (const file of src)
      for (const line of codeLines(file)) {
        if (/isBypassMode|\.test\(mode\)/.test(line)) continue; // detects a bypass mode; sets none
        expect(line, file).not.toMatch(flags);
      }
  });

  it("pass an approval flag only as Gemini CLI's own default mode, which never widens yours", () => {
    const withFlag = src.flatMap((file) =>
      codeLines(file)
        .filter((l) => /--approval-mode|--permission-mode|--sandbox/.test(l))
        .map((l) => ({ file, l })),
    );
    expect(withFlag.length).toBeGreaterThan(0);
    for (const { file, l } of withFlag) {
      expect(file.replaceAll("\\", "/")).toContain("hosts/gemini/host.ts");
      expect(l).toContain('"default"');
    }
  });

  it("send nothing about the person over the network (only an agent's own program is fetched, in wrap.ts)", () => {
    const net = /node:(http|https|http2|dgram|tls|dns)|\bfetch\(|XMLHttpRequest/;
    for (const file of src) for (const line of codeLines(file)) expect(line, file).not.toMatch(net);
  });

  it("claim nothing the repository doesn't establish", () => {
    const pages = [landing, docs, privacy].join("\n");
    expect(pages).not.toMatch(
      /provenance|sigstore|\bsigned (package|release)|SOC ?2|zero telemetry/i,
    );
    expect(pages).not.toMatch(/trusted by|users worldwide|testimonial/i);
  });

  it("are on the landing page and the privacy page", () => {
    for (const heading of [
      "Approve anything for you",
      "Add a permission-bypass flag",
      "Type into your terminal",
      "Resume a limit that waiting won't fix",
      "Send what you didn't choose",
      "Send anything about you anywhere",
      "Be hard to remove",
    ])
      expect(landing, heading).toContain(heading);
    for (const heading of ["## What Rewake never does", "## What it stores, and where"])
      expect(privacy, heading).toContain(heading);
  });
});

describe("reporting a limit Rewake missed", () => {
  it("asks for the output of a command that exists", () => {
    expect(cli).toContain("agent-rewake doctor [--details]");
    for (const text of [docs, landing]) expect(text).toContain("doctor --details");
    expect(docs).toContain("### Report a limit Rewake missed");
  });

  it("names a command (doctor --limit-sample) only if the CLI has it", () => {
    const named = [landing, docs, privacy].some((t) => t.includes("limit-sample"));
    if (named) expect(cli).toContain("limit-sample");
  });

  it("points at an issue form that exists", () => {
    expect(docs).toContain("issues/new?template=bug_report.yml");
    expect(read(".github/ISSUE_TEMPLATE/bug_report.yml")).toContain("name: Bug report");
  });
});

describe("links between the pages", () => {
  const anchors = (text: string) =>
    [...text.matchAll(/docs\/#([a-z0-9-]+)/g)].map((m) => m[1] ?? "");

  it("point at docs headings that exist", () => {
    const wanted = new Set([...anchors(landing), ...anchors(privacy), ...anchors(docs)]);
    expect(wanted.size).toBeGreaterThan(8);
    for (const a of wanted) expect(docAnchors, a).toContain(a);
    for (const m of privacy.matchAll(/\]\(\.\.\/#([a-z0-9-]+)\)/g))
      expect(docAnchors, m[1]).toContain(m[1]);
  });

  it("make the docs' privacy section point at the full page", () => {
    expect(docs).toContain("(privacy-and-security/)");
    expect(landing).toContain('href("docs/privacy-and-security/")');
  });
});

describe("social cards", () => {
  it("every page says which page it is, with its own title and description", () => {
    for (const text of [landing, privacy, read("site/src/pages/changelog.astro")]) {
      expect(text).toMatch(/twitter:title/);
      expect(text).toMatch(/twitter:description/);
    }
    expect(landing).toContain('property="og:title"');
    expect(privacy).toContain("property: og:title");
    expect(read("site/src/pages/changelog.astro")).toContain('property: "og:title"');
  });
});
