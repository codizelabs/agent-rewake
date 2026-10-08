import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * How the person runs Rewake, for every command Rewake tells them to run. Installing with
 * `npx @codizelabs/agent-rewake install` puts nothing on PATH, so "Run agent-rewake continue" would
 * end in "command not found": without `agent-rewake` on PATH the npx form is given instead.
 * Checked once per process, from the PATH it was started with (a hook gets the agent's).
 */
export const NPX_COMMAND = "npx @codizelabs/agent-rewake";

let chosen: string | undefined;

/** Whether `agent-rewake` is a command on this PATH. */
export function rewakeOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const path = env.PATH ?? env.Path ?? "";
  const names =
    platform === "win32"
      ? ["agent-rewake.cmd", "agent-rewake.exe", "agent-rewake.ps1"]
      : ["agent-rewake"];
  return path
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .some((dir) => names.some((n) => existsSync(join(dir, n))));
}

/** "agent-rewake" when it's on PATH, else the npx form. */
export function rewakeCommand(): string {
  chosen ??= rewakeOnPath() ? "agent-rewake" : NPX_COMMAND;
  return chosen;
}

/** A command to show the person: `rewake("continue --cancel")`. */
export function rewake(args: string): string {
  return `${rewakeCommand()} ${args}`;
}

/** Tests: fix the command name. */
export function setRewakeCommand(command: string | undefined): void {
  chosen = command;
}
