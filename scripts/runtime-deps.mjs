// What the npm package may depend on at run time (plan: a near-zero-dependency bundle). Everything
// else is bundled into dist/agent-rewake.js or is a development dependency. The Claude adapter is
// the one exception, because it must never be bundled, and it is pinned to one exact version so
// everyone gets the adapter the checks ran against.

export const ALLOWED_RUNTIME_DEPENDENCIES = Object.freeze([
  "@agentclientprotocol/claude-agent-acp",
]);

// One exact version, prerelease and build metadata allowed (semver.org §2, §9, §10).
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** What is wrong with a package.json's runtime dependencies; [] when nothing is. */
export function runtimeDependencyProblems(pkg) {
  const problems = [];
  const deps = pkg.dependencies ?? {};
  for (const [name, version] of Object.entries(deps)) {
    if (!ALLOWED_RUNTIME_DEPENDENCIES.includes(name))
      problems.push(
        `${name} is a runtime dependency; only ${ALLOWED_RUNTIME_DEPENDENCIES.join(", ")} may be. Bundle it or make it a devDependency.`,
      );
    else if (typeof version !== "string" || !EXACT.test(version))
      problems.push(`${name} is "${version}"; pin it to one exact version.`);
  }
  for (const field of [
    "optionalDependencies",
    "peerDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    const value = pkg[field];
    const empty =
      value === undefined ||
      value === false ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" && value !== null && Object.keys(value).length === 0);
    if (!empty) problems.push(`${field} is set; the package may have none.`);
  }
  return problems;
}
