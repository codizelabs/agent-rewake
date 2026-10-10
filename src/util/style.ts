/**
 * The small palette every interactive Rewake screen uses, so they all look like the same
 * product: the schedules page (`src/ui/page.ts`), the install picker (`src/install/select.ts`)
 * and the install confirmation (`src/install.ts`). `NO_COLOR` (or `TERM=dumb`) turns colour into
 * bold, the same degrade `page.ts` applies; bold, dim and reverse stay, since they're not colour
 * and every terminal, including a screen reader, can still tell the difference.
 */
export type Tone = "plain" | "bold" | "dim" | "reverse" | "accent" | "warn";

const SGR: Record<Exclude<Tone, "plain">, string> = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reverse: "\x1b[7m",
  accent: "\x1b[36m",
  warn: "\x1b[33m",
};

export function paint(text: string, tone: Tone, noColor: boolean): string {
  if (tone === "plain" || text === "") return text;
  let t = tone;
  if (noColor && (t === "accent" || t === "warn")) t = "bold";
  return `${SGR[t]}${text}\x1b[0m`;
}

/** `NO_COLOR` or `TERM=dumb`: the convention every Rewake surface checks the same way. */
export function noColorFrom(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NO_COLOR) || env.TERM === "dumb";
}
