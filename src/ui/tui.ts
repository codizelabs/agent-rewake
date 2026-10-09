import { rewake } from "../util/command.js";
import { parseInput } from "./input.js";
import { SchedulesPage } from "./page.js";

/**
 * `agent-rewake ui`: the schedules page. It runs either full screen in Zed's
 * terminal panel (a Zed task), or `--inline` inside a thread, where Rewake opens it in a terminal
 * Zed embeds in the thread. No dependencies.
 *
 * Terminal modes (xterm ctlseqs): 1049 alternate screen (full screen only), 1000/1002/1003 mouse
 * clicks, drags and hover, 1006 SGR coordinates, 2004 bracketed paste, 25 cursor visibility.
 * Every mode is switched off again on exit, including after an error.
 */

const ESC = "\x1b[";
const MOUSE_ON = `${ESC}?1000h${ESC}?1002h${ESC}?1003h${ESC}?1006h${ESC}?2004h`;
const MOUSE_OFF = `${ESC}?2004l${ESC}?1006l${ESC}?1003l${ESC}?1002l${ESC}?1000l`;
/** Height of the inline page: enough for a useful table without taking over the thread. */
const INLINE_HEIGHT = 22;

export interface TuiOptions {
  locale?: string;
  /** Draw in place below the cursor instead of switching to the alternate screen. */
  inline?: boolean;
  /** The thread this page was opened from. */
  threadId?: string;
  env?: NodeJS.ProcessEnv;
  /** Resumes of agents outside Zed (src/ui/page.ts PageOptions). */
  hostName?: (host: string) => string | undefined;
  hostNoun?: (host: string) => string | undefined;
  onHostChange?: (scheduleId: string) => void;
}

export async function runTui(stateDir: string, opts: TuiOptions = {}): Promise<number> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    process.stderr.write(
      `The schedules page needs an interactive terminal. For plain output, run "${rewake("schedules")}".\n`,
    );
    return 2;
  }
  const env = opts.env ?? process.env;
  const page = new SchedulesPage({
    stateDir,
    ...(opts.locale && { locale: opts.locale }),
    ...(opts.threadId && { threadId: opts.threadId }),
    noColor: Boolean(env.NO_COLOR) || env.TERM === "dumb",
    ...(opts.hostName && { hostName: opts.hostName }),
    ...(opts.hostNoun && { hostNoun: opts.hostNoun }),
    ...(opts.onHostChange && { onHostChange: opts.onHostChange }),
  });
  const inline = opts.inline === true;
  const height = () =>
    inline
      ? Math.min(INLINE_HEIGHT, Math.max(12, stdout.rows || INLINE_HEIGHT))
      : stdout.rows || 24;
  // Inline: the page's first line on screen (0-based), learnt from a cursor-position answer.
  let origin = 0;
  let drawnInline = false;

  const draw = () => {
    const frame = page.render(stdout.columns || 80, height());
    if (inline) {
      // Each line is rewritten in place, starting at the page's first line.
      stdout.write(`${ESC}${origin + 1};1H${frame.lines.map((l) => `${ESC}2K${l}`).join("\r\n")}`);
    } else stdout.write(`${ESC}H${frame.lines.map((l) => `${ESC}2K${l}`).join("\r\n")}`);
  };

  return new Promise((resolve) => {
    let rest = "";
    if (inline) {
      // Make room below the cursor, go back to its top, and ask where that is.
      stdout.write(`${"\r\n".repeat(height() - 1)}${ESC}${height() - 1}A\r${ESC}6n`);
    } else stdout.write(`${ESC}?1049h`);
    stdout.write(`${ESC}?25l${MOUSE_ON}`);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const finish = () => {
      clearInterval(timer);
      stdout.off("resize", draw);
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(MOUSE_OFF);
      if (inline) {
        // Leave a one-line summary in place of the page (it stays in the thread's tool card).
        const pending = page.store
          .list()
          .filter((s) => !["sent", "failed", "stopped", "cancelled"].includes(s.status)).length;
        stdout.write(`${ESC}${origin + 1};1H${ESC}J`);
        stdout.write(
          `Rewake: schedules page closed. ${pending} message${pending === 1 ? "" : "s"} scheduled. Open it again from the Rewake menu.\n`,
        );
      } else stdout.write(`${ESC}?1049l`);
      stdout.write(`${ESC}?25h`);
      resolve(0);
    };

    const onData = (chunk: string) => {
      const parsed = parseInput(rest + chunk);
      rest = parsed.rest;
      for (const e of parsed.events) {
        if (e.type === "cursor" && inline) {
          origin = e.row - 1;
          drawnInline = true;
          continue;
        }
        page.handle(e, inline ? origin : 0);
        if (page.done) return finish();
      }
      if (!inline || drawnInline) draw();
    };

    stdin.on("data", onData);
    stdout.on("resize", draw);
    // Pick up changes from threads and other windows (the owning Rewake process sends them).
    const timer = setInterval(() => {
      page.reload();
      if (!inline || drawnInline) draw();
    }, 2000);
    if (!inline) draw();
    else
      setTimeout(() => {
        // No answer to the position query: assume the page starts where the cursor was.
        if (!drawnInline) {
          origin = Math.max(0, (stdout.rows || height()) - height());
          drawnInline = true;
          draw();
        }
      }, 300).unref();
  });
}
