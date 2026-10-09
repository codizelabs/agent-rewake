/**
 * The website's changelog page reads CHANGELOG.md at build time. Only released versions are
 * listed: `## [Unreleased]` is left out, so the page never announces what isn't installable.
 * (The site is built from `main` at a release, and a release's section is in CHANGELOG.md before
 * `main` gets it; see CONTRIBUTING.md, Releasing.)
 *
 * The changelog's own Markdown is small: `###` headings, bullets (one level of nesting), `**bold**`,
 * `code` and `[links](https://…)`. Everything is HTML-escaped first, so nothing in the file can
 * become markup, and only http(s) links are kept.
 */
export type ChangelogGroup = { heading: string; html: string };
export type ChangelogRelease = { version: string; date: string; groups: ChangelogGroup[] };

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `code`, **bold** and [text](https://…), applied to escaped text. */
export function inline(raw: string): string {
  return escapeHtml(raw)
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 1 && part.startsWith("`") && part.endsWith("`"))
        return `<code>${part.slice(1, -1)}</code>`;
      return part
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    })
    .join("");
}

/** One group's lines (bullets, one level of nested bullets, plain paragraphs) as HTML. */
function blockHtml(lines: string[]): string {
  const out: string[] = [];
  let listOpen = false;
  let itemOpen = false;
  let nestedOpen = false;
  const closeNested = () => {
    if (nestedOpen) out.push("</ul>");
    nestedOpen = false;
  };
  const closeItem = () => {
    closeNested();
    if (itemOpen) out.push("</li>");
    itemOpen = false;
  };
  const closeList = () => {
    closeItem();
    if (listOpen) out.push("</ul>");
    listOpen = false;
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    const top = /^-\s+(.*)$/.exec(line);
    const nested = /^\s{2,}-\s+(.*)$/.exec(line);
    if (top) {
      closeItem();
      if (!listOpen) out.push("<ul>");
      listOpen = true;
      out.push(`<li>${inline(top[1] ?? "")}`);
      itemOpen = true;
    } else if (nested && itemOpen) {
      if (!nestedOpen) out.push("<ul>");
      nestedOpen = true;
      out.push(`<li>${inline(nested[1] ?? "")}</li>`);
    } else if (itemOpen && /^\s+\S/.test(line)) {
      // An indented line after a bullet continues that bullet.
      closeNested();
      out.push(`<p>${inline(line.trim())}</p>`);
    } else {
      closeList();
      out.push(`<p>${inline(line.trim())}</p>`);
    }
  }
  closeList();
  return out.join("");
}

/** Released versions, in the file's order (newest first). */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | undefined;
  let heading = "";
  let lines: string[] = [];
  const flush = () => {
    if (release && lines.some((l) => l.trim()))
      release.groups.push({ heading, html: blockHtml(lines) });
    lines = [];
  };
  for (const line of markdown.split("\n")) {
    const version = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (version) {
      flush();
      release = { version: version[1] ?? "", date: version[2] ?? "", groups: [] };
      releases.push(release);
      heading = "";
    } else if (/^## /.test(line) || /^\[[^\]]+\]: /.test(line)) {
      flush(); // [Unreleased], or the link list at the end: not a release
      release = undefined;
    } else if (release && /^### /.test(line)) {
      flush();
      heading = line.slice(4).trim();
    } else if (release) {
      lines.push(line);
    }
  }
  flush();
  return releases;
}
