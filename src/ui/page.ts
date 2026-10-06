import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeCron, nextRun, nextRuns, parseCron } from "../core/cron.js";
import { applySettings } from "../core/settings.js";
import { type Schedule, ScheduleStore, TERMINAL_STATUSES } from "../core/store.js";
import { type ThreadSettings, ThreadStore } from "../core/threads.js";
import { formatClock, formatWhen, parseWhen } from "../core/time.js";
import { ensurePrivateDir } from "../util/paths.js";
import { REPO_URL } from "../version.js";
import type { InputEvent } from "./input.js";
import { oneLine, STATUS_WORDS } from "./overview.js";

/**
 * The schedules page: a table of every scheduled message with clickable rows,
 * buttons for every action, hover hints that name the matching `/schedule` command, a tip line,
 * a help screen and dialogs. Pure: it draws frames from the shared store and reacts to input
 * events; `tui.ts` connects it to a terminal. Keyboard and mouse can do everything.
 */

export type Filter = "thread" | "all" | "finished";

type Style = "plain" | "bold" | "dim" | "reverse" | "accent" | "warn" | "underline";

interface Segment {
  text: string;
  style?: Style;
  /** Clickable area id; the hint is shown while the pointer is over it. */
  hit?: string;
  hint?: string | undefined;
}

/** A clickable area of the last frame (0-based line, columns [x0, x1)). */
export interface Hit {
  id: string;
  line: number;
  x0: number;
  x1: number;
  hint?: string;
}

export interface Frame {
  lines: string[];
  hits: Hit[];
}

interface Row {
  schedule: Schedule;
  thread: ThreadSettings | undefined;
  /** Position among that thread's pending messages, as `/schedule list` numbers them. */
  n: number;
}

type Dialog =
  | { kind: "help" }
  | {
      kind: "confirm";
      title: string;
      body: string[];
      yes: string;
      onYes: () => void;
    }
  | {
      kind: "input";
      title: string;
      help: string;
      value: string;
      cursor: number;
      presets: Array<{ label: string; value: string }>;
      error?: string | undefined;
      /** Live feedback under the field, e.g. what a cron expression means. */
      preview?: ((value: string) => string) | undefined;
      onSubmit: (value: string) => string | undefined;
    }
  | {
      kind: "pick";
      title: string;
      threads: ThreadSettings[];
      index: number;
      onPick: (t: ThreadSettings) => void;
    };

export const TIPS = [
  "In any thread, the Rewake menu under the message box does everything this page does.",
  "Type /schedule in a thread to open the scheduling form, or /schedule 09:00 Run the tests to skip it.",
  "When Claude hits its usage limit, Rewake asks in the thread whether to resume after the reset.",
  "Hold Shift while dragging to select text on this page.",
  "Messages are sent while Zed is open with that thread's project. Missed ones wait for you here.",
  "agent-rewake schedules prints this list as plain text, which works well with screen readers.",
];

const TIME_PRESETS = [
  { label: "In 30 min", value: "in 30m" },
  { label: "In 1 hour", value: "in 1h" },
  { label: "In 3 hours", value: "in 3h" },
  { label: "Tomorrow 09:00", value: "tomorrow 09:00" },
];

const BUTTONS: Array<{ id: string; key: string; label: string; hint: string }> = [
  {
    id: "new",
    key: "n",
    label: "New",
    hint: "New: schedule a message in a thread. In a thread, the Rewake menu or /schedule does the same.",
  },
  {
    id: "edit",
    key: "e",
    label: "Edit",
    hint: "Edit: change the message text. In its thread: /schedule edit {n} <text>",
  },
  {
    id: "time",
    key: "t",
    label: "Time",
    hint: "Time: pick a new time. In its thread: /schedule move {n} <when>",
  },
  {
    id: "now",
    key: "s",
    label: "Send now",
    hint: "Send now: sends it within a few seconds if its thread is open in Zed. In its thread: /schedule now {n}",
  },
  {
    id: "pause",
    key: "p",
    label: "Pause",
    hint: "Pause: keep it, but don't send it until you resume it. In its thread: /schedule pause {n}",
  },
  {
    id: "delete",
    key: "d",
    label: "Delete",
    hint: "Delete: remove it (asks first). In its thread: /schedule rm {n}",
  },
  {
    id: "auto",
    key: "a",
    label: "Auto-resume",
    hint: "Auto-resume: resume this message's thread automatically after every usage limit (Claude). In a thread: /schedule auto on",
  },
  {
    id: "help",
    key: "?",
    label: "Help",
    hint: "Help: what Rewake does, how to schedule, every key and command.",
  },
  {
    id: "quit",
    key: "q",
    label: "Close",
    hint: "Close this page. Your scheduled messages keep going.",
  },
];

const TABS: Array<{ id: Filter; label: string; hint: string }> = [
  { id: "thread", label: "This thread", hint: "Only the thread you opened this page from." },
  { id: "all", label: "All threads", hint: "Every pending message, in every thread and agent." },
  {
    id: "finished",
    label: "Finished",
    hint: "Also show sent, failed, stopped and cancelled messages.",
  },
];

export interface PageOptions {
  stateDir: string;
  now?: () => number;
  locale?: string;
  /** Opened from a thread: that thread is the default filter and the default for New. */
  threadId?: string;
  /** Plain output: no colour (NO_COLOR). Bold, dim and reverse still mark state. */
  noColor?: boolean;
}

export class SchedulesPage {
  readonly store: ScheduleStore;
  readonly threads: ThreadStore;
  filter: Filter;
  rows: Row[] = [];
  selected = 0;
  scroll = 0;
  hovered: string | undefined;
  toast: string | undefined;
  dialog: Dialog | undefined;
  showTips: boolean;
  tip: string;
  done = false;
  private lastHits: Hit[] = [];
  private lastClick = { id: "", at: 0 };
  private readonly now: () => number;

  constructor(private readonly opts: PageOptions) {
    this.store = new ScheduleStore(opts.stateDir);
    this.threads = new ThreadStore(opts.stateDir);
    this.now = opts.now ?? Date.now;
    this.filter = opts.threadId ? "thread" : "all";
    const prefs = this.prefs();
    this.showTips = prefs.hideTips !== true;
    const seen = typeof prefs.tipIndex === "number" ? prefs.tipIndex : -1;
    const index = (seen + 1) % TIPS.length;
    this.tip = TIPS[index] ?? "";
    this.savePrefs({ ...prefs, tipIndex: index });
    this.reload();
  }

  // ---- data ------------------------------------------------------------------------------------

  reload(): void {
    applySettings(this.opts.stateDir);
    const all = this.store.list();
    const pendingByThread = new Map<string, Schedule[]>();
    for (const s of all) {
      if (TERMINAL_STATUSES.has(s.status)) continue;
      const list = pendingByThread.get(s.sessionId) ?? [];
      list.push(s);
      pendingByThread.set(s.sessionId, list);
    }
    const keep = (s: Schedule) =>
      (this.filter === "finished" || !TERMINAL_STATUSES.has(s.status)) &&
      (this.filter !== "thread" || s.sessionId === this.opts.threadId);
    const selectedId = this.current()?.schedule.scheduleId;
    this.rows = all.filter(keep).map((s) => ({
      schedule: s,
      thread: this.threads.get(s.sessionId),
      n: (pendingByThread.get(s.sessionId) ?? []).indexOf(s) + 1,
    }));
    const again = this.rows.findIndex((r) => r.schedule.scheduleId === selectedId);
    this.selected = Math.max(
      0,
      Math.min(again === -1 ? this.selected : again, this.rows.length - 1),
    );
  }

  current(): Row | undefined {
    return this.rows[this.selected];
  }

  private prefsFile(): string {
    return join(this.opts.stateDir, "ui.json");
  }

  private prefs(): { hideTips?: boolean; tipIndex?: number } {
    try {
      return JSON.parse(readFileSync(this.prefsFile(), "utf8"));
    } catch {
      return {};
    }
  }

  private savePrefs(p: { hideTips?: boolean; tipIndex?: number }): void {
    try {
      ensurePrivateDir(this.opts.stateDir);
      writeFileSync(this.prefsFile(), `${JSON.stringify(p)}\n`, { mode: 0o600 });
    } catch {
      // Preferences are a convenience; the page works without them.
    }
  }

  // ---- input -----------------------------------------------------------------------------------

  handle(e: InputEvent, originLine = 0): void {
    if (e.type === "cursor") return;
    if (e.type === "paste") {
      if (this.dialog?.kind === "input") this.insert(e.text.replace(/[\r\n]+/g, " "));
      return;
    }
    if (e.type === "mouse") {
      this.mouse(e, originLine);
      return;
    }
    if (e.ctrl && e.ch === "c") {
      this.done = true;
      return;
    }
    if (this.dialog) {
      this.dialogKey(e);
      return;
    }
    this.toast = undefined;
    switch (e.name) {
      case "up":
        this.select(this.selected - 1);
        return;
      case "down":
        this.select(this.selected + 1);
        return;
      case "pageup":
        this.select(this.selected - 10);
        return;
      case "pagedown":
        this.select(this.selected + 10);
        return;
      case "home":
        this.select(0);
        return;
      case "end":
        this.select(this.rows.length - 1);
        return;
      case "tab":
        this.setFilter(this.nextFilter());
        return;
      case "escape":
        this.done = true;
        return;
      case "enter":
        this.action("time");
        return;
      case "char": {
        const ch = e.ch ?? "";
        if (ch === "j") {
          this.select(this.selected + 1);
          return;
        }
        if (ch === "k") {
          this.select(this.selected - 1);
          return;
        }
        if (ch === "x") {
          this.toggleTips();
          return;
        }
        if (ch === "f") {
          this.setFilter(this.filter === "finished" ? "all" : "finished");
          return;
        }
        const button = BUTTONS.find((b) => b.key === ch.toLowerCase());
        if (button) this.action(button.id);
      }
    }
  }

  private mouse(e: Extract<InputEvent, { type: "mouse" }>, originLine: number): void {
    const line = e.y - 1 - originLine;
    const col = e.x - 1;
    const hit = this.lastHits.find((h) => h.line === line && col >= h.x0 && col < h.x1);
    if (e.motion && e.button === "none") {
      this.hovered = hit?.id;
      return;
    }
    if (e.button === "wheelup" || e.button === "wheeldown") {
      if (!this.dialog) this.select(this.selected + (e.button === "wheelup" ? -1 : 1));
      else if (this.dialog.kind === "pick")
        this.dialog.index = clamp(
          this.dialog.index + (e.button === "wheelup" ? -1 : 1),
          0,
          this.dialog.threads.length - 1,
        );
      return;
    }
    if (e.button !== "left" || !e.press || e.motion || !hit) return;
    const now = this.now();
    const double = this.lastClick.id === hit.id && now - this.lastClick.at < 400;
    this.lastClick = { id: hit.id, at: now };
    this.click(hit.id, double);
  }

  /** A click on a hit area. Ids: `row:N`, `btn:ID`, `tab:F`, `tips`, `dlg:…`, `pick:N`, `preset:N`. */
  click(id: string, double = false): void {
    const [kind, arg = ""] = id.split(":");
    if (this.dialog) {
      if (kind === "dlg") {
        this.dialogButton(arg);
        return;
      }
      if (kind === "preset" && this.dialog.kind === "input") {
        const preset = this.dialog.presets[Number(arg)];
        if (preset) this.submitInput(preset.value);
        return;
      }
      if (kind === "pick" && this.dialog.kind === "pick") {
        const t = this.dialog.threads[Number(arg)];
        if (!t) return;
        if (this.dialog.index === Number(arg) || double) {
          const pick = this.dialog.onPick;
          this.dialog = undefined;
          pick(t);
        } else this.dialog.index = Number(arg);
      }
      if (this.dialog?.kind === "help") this.dialog = undefined;
      return;
    }
    this.toast = undefined;
    if (kind === "row") {
      this.select(Number(arg));
      if (double) this.action("time");
    } else if (kind === "btn") this.action(arg);
    else if (kind === "tab") this.setFilter(arg as Filter);
    else if (kind === "tips") this.toggleTips();
  }

  private select(i: number): void {
    this.selected = clamp(i, 0, Math.max(0, this.rows.length - 1));
  }

  private nextFilter(): Filter {
    const order: Filter[] = this.opts.threadId
      ? ["thread", "all", "finished"]
      : ["all", "finished"];
    return order[(order.indexOf(this.filter) + 1) % order.length] ?? "all";
  }

  setFilter(f: Filter): void {
    if (f === "thread" && !this.opts.threadId) return;
    this.filter = f;
    this.reload();
  }

  private toggleTips(): void {
    this.showTips = !this.showTips;
    this.savePrefs({ ...this.prefs(), hideTips: !this.showTips });
    this.toast = this.showTips ? "Tips are on." : "Tips are off. Press x to show them again.";
  }

  // ---- actions ---------------------------------------------------------------------------------

  action(id: string): void {
    const row = this.current();
    const s = row?.schedule;
    const now = this.now();
    const needsRow = ["edit", "time", "now", "pause", "delete", "auto"].includes(id);
    if (needsRow && !s) {
      this.toast = "Nothing selected. Press n to schedule a message.";
      return;
    }
    switch (id) {
      case "new":
        this.startNew();
        return;
      case "help":
        this.dialog = { kind: "help" };
        return;
      case "quit":
        this.done = true;
        return;
    }
    if (!s || !row) return;
    if (TERMINAL_STATUSES.has(s.status) && id !== "delete" && id !== "auto") {
      this.toast = `This message is ${STATUS_WORDS[s.status].toLowerCase()}. Press n to schedule a new one.`;
      return;
    }
    switch (id) {
      case "edit":
        this.dialog = this.inputDialog(
          "Change the message",
          "The text the agent will get. Enter saves, Esc cancels.",
          s.text,
          [],
          (text) => {
            if (!text.trim()) return "Type the message, or press Esc to keep it as it is.";
            this.store.update(s.scheduleId, (x) => ({ ...x, text: text.trim() }), this.now());
            this.toast = "Saved the new text.";
            return undefined;
          },
        );
        return;
      case "time":
        this.dialog = this.timeDialog(
          `New time for: "${oneLine(s.text, 40)}"`,
          (at, cron, custom) => {
            // A preset moves only the next run; a typed expression also replaces the repeat.
            this.store.update(
              s.scheduleId,
              (x) => {
                if (!custom) return { ...x, dueAt: at, status: "scheduled" };
                const { repeat: _old, ...rest } = x;
                return {
                  ...rest,
                  dueAt: at,
                  status: "scheduled",
                  ...(cron && { repeat: { cron } }),
                };
              },
              this.now(),
            );
            this.toast = `Moved to ${formatWhen(at, this.now(), this.opts.locale)}.`;
          },
        );
        return;
      case "now":
        if (s.status === "sending") {
          this.toast = "It's being sent right now.";
          return;
        }
        this.store.update(s.scheduleId, (x) => ({ ...x, status: "scheduled", dueAt: now }), now);
        this.toast = "Sending within a few seconds, if its thread is open in Zed.";
        break;
      case "pause":
        if (s.status === "paused") {
          this.store.update(
            s.scheduleId,
            (x) => ({ ...x, status: "scheduled", ...(x.dueAt < now && { dueAt: now }) }),
            now,
          );
          this.toast = "Resumed. It will be sent at its time.";
        } else if (s.status === "sending") {
          this.toast = "It's being sent right now, so it can't be paused.";
        } else {
          this.store.update(s.scheduleId, (x) => ({ ...x, status: "paused" }), now);
          this.toast = "Paused. Press p again to resume it.";
        }
        break;
      case "delete":
        this.dialog = {
          kind: "confirm",
          title: "Delete this scheduled message?",
          body: [
            `"${oneLine(s.text, 60)}"`,
            `${formatWhen(s.dueAt, now, this.opts.locale)} · ${threadLabel(row.thread, s)}`,
          ],
          yes: "Delete",
          onYes: () => {
            this.store.remove(s.scheduleId);
            this.toast = "Deleted.";
          },
        };
        return;
      case "auto": {
        const on = row.thread?.autoResume === true;
        const flip = () => {
          this.threads.update(s.sessionId, s.cwd, { autoResume: !on }, this.now());
          this.toast = `Automatic resume is ${on ? "off" : "on"} for "${threadLabel(row.thread, s)}".`;
        };
        if (on) flip();
        else
          this.dialog = {
            kind: "confirm",
            title: "Resume this thread automatically after usage limits?",
            body: [
              "Rewake sends the thread's resume message when the limit resets,",
              "follows the new reset time if still limited, says so in the thread, and never",
              "approves permission requests. Works with Claude.",
            ],
            yes: "Turn on",
            onYes: flip,
          };
        return;
      }
    }
    this.reload();
  }

  private startNew(): void {
    const known = this.threads.list();
    const create = (t: ThreadSettings) => {
      this.dialog = this.inputDialog(
        `New message for "${threadLabel(t)}"`,
        "What should the agent get? Enter continues, Esc cancels.",
        "",
        [],
        (text) => {
          if (!text.trim()) return "Type the message first.";
          // Replacing the dialog here keeps it open (submitInput only closes the one it ran).
          this.dialog = this.timeDialog("When should it be sent?", (first, cron) => {
            this.store.create({
              sessionId: t.sessionId,
              cwd: t.cwd,
              text: text.trim(),
              dueAt: first,
              createdBy: "tui",
              now: this.now(),
              ...(cron && { repeat: { cron } }),
            });
            const parsed = cron ? parseCron(cron) : undefined;
            this.toast = `Scheduled for ${formatWhen(first, this.now(), this.opts.locale)}.${parsed?.ok ? ` Repeats: ${describeCron(parsed.cron)}.` : ""} It's sent while that thread is open in Zed.`;
          });
          return undefined;
        },
      );
    };
    const here = this.opts.threadId
      ? (this.threads.get(this.opts.threadId) ??
        known.find((t) => t.sessionId === this.opts.threadId))
      : undefined;
    if (here) {
      create(here);
      return;
    }
    if (known.length === 0) {
      this.toast =
        "Open a thread in Zed with an agent that has Rewake first, then schedule from here or with /schedule.";
      return;
    }
    this.dialog = {
      kind: "pick",
      title: "Which thread?",
      threads: known,
      index: 0,
      onPick: create,
    };
  }

  private inputDialog(
    title: string,
    help: string,
    value: string,
    presets: Array<{ label: string; value: string }>,
    onSubmit: (value: string) => string | undefined,
    preview?: (value: string) => string,
  ): Dialog {
    return { kind: "input", title, help, value, cursor: value.length, presets, onSubmit, preview };
  }

  /**
   * "When?": click a preset, or type a cron expression and see what it means as
   * you type. A typed expression then asks "Every time it matches" or "Only once".
   */
  private timeDialog(
    title: string,
    onTime: (first: number, cron?: string, custom?: true) => void,
  ): Dialog {
    const now = this.now();
    return this.inputDialog(
      title,
      "Click a choice, or type a cron expression (minute hour day month weekday) and press Enter.",
      "",
      TIME_PRESETS.map((p) => ({
        label: `${p.label} (${this.preview(p.value)})`,
        value: p.value,
      })),
      (value) => {
        const v = value.trim();
        const preset = TIME_PRESETS.find((p) => p.value === v);
        if (preset) {
          const r = parseWhen(preset.value, this.now());
          if (!r.ok) return r.error;
          onTime(r.at);
          return undefined;
        }
        if (!v) return "Click a choice, or type a cron expression such as 30 14 * * *.";
        const parsed = parseCron(v);
        if (!parsed.ok) return parsed.error;
        const first = nextRun(parsed.cron, this.now());
        if (first === undefined) return `"${v}" never runs.`;
        // Replacing the dialog keeps it open: then ask how often.
        this.dialog = this.howDialog(parsed.cron.source, first, onTime);
        return undefined;
      },
      (value) => {
        const v = value.trim();
        if (!v)
          return 'For example "30 14 * * *" is 14:30, "0 9 * * 1-5" is every weekday at 09:00.';
        const parsed = parseCron(v);
        if (!parsed.ok) return parsed.error;
        const runs = nextRuns(parsed.cron, now, 3).map((t) => formatWhen(t, now, this.opts.locale));
        return `Means: ${describeCron(parsed.cron)}. Next: ${runs.join("; ")}`;
      },
    );
  }

  /** After a typed cron expression: every time it matches, or only its next run. */
  private howDialog(
    cron: string,
    first: number,
    onTime: (first: number, cron?: string, custom?: true) => void,
  ): Dialog {
    const parsed = parseCron(cron);
    const means = parsed.ok ? describeCron(parsed.cron) : cron;
    return this.inputDialog(
      `"${cron}": ${means}`,
      "How often should it be sent?",
      "",
      [
        { label: "Every time it matches", value: "repeat" },
        { label: `Only once (${formatWhen(first, this.now(), this.opts.locale)})`, value: "once" },
      ],
      (value) => {
        if (value.trim() === "once") onTime(first, undefined, true);
        else onTime(first, cron, true);
        return undefined;
      },
    );
  }

  private preview(when: string): string {
    const r = parseWhen(when, this.now());
    if (!r.ok) return when;
    return formatClock(r.at);
  }

  private dialogKey(e: Extract<InputEvent, { type: "key" }>): void {
    const d = this.dialog;
    if (!d) return;
    if (d.kind === "help") {
      this.dialog = undefined;
      return;
    }
    if (e.name === "escape") {
      this.dialog = undefined;
      return;
    }
    if (d.kind === "confirm") {
      if (e.name === "enter" || e.ch === "y") this.dialogButton("yes");
      else if (e.ch === "n") this.dialog = undefined;
      return;
    }
    if (d.kind === "pick") {
      if (e.name === "up" || e.ch === "k") d.index = clamp(d.index - 1, 0, d.threads.length - 1);
      else if (e.name === "down" || e.ch === "j")
        d.index = clamp(d.index + 1, 0, d.threads.length - 1);
      else if (e.name === "enter") this.dialogButton("ok");
      return;
    }
    switch (e.name) {
      case "enter":
        this.submitInput(d.value);
        return;
      case "backspace":
        if (d.cursor > 0) {
          d.value = d.value.slice(0, d.cursor - 1) + d.value.slice(d.cursor);
          d.cursor--;
        }
        return;
      case "delete":
        d.value = d.value.slice(0, d.cursor) + d.value.slice(d.cursor + 1);
        return;
      case "left":
        d.cursor = Math.max(0, d.cursor - 1);
        return;
      case "right":
        d.cursor = Math.min(d.value.length, d.cursor + 1);
        return;
      case "home":
        d.cursor = 0;
        return;
      case "end":
        d.cursor = d.value.length;
        return;
      case "char":
        if (e.ch) this.insert(e.ch);
        return;
    }
  }

  private insert(text: string): void {
    const d = this.dialog;
    if (d?.kind !== "input") return;
    d.value = d.value.slice(0, d.cursor) + text + d.value.slice(d.cursor);
    d.cursor += text.length;
    d.error = undefined;
  }

  private submitInput(value: string): void {
    const d = this.dialog;
    if (d?.kind !== "input") return;
    const error = d.onSubmit(value);
    if (error) {
      d.error = error;
      d.value = value;
      d.cursor = value.length;
      return;
    }
    if (this.dialog === d) this.dialog = undefined;
    this.reload();
  }

  private dialogButton(which: string): void {
    const d = this.dialog;
    if (!d) return;
    if (which === "cancel") {
      this.dialog = undefined;
      return;
    }
    if (d.kind === "confirm" && which === "yes") {
      this.dialog = undefined;
      d.onYes();
      this.reload();
    } else if (d.kind === "input" && which === "ok") this.submitInput(d.value);
    else if (d.kind === "pick" && which === "ok") {
      const t = d.threads[d.index];
      this.dialog = undefined;
      if (t) d.onPick(t);
    } else if (d.kind === "help") this.dialog = undefined;
  }

  // ---- drawing ---------------------------------------------------------------------------------

  /** Draw a frame of exactly `height` lines, each at most `width` columns. */
  render(width: number, height: number): Frame {
    const w = Math.max(30, width);
    const h = Math.max(10, height);
    const out: Segment[][] = [];
    const now = this.now();

    // Title and tabs.
    const tabs: Segment[] = [];
    for (const t of TABS) {
      if (t.id === "thread" && !this.opts.threadId) continue;
      tabs.push({ text: " " });
      tabs.push({
        text: ` ${t.label} `,
        style:
          this.filter === t.id ? "reverse" : this.hovered === `tab:${t.id}` ? "underline" : "dim",
        hit: `tab:${t.id}`,
        hint: t.hint,
      });
    }
    out.push([{ text: " Rewake · Scheduled messages", style: "bold" }, { text: "   " }, ...tabs]);
    out.push([{ text: "─".repeat(w), style: "dim" }]);

    // Table.
    const cols = columns(w);
    const header: Segment[] = [{ text: "  " }];
    for (const c of cols) header.push({ text: pad(c.title, c.width), style: "bold" });
    out.push(header);
    const row = this.current();
    const buttonLines = wrapSegments(this.buttons(row), w);
    // Footer: a rule, the buttons, the hint line and (optionally) the tip line.
    const footer = 1 + buttonLines.length + 1 + (this.showTips ? 1 : 0);
    const area = Math.max(1, h - out.length - footer);
    if (this.rows.length === 0) {
      out.push(...this.emptyState(w).slice(0, area));
    } else {
      if (this.selected < this.scroll) this.scroll = this.selected;
      if (this.selected >= this.scroll + area) this.scroll = this.selected - area + 1;
      this.scroll = clamp(this.scroll, 0, Math.max(0, this.rows.length - area));
      for (let i = this.scroll; i < Math.min(this.rows.length, this.scroll + area); i++) {
        const r = this.rows[i] as Row;
        const sel = i === this.selected;
        const cells = cols.map((c) => pad(c.value(r, now, this.opts.locale), c.width)).join("");
        const attention = ["missed", "needs_attention", "failed"].includes(r.schedule.status);
        out.push([
          {
            text: `${sel ? "›" : " "} ${cells}`,
            style: sel
              ? "reverse"
              : attention
                ? "warn"
                : this.hovered === `row:${i}`
                  ? "underline"
                  : "plain",
            hit: `row:${i}`,
            hint: `${oneLine(r.schedule.text, 200)} · ${threadLabel(r.thread, r.schedule)}${r.thread?.cwd ? ` · ${r.thread.cwd}` : ""}`,
          },
        ]);
      }
    }
    while (out.length < h - footer) out.push([]);
    out.push([{ text: "─".repeat(w), style: "dim" }]);
    out.push(...buttonLines);

    // Hint line: the hovered element, else the last message, else the selected row.
    const hoverHint = this.findHint(this.hovered, out);
    const hint =
      this.toast ??
      hoverHint ??
      (row
        ? `${oneLine(row.schedule.text, 200)} · ${threadLabel(row.thread, row.schedule)}`
        : "Press n or click New to schedule a message.");
    out.push([{ text: ` ${hint}`, style: this.toast ? "bold" : "dim" }]);
    if (this.showTips)
      out.push([
        { text: ` Tip: ${this.tip} `, style: "dim" },
        {
          text: "[x] hide tips",
          style: "dim",
          hit: "tips",
          hint: "Hide tips. Press x again to bring them back.",
        },
      ]);

    const frameRows = out.slice(0, h);
    while (frameRows.length < h) frameRows.push([]);
    const base = serialize(frameRows, w, this.opts.noColor === true);
    if (!this.dialog) {
      this.lastHits = base.hits;
      return base;
    }
    const overlay = this.renderDialog(w, h);
    const lines = base.lines.slice();
    const hits: Hit[] = [];
    for (const [i, l] of overlay.lines.entries()) lines[overlay.top + i] = l;
    for (const hit of overlay.hits) hits.push({ ...hit, line: hit.line + overlay.top });
    this.lastHits = hits;
    return { lines, hits };
  }

  private buttons(row: Row | undefined): Segment[] {
    const buttons: Segment[] = [{ text: " " }];
    for (const b of BUTTONS) {
      const label =
        b.id === "pause" && row?.schedule.status === "paused"
          ? "Resume"
          : b.id === "auto"
            ? `Auto-resume: ${row?.thread?.autoResume ? "on" : "off"}`
            : b.label;
      const disabled = !row && !["new", "help", "quit"].includes(b.id);
      buttons.push({
        text: `[${b.key}] ${label}`,
        style: disabled ? "dim" : this.hovered === `btn:${b.id}` ? "reverse" : "accent",
        hit: `btn:${b.id}`,
        hint: b.hint.replace("{n}", row ? String(row.n || "N") : "N"),
      });
      buttons.push({ text: "  " });
    }
    return buttons;
  }

  private findHint(id: string | undefined, rows: Segment[][]): string | undefined {
    if (!id) return undefined;
    for (const r of rows) for (const s of r) if (s.hit === id && s.hint) return s.hint;
    return undefined;
  }

  private emptyState(w: number): Segment[][] {
    const lines: Segment[][] = [[]];
    const say = (text: string, style: Style = "plain") =>
      lines.push([{ text: `   ${text}`.slice(0, w), style }]);
    say(
      this.filter === "thread"
        ? "Nothing is scheduled in this thread yet."
        : "Nothing is scheduled yet.",
      "bold",
    );
    say("");
    say("Schedule a message in any of these ways:");
    lines.push([
      { text: "   • Here: " },
      { text: "[n] New", style: "accent", hit: "btn:new", hint: BUTTONS[0]?.hint },
    ]);
    say("• In a thread: the Rewake menu under the message box → Schedule a message…");
    say("• In a thread: type /schedule 09:00 Run the tests");
    say("");
    say(
      "When Claude hits its usage limit, Rewake asks in the thread whether to resume later.",
      "dim",
    );
    if (this.filter === "thread")
      lines.push([
        { text: "   " },
        { text: "[ Show all threads ]", style: "accent", hit: "tab:all", hint: TABS[1]?.hint },
      ]);
    return lines;
  }

  private renderDialog(w: number, h: number): { top: number; lines: string[]; hits: Hit[] } {
    const d = this.dialog as Dialog;
    const inner = Math.min(w - 4, 76);
    const body: Segment[][] = [];
    const text = (t: string, style: Style = "plain") => body.push([{ text: t, style }]);
    let title = "";
    switch (d.kind) {
      case "help": {
        title = "Help · Agent Rewake";
        for (const l of HELP)
          text(l.startsWith("#") ? l.slice(1).trim() : l, l.startsWith("#") ? "bold" : "plain");
        body.push([]);
        body.push([{ text: "[ Close ]", style: "accent", hit: "dlg:cancel", hint: "Close help" }]);
        break;
      }
      case "confirm": {
        title = d.title;
        for (const l of d.body) text(l);
        body.push([]);
        body.push([
          { text: `[y] ${d.yes}`, style: "accent", hit: "dlg:yes" },
          { text: "   " },
          { text: "[n] Cancel", style: "accent", hit: "dlg:cancel" },
        ]);
        break;
      }
      case "input": {
        title = d.title;
        text(d.help, "dim");
        body.push([]);
        const shown = d.value.slice(Math.max(0, d.cursor - (inner - 4)));
        const at = Math.min(d.cursor, inner - 4);
        body.push([
          { text: "› " },
          { text: shown.slice(0, at) },
          { text: shown[at] ?? " ", style: "reverse" },
          { text: shown.slice(at + 1) },
        ]);
        if (d.error) text(d.error, "warn");
        else if (d.preview) text(d.preview(d.value), "dim");
        if (d.presets.length > 0) {
          body.push([]);
          const chips: Segment[] = [];
          for (const [i, p] of d.presets.entries()) {
            chips.push({
              text: `[ ${p.label} ]`,
              style: "accent",
              hit: `preset:${i}`,
              hint: p.value,
            });
            chips.push({ text: " " });
          }
          body.push(...wrapSegments(chips, inner));
        }
        body.push([]);
        body.push([
          { text: "[Enter] OK", style: "accent", hit: "dlg:ok" },
          { text: "   " },
          { text: "[Esc] Cancel", style: "accent", hit: "dlg:cancel" },
        ]);
        break;
      }
      case "pick": {
        title = d.title;
        text(
          "The message goes to the thread you pick. Threads appear here once opened in Zed.",
          "dim",
        );
        body.push([]);
        const visible = Math.max(3, h - 12);
        const start = clamp(
          d.index - Math.floor(visible / 2),
          0,
          Math.max(0, d.threads.length - visible),
        );
        for (let i = start; i < Math.min(d.threads.length, start + visible); i++) {
          const t = d.threads[i] as ThreadSettings;
          body.push([
            {
              text: `${i === d.index ? "›" : " "} ${threadLabel(t)}${t.cwd ? `  ·  ${t.cwd}` : ""}`,
              style: i === d.index ? "reverse" : "plain",
              hit: `pick:${i}`,
            },
          ]);
        }
        body.push([]);
        body.push([
          { text: "[Enter] Choose", style: "accent", hit: "dlg:ok" },
          { text: "   " },
          { text: "[Esc] Cancel", style: "accent", hit: "dlg:cancel" },
        ]);
        break;
      }
    }
    const boxW = inner + 4;
    const left = Math.max(0, Math.floor((w - boxW) / 2));
    const rows: Segment[][] = [];
    const wrapped = body.flatMap((r) => wrapSegments(r, inner));
    const maxBody = Math.max(1, h - 4);
    const shown = wrapped.slice(0, maxBody);
    rows.push([
      { text: " ".repeat(left) },
      { text: `${`┌─ ${title} `.padEnd(boxW - 1, "─").slice(0, boxW - 1)}┐` },
    ]);
    for (const r of shown) {
      const len = r.reduce((n, s) => n + s.text.length, 0);
      rows.push([
        { text: " ".repeat(left) },
        { text: "│ " },
        ...r,
        { text: " ".repeat(Math.max(0, inner - len)) },
        { text: " │" },
      ]);
    }
    rows.push([{ text: " ".repeat(left) }, { text: `└${"─".repeat(boxW - 2)}┘` }]);
    const top = Math.max(0, Math.floor((h - rows.length) / 2));
    const f = serialize(rows, w, this.opts.noColor === true);
    return { top, lines: f.lines, hits: f.hits };
  }
}

const HELP = [
  "# What this is",
  "Agent Rewake sends messages to your agent threads at the times you choose,",
  "and can resume a thread after Claude's usage limit resets.",
  "",
  "# Schedule a message",
  "Here: [n] New, pick the thread, type the message, pick a time.",
  "In a thread: the Rewake menu under the message box, or /schedule.",
  "",
  "# Change one",
  "Click a row (or use ↑ ↓), then a button below. Double-click a row to change its time.",
  "",
  "# Keys",
  "n new · e edit · t time · s send now · p pause/resume · d delete",
  "a auto-resume · Tab switch view · f finished · x tips · ? help · q close",
  "",
  "# The same in a thread",
  "/schedule 09:00 Run the tests · /schedule list · /schedule move 1 18:30",
  "/schedule edit 1 <text> · /schedule now 1 · /schedule rm 1 · /stop",
  "",
  "# Good to know",
  "Messages are sent while Zed is open with that thread's project.",
  "Hold Shift while dragging to select text. Plain list: agent-rewake schedules",
  "",
  `Open source: ${REPO_URL} (a star there helps others find it)`,
];

function threadLabel(t: ThreadSettings | undefined, s?: Schedule): string {
  const title = t?.title ?? (s ? `Thread ${s.sessionId.slice(0, 8)}` : "Thread");
  const agent = t?.agentName ?? t?.agentId;
  return agent ? `${agent} · ${title}` : title;
}

interface Column {
  title: string;
  width: number;
  value: (r: Row, now: number, locale?: string) => string;
}

/** Columns that fit the width; Thread and Agent go first when it's narrow. */
function columns(w: number): Column[] {
  const when: Column = {
    title: "When",
    width: 25,
    value: (r, now, locale) => formatWhen(r.schedule.dueAt, now, locale),
  };
  const repeats: Column = {
    title: "Repeats",
    width: 18,
    value: (r) => {
      const p = r.schedule.repeat ? parseCron(r.schedule.repeat.cron) : undefined;
      return p?.ok ? describeCron(p.cron) : "—";
    },
  };
  const status: Column = {
    title: "Status",
    width: 12,
    value: (r) => `${STATUS_WORDS[r.schedule.status]}${r.schedule.kind === "user" ? "" : "*"}`,
  };
  const agent: Column = {
    title: "Agent",
    width: 14,
    value: (r) => r.thread?.agentName ?? r.thread?.agentId ?? "—",
  };
  const thread: Column = {
    title: "Thread",
    width: 22,
    value: (r) => r.thread?.title ?? `Thread ${r.schedule.sessionId.slice(0, 8)}`,
  };
  const showRepeats = w >= 110;
  const fixed = [
    when,
    ...(w >= 90 ? [agent] : []),
    ...(w >= 70 ? [thread] : []),
    ...(showRepeats ? [repeats] : []),
    status,
  ];
  const used = fixed.reduce((n, c) => n + c.width, 0) + 2;
  const message: Column = {
    title: "Message",
    width: Math.max(10, w - used),
    value: (r) => oneLine(r.schedule.text, 500),
  };
  return [
    when,
    ...(w >= 90 ? [agent] : []),
    ...(w >= 70 ? [thread] : []),
    message,
    ...(showRepeats ? [repeats] : []),
    status,
  ];
}

function pad(text: string, width: number): string {
  const t = text.length > width - 1 ? `${text.slice(0, Math.max(0, width - 2))}…` : text;
  return t.padEnd(width);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Break a row of segments into lines no wider than `width`, keeping segments whole when possible. */
function wrapSegments(segments: Segment[], width: number): Segment[][] {
  const lines: Segment[][] = [[]];
  let used = 0;
  for (const s of segments) {
    if (used + s.text.length > width && used > 0 && s.text.trim()) {
      lines.push([]);
      used = 0;
    }
    if (used === 0 && !s.text.trim()) continue;
    (lines.at(-1) as Segment[]).push(s);
    used += s.text.length;
  }
  return lines;
}

const SGR: Record<Style, string> = {
  plain: "",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reverse: "\x1b[7m",
  underline: "\x1b[4m",
  accent: "\x1b[36m",
  warn: "\x1b[33m",
};

/** Turn segment rows into terminal lines (clipped to the width) and hit areas. */
function serialize(rows: Segment[][], width: number, noColor: boolean): Frame {
  const lines: string[] = [];
  const hits: Hit[] = [];
  for (const [line, row] of rows.entries()) {
    let x = 0;
    let out = "";
    for (const s of row) {
      if (x >= width) break;
      const text = s.text.slice(0, width - x);
      let style = s.style ?? "plain";
      // NO_COLOR: colours become bold (accent) or plain; reverse and dim still mark state.
      if (noColor && style === "accent") style = "bold";
      if (noColor && style === "warn") style = "bold";
      out += style === "plain" ? text : `${SGR[style]}${text}\x1b[0m`;
      if (s.hit)
        hits.push({ id: s.hit, line, x0: x, x1: x + text.length, ...(s.hint && { hint: s.hint }) });
      x += text.length;
    }
    lines.push(out);
  }
  return { lines, hits };
}
