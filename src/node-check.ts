/** The oldest Node.js major version Rewake runs on (`engines` in package.json, the build target). */
export const MIN_NODE_MAJOR = 22;

/**
 * What to tell someone running an older Node.js, or undefined when this one is new enough. Kept
 * free of imports, so it runs before the rest of Rewake loads and can't fail on an old Node.js.
 */
export function oldNodeMessage(version: string): string | undefined {
  const major = Number.parseInt(version.replace(/^v/, ""), 10);
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return undefined;
  return `Agent Rewake needs Node.js ${MIN_NODE_MAJOR} or newer (you have ${version.replace(/^v/, "")}). Update Node.js (nodejs.org), then run the command again.\n`;
}
