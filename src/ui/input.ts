/**
 * Terminal input → events, for the schedules page. No dependencies.
 *
 * Mouse reports use the SGR encoding (`CSI < Cb ; Px ; Py M|m`, xterm ctlseqs "Extended
 * coordinates"): the low two bits of Cb are the button (3 = none), +32 marks motion, +64 marks the
 * wheel, and 4/8/16 are Shift/Meta/Control. Coordinates are 1-based.
 */

export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "enter"
  | "escape"
  | "backspace"
  | "delete"
  | "tab"
  | "char";

export type InputEvent =
  | { type: "key"; name: KeyName; ch?: string; ctrl?: boolean }
  | {
      type: "mouse";
      button: "left" | "middle" | "right" | "none" | "wheelup" | "wheeldown";
      /** 1-based column and row, as the terminal reports them. */
      x: number;
      y: number;
      /** Press (true) or release (false). */
      press: boolean;
      /** Movement, with or without a button held (any-event tracking). */
      motion: boolean;
    }
  | { type: "paste"; text: string }
  /** Answer to a cursor-position query (`CSI 6 n`), 1-based. */
  | { type: "cursor"; row: number; col: number };

const CSI_KEYS: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  "1~": "home",
  "7~": "home",
  "4~": "end",
  "8~": "end",
  "3~": "delete",
  "5~": "pageup",
  "6~": "pagedown",
  Z: "tab",
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Parse one chunk of input. Returns the events and any incomplete trailing sequence, which the
 * caller passes back in front of the next chunk.
 */
export function parseInput(data: string): { events: InputEvent[]; rest: string } {
  // A paste the terminal didn't mark (Windows' console doesn't send bracketed-paste markers): one
  // chunk with text after a line break can't be typing, so it's a paste, and its line breaks
  // mustn't press Enter.
  if (!data.includes("\x1b") && textAfterLineBreak(data)) {
    const text = data.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    return { events: [{ type: "paste", text }], rest: "" };
  }

  const events: InputEvent[] = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i] as string;
    if (data.startsWith(PASTE_START, i)) {
      const end = data.indexOf(PASTE_END, i + PASTE_START.length);
      if (end === -1) return { events, rest: data.slice(i) };
      events.push({ type: "paste", text: data.slice(i + PASTE_START.length, end) });
      i = end + PASTE_END.length;
      continue;
    }
    if (c === "\x1b") {
      if (i + 1 >= data.length) {
        events.push({ type: "key", name: "escape" });
        i++;
        continue;
      }
      const next = data[i + 1];
      if (next === "[" || next === "O") {
        // Matched after the ESC itself, so the patterns hold no control characters.
        const m = /^[[O](<?)([\d;]*)([A-Za-z~])/.exec(data.slice(i + 1));
        if (!m) {
          // An unfinished sequence at the end of the chunk waits for more input.
          if (/^[[O][<\d;]*$/.test(data.slice(i + 1))) return { events, rest: data.slice(i) };
          events.push({ type: "key", name: "escape" });
          i++;
          continue;
        }
        const [all, lt, params, final] = m as unknown as [string, string, string, string];
        i += 1 + all.length;
        if (lt === "<" && (final === "M" || final === "m")) {
          const [b = 0, x = 0, y = 0] = params.split(";").map(Number);
          const wheel = (b & 64) !== 0;
          const low = b & 3;
          events.push({
            type: "mouse",
            button: wheel
              ? low === 0
                ? "wheelup"
                : "wheeldown"
              : ((["left", "middle", "right", "none"] as const)[low] ?? "none"),
            x,
            y,
            press: final === "M",
            motion: (b & 32) !== 0,
          });
          continue;
        }
        if (final === "R" && lt === "") {
          const [row = 0, col = 0] = params.split(";").map(Number);
          events.push({ type: "cursor", row, col });
          continue;
        }
        const key = CSI_KEYS[final === "~" ? `${params.split(";")[0]}~` : final];
        if (key) events.push({ type: "key", name: key });
        continue;
      }
      // Alt+key arrives as ESC + key: treat it as the key.
      i++;
      continue;
    }
    i++;
    if (c === "\r" || c === "\n") events.push({ type: "key", name: "enter" });
    else if (c === "\x7f" || c === "\b") events.push({ type: "key", name: "backspace" });
    else if (c === "\t") events.push({ type: "key", name: "tab" });
    else if (c === "\x03") events.push({ type: "key", name: "char", ch: "c", ctrl: true });
    else if (c < " ") {
      // Other control characters: ignored.
    } else {
      // Keep surrogate pairs together.
      const code = c.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff && i < data.length) {
        events.push({ type: "key", name: "char", ch: c + data[i] });
        i++;
      } else events.push({ type: "key", name: "char", ch: c });
    }
  }
  return { events, rest: "" };
}

/** Whether printable text follows a line break in this chunk. */
function textAfterLineBreak(data: string): boolean {
  const br = data.search(/[\r\n]/);
  if (br === -1) return false;
  for (let i = br + 1; i < data.length; i++) if ((data.codePointAt(i) ?? 0) >= 0x20) return true;
  return false;
}
