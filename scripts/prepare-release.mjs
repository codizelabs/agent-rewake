// Prepares a release (plan §10A.4): sets package.json's version and moves the changelog's
// [Unreleased] section under the new version with today's date, leaving an empty [Unreleased].
// Usage: node scripts/prepare-release.mjs <x.y.z>. Changes files only; the prepare-release
// workflow commits them on release/<x.y.z> and opens the pull request.
import { readFileSync, writeFileSync } from "node:fs";

export function moveUnreleased(changelog, version, date) {
  const head = "## [Unreleased]";
  const at = changelog.indexOf(head);
  if (at === -1) throw new Error("CHANGELOG.md has no [Unreleased] section.");
  if (changelog.includes(`## [${version}]`))
    throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  const body = changelog.slice(at + head.length);
  const next = body.search(/\n## \[/);
  const notes = (next === -1 ? body : body.slice(0, next)).trim();
  if (!notes) throw new Error("[Unreleased] is empty: there's nothing to release.");
  const rest = next === -1 ? "" : body.slice(next);
  return `${changelog.slice(0, at)}${head}\n\n## [${version}] - ${date}\n\n${notes}\n${rest}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = process.argv[2] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("Usage: node scripts/prepare-release.mjs <x.y.z>");
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const [a, b] = [pkg.version, version].map((v) => v.split(".").map(Number));
  if (b[0] < a[0] || (b[0] === a[0] && (b[1] < a[1] || (b[1] === a[1] && b[2] <= a[2])))) {
    console.error(`${version} isn't newer than ${pkg.version}.`);
    process.exit(2);
  }
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    "CHANGELOG.md",
    moveUnreleased(readFileSync("CHANGELOG.md", "utf8"), version, date),
  );
  pkg.version = version;
  writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Prepared ${version} (${date}).`);
}
