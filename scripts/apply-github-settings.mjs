// Applies the repository's GitHub settings from files, so they're reviewed in
// pull requests like code:
//   - merge settings (below);
//   - labels from .github/labels.json (created or updated; others are listed, removed only with
//     --prune);
//   - Actions defaults: a read-only GITHUB_TOKEN, and Actions can't approve pull requests;
//   - rulesets from .github/rulesets/*.json, created or updated by name;
//   - approval before workflows run for external contributors' pull requests.
// The last two need a public repository on a free account; the script says so and stops there.
// Needs the GitHub CLI signed in as a repository admin.
//
//   node scripts/apply-github-settings.mjs --dry-run   show what would change
//   node scripts/apply-github-settings.mjs             apply it
//   node scripts/apply-github-settings.mjs --prune     also delete labels not in labels.json
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "codizelabs/agent-rewake";
const dryRun = process.argv.includes("--dry-run");
const prune = process.argv.includes("--prune");
const root = join(import.meta.dirname, "..");

/** Squash merge only, the PR title and body as the commit, branches deleted after merging. */
const MERGE_SETTINGS = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "PR_BODY",
  delete_branch_on_merge: true,
  allow_auto_merge: false,
};

/** Least privilege for workflows (each workflow also declares its own permissions). */
const WORKFLOW_PERMISSIONS = {
  default_workflow_permissions: "read",
  can_approve_pull_request_reviews: false,
};

/** Fork pull requests from anyone outside the project wait for a maintainer before CI runs. */
const FORK_APPROVAL = { approval_policy: "all_external_contributors" };

function gh(args, input) {
  return execFileSync("gh", ["api", ...args], {
    encoding: "utf8",
    ...(input !== undefined && { input }),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function apply(label, args, body) {
  if (dryRun) {
    console.log(`would ${label}`);
    return;
  }
  gh([...args, ...(body === undefined ? [] : ["--input", "-"])], body && JSON.stringify(body));
  console.log(`done: ${label}`);
}

const needsPublic = (err) => String(err.stderr ?? err.message).includes("Upgrade to GitHub Pro");

// 1. Merge settings.
apply(`set merge settings of ${REPO}`, ["-X", "PATCH", `repos/${REPO}`], MERGE_SETTINGS);

// 2. Labels.
const wanted = JSON.parse(readFileSync(join(root, ".github", "labels.json"), "utf8")).labels;
const current = JSON.parse(
  gh(["--paginate", "--slurp", `repos/${REPO}/labels?per_page=100`]),
).flat();
const byName = new Map(current.map((l) => [l.name.toLowerCase(), l]));
for (const l of wanted) {
  const have = byName.get(l.name.toLowerCase());
  const body = { new_name: l.name, color: l.color, description: l.description };
  if (!have) {
    apply(`create label "${l.name}"`, ["-X", "POST", `repos/${REPO}/labels`], {
      name: l.name,
      color: l.color,
      description: l.description,
    });
  } else if (
    have.name !== l.name ||
    have.color.toLowerCase() !== l.color.toLowerCase() ||
    (have.description ?? "") !== l.description
  ) {
    apply(
      `update label "${l.name}"`,
      ["-X", "PATCH", `repos/${REPO}/labels/${encodeURIComponent(have.name)}`],
      body,
    );
  }
}
const known = new Set(wanted.map((l) => l.name.toLowerCase()));
for (const l of current.filter((x) => !known.has(x.name.toLowerCase()))) {
  if (prune)
    apply(`delete label "${l.name}"`, [
      "-X",
      "DELETE",
      `repos/${REPO}/labels/${encodeURIComponent(l.name)}`,
    ]);
  else console.log(`not in labels.json (kept; --prune deletes it): "${l.name}"`);
}

// 3. Actions defaults.
apply(
  "set Actions to a read-only token that can't approve pull requests",
  ["-X", "PUT", `repos/${REPO}/actions/permissions/workflow`],
  WORKFLOW_PERMISSIONS,
);

// 4. Rulesets (public repositories, or a paid plan).
const rulesets = readdirSync(join(root, ".github", "rulesets"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(root, ".github", "rulesets", f), "utf8")));
let existing;
try {
  existing = JSON.parse(gh([`repos/${REPO}/rulesets`]));
} catch (err) {
  if (!needsPublic(err)) throw err;
  for (const r of rulesets) console.log(`not available yet: ruleset "${r.name}"`);
  console.log('not available yet: workflow approval for "all external contributors"');
  console.error(
    "Rulesets aren't available: the repository is private on a free account. Make it public (or upgrade), then run this again.",
  );
  process.exit(1);
}
for (const ruleset of rulesets) {
  const found = existing.find((r) => r.name === ruleset.name);
  if (found)
    apply(
      `update ruleset "${ruleset.name}"`,
      ["-X", "PUT", `repos/${REPO}/rulesets/${found.id}`],
      ruleset,
    );
  else apply(`create ruleset "${ruleset.name}"`, ["-X", "POST", `repos/${REPO}/rulesets`], ruleset);
}

// 5. Fork pull request approval.
apply(
  'require approval before workflows run for "all external contributors"',
  ["-X", "PUT", `repos/${REPO}/actions/permissions/fork-pr-contributor-approval`],
  FORK_APPROVAL,
);
