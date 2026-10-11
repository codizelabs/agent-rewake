/** Types for scripts/runtime-deps.mjs. */
export const ALLOWED_RUNTIME_DEPENDENCIES: readonly string[];
export function runtimeDependencyProblems(pkg: Record<string, unknown>): string[];
