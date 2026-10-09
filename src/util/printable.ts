/**
 * Text that came from outside Rewake (an agent's thread title, a message, a folder name), made safe
 * to print in a terminal. Control characters (ESC, which starts every terminal command such as a
 * clipboard write or a hyperlink; the C1 controls; DEL) and the characters that reorder text (bidi
 * overrides) become "�"; tabs, line and paragraph separators become a space. Applied when showing
 * text, never when storing it.
 */
const code = (n: number) => String.fromCharCode(n);
const range = (a: number, b: number) => `${code(a)}-${code(b)}`;

const BREAKS = new RegExp(
  `[${code(9)}${code(10)}${code(11)}${code(12)}${code(13)}${code(0x85)}${code(0x2028)}${code(0x2029)}]`,
  "g",
);
const CONTROLS = new RegExp(
  `[${range(0, 8)}${range(14, 31)}${code(127)}-${code(0x9f)}${code(0x61c)}${code(0x200e)}${code(0x200f)}${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}]`,
  "g",
);

export function printable(text: string): string {
  return text.replace(BREAKS, " ").replace(CONTROLS, "�");
}
