import { psString } from "../timers/notify.js";

/**
 * The command text of a hook that runs Rewake, for the shell the agent runs it through.
 *
 * - `sh`, bash and cmd.exe run `"<node>" "<launcher>" hook …` as a program and its arguments.
 *   Codex keys its hook trust on this text, so it never changes on macOS and Linux.
 * - PowerShell reads a line that starts with a quoted string as an expression and refuses the
 *   next string: a quoted program path needs the call operator, `& '…'`. "If you try to execute
 *   the quoted path, PowerShell displays the contents of the quoted string instead of running the
 *   script. The call operator allows you to execute the contents of the string containing the
 *   filename." (Microsoft, about_Operators, "Call operator &",
 *   learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_operators).
 * - Paths go in single quotes: "A string enclosed in single quotation marks is a verbatim string…
 *   No substitution is performed", and "To include a single quotation mark in a single-quoted
 *   string, use a second consecutive single quote" (about_Quoting_Rules, same site). `psString`
 *   doubles the typographic single quotes too, which PowerShell also reads as quotes.
 *
 * No single text works in both: `&` is a command separator in cmd.exe and an error at the start
 * of a line in bash. Each installer picks the shell its agent uses.
 */
export type HookShell = "posix" | "powershell";

export function hookCommand(
  node: string,
  launcher: string,
  args: string,
  shell: HookShell,
): string {
  return shell === "powershell"
    ? `& ${psString(node)} ${psString(launcher)} ${args}`
    : `"${node}" "${launcher}" ${args}`;
}
