import { expect, mock, test } from "claude-code/testing";

const T0 = Date.parse("2026-10-06T10:00:00Z");
const MIN = 60_000;
const H = 60 * MIN;
const CONTINUE =
  "[Sent automatically by Agent Rewake after the usage limit reset] Continue from where you left off.";

type Window = { kind: string; percentUsed: number; resetsAt?: string };
/** An event or call input in the test runtime (the generated mod types aren't in Rewake's repo). */
type Ev = Record<string, unknown>;
type Question = { question: string; options?: (string | { label: string })[] };
type On = (event: string, ...args: unknown[]) => unknown;
/** A limit record in $.store, as the mod writes it. */
type Episode = { state?: string; kind?: string; fireAt?: number };

/** Stubs every mods API call the mod makes; returns what the test checks. */
function harness(
  on: On,
  opts: {
    windows?: () => Window[];
    setting?: boolean;
    answer?: string;
    /** Answers in order, for questions asked one after another. */
    answers?: string[];
    store?: Record<string, unknown>;
    config?: string;
    settings?: string;
    /** Whether this machine has caffeinate (the mod asks once, through the shell). */
    caffeinate?: boolean;
  } = {},
) {
  const clock = mock.clock(on, { now: T0 });
  const seen = {
    submitted: [] as string[],
    filled: [] as string[],
    asked: 0,
    questions: [] as Question[],
    status: [] as (string | undefined)[],
    files: {} as Record<string, string>,
    store: { ...(opts.store ?? {}) } as Record<string, unknown>,
    spawned: [] as string[][],
    commands: [] as string[],
  };
  on("process.run", () => ({
    value:
      opts.caffeinate === false
        ? { exitCode: 1, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: "4242\n", stderr: "" },
  }));
  // The kit runs no processes: record the request, then refuse it (the mod drops the hold).
  on("process.spawn", async function* (_: unknown, e: Ev) {
    seen.spawned.push(e.argv as string[]);
    yield* [];
    return { deny: "no processes in tests" };
  });
  on("session.start", () => ({ cwd: "/work" }));
  on("command.register", (_: unknown, e: Ev) => {
    seen.commands.push(e.name as string);
    return { value: undefined };
  });
  on("session.id", () => ({ value: "S1" }));
  on("session.usage", () => ({
    value: {
      startedAt: T0,
      context: { tokens: 0, window: 200000, percent: 0 },
      rateLimits: opts.windows?.() ?? [],
    },
  }));
  on("settings.read", () => ({
    value: opts.setting === undefined ? {} : { autoContinueAtUsageLimit: opts.setting },
  }));
  on("store.get", (_: unknown, e: Ev) => ({ value: seen.store[e.key as string] }));
  on("store.set", (_: unknown, e: Ev) => {
    seen.store[e.key as string] = JSON.parse(JSON.stringify(e.value));
    return { value: undefined };
  });
  on("store.delete", (_: unknown, e: Ev) => {
    delete seen.store[e.key as string];
    return { value: undefined };
  });
  on("fs.read", (_: unknown, e: Ev) => {
    const path = e.path as string;
    if (opts.config && path.endsWith("/rewake.json")) return { value: opts.config };
    if (opts.settings && path.endsWith("/settings.json")) return { value: opts.settings };
    return { deny: "missing" };
  });
  on("fs.write", (_: unknown, e: Ev) => {
    seen.files[e.path as string] = e.text as string;
    return { value: undefined };
  });
  on("ui.status", (_: unknown, e: Ev) => {
    seen.status.push(e.text as string | undefined);
    return { value: undefined };
  });
  on("ui.toast", () => ({ value: undefined }));
  on("prompt.fill", (_: unknown, e: Ev) => {
    seen.filled.push(e.text as string);
    return { isFilled: true };
  });
  on("tool.call", (_: unknown, e: Ev) => {
    const q = (e.questions as Question[])[0] as Question;
    seen.asked++;
    seen.questions.push(q);
    const next = opts.answers?.shift();
    const given = next ?? opts.answer;
    if (given === undefined) return { deny: "dismissed" };
    const pick = (i: number) => {
      const o = q.options?.[i];
      return typeof o === "string" ? o : o?.label;
    };
    const answer = given === "FIRST" ? pick(0) : given === "SECOND" ? pick(1) : given;
    return { result: { answers: { [q.question]: answer } } };
  });
  on("prompt.submit", (_: unknown, e: Ev) => {
    seen.submitted.push(e.text as string);
    return { text: e.text };
  });
  on("classic.StopFailure", () => ({}));
  on("classic.Notification", () => ({}));
  on("classic.SessionStart", () => ({}));
  return { clock, seen };
}

const limit = (agent_id?: string) =>
  ({
    session_id: "S1",
    transcript_path: "/t",
    cwd: "/work",
    hook_event_name: "StopFailure",
    error: "rate_limit",
    last_assistant_message: "You've hit your session limit",
    ...(agent_id && { agent_id }),
  }) as never;

const fiveHour = (resetsAt: string, percentUsed = 100): Window[] => [
  { kind: "five_hour", percentUsed, resetsAt },
];

test("asks once, then continues the same session once, a minute after the reset", async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    setting: false,
    answer: "FIRST",
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect(seen.asked).toBe(1);
  expect((seen.store["limit:S1"] as Episode).state).toBe("armed");
  await clock.advance(60 * MIN);
  expect(seen.submitted.length).toBe(0);
  await clock.advance(2 * MIN);
  expect(seen.submitted).toEqual([CONTINUE]);
  await clock.advance(30 * MIN);
  expect(seen.submitted.length).toBe(1);
});

test("stands down when Claude Code will continue by itself, and clears on quota_auto_resume_fired", async ($, on) => {
  const { clock, seen } = harness(on, { windows: () => fiveHour("2026-10-06T11:00:00Z") });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect(seen.asked).toBe(0);
  expect((seen.store["limit:S1"] as Episode).state).toBe("native");
  await $.classic.Notification({
    session_id: "S1",
    transcript_path: "/t",
    cwd: "/work",
    hook_event_name: "Notification",
    message: "continued",
    notification_type: "quota_auto_resume_fired",
  } as never);
  await clock.advance(1);
  expect(seen.store["limit:S1"]).toBeUndefined();
  await clock.advance(3 * H);
  expect(seen.submitted.length).toBe(0);
});

test("the weekly limit is past the native 24-hour horizon, so Rewake asks", async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => [{ kind: "seven_day", percentUsed: 100, resetsAt: "2026-10-09T09:00:00Z" }],
    answer: "SECOND",
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect(seen.asked).toBe(1);
  expect(seen.store.prefs).toEqual({ autoContinue: "always" });
  expect((seen.store["limit:S1"] as Episode).kind).toBe("seven_day");
});

test('"always" still asks about a reset more than a day away', async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => [{ kind: "seven_day", percentUsed: 100, resetsAt: "2026-10-09T09:00:00Z" }],
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "desktop", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect(seen.asked).toBe(1);
  expect((seen.store["limit:S1"] as Episode).state).toBe("offered");
});

test('"always" arms without asking when the reset is within a day', async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    setting: false,
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect(seen.asked).toBe(0);
  expect((seen.store["limit:S1"] as Episode).state).toBe("armed");
});

test("a monthly spending cap is billing: never waited for", async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => [{ kind: "spend_limit", percentUsed: 100, resetsAt: "2026-10-31T00:00:00Z" }],
    setting: false,
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect(seen.asked).toBe(0);
  expect((seen.store["limit:S1"] as Episode).state).toBe("waiting");
  await clock.advance(2 * H);
  expect(seen.submitted.length).toBe(0);
});

test("a spending cap that resets within a day (a gateway's daily cap) is waited for", async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => [{ kind: "spend_limit", percentUsed: 100, resetsAt: "2026-10-06T11:00:00Z" }],
    setting: false,
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect((seen.store["limit:S1"] as Episode).state).toBe("armed");
});

test("on the Desktop app Rewake asks even when the reset is within a day", async ($, on) => {
  const { clock, seen } = harness(on, { windows: () => fiveHour("2026-10-06T11:00:00Z") });
  await $.session.start({ surface: "desktop", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect(seen.asked).toBe(1);
  // Dismissed: offered, nothing sent at the reset.
  expect((seen.store["limit:S1"] as Episode).state).toBe("offered");
  await clock.advance(2 * H);
  expect(seen.submitted.length).toBe(0);
});

test("shows times in the clock the person chose in Rewake", async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    setting: false,
    config: JSON.stringify({ stateDir: "/state" }),
    settings: JSON.stringify({ clock: "24h" }),
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  const label = seen.questions[0].options[0];
  expect(typeof label === "string" ? label : label.label).toMatch(
    /^Continue at \d{2}:\d{2} today$/,
  );
});

test("the person typing cancels the armed continue", async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    setting: false,
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect((seen.store["limit:S1"] as Episode).state).toBe("armed");
  await $.prompt.submit({ text: "never mind", wait: false, origin: { kind: "composer" } } as never);
  await clock.advance(1);
  expect(seen.store["limit:S1"]).toBeUndefined();
  seen.submitted.length = 0;
  await clock.advance(2 * H);
  expect(seen.submitted.length).toBe(0);
});

test("still limited at the reset (a weekly limit behind the 5-hour one): waits for the later window", async ($, on) => {
  let windows = fiveHour("2026-10-06T11:00:00Z");
  const { clock, seen } = harness(on, {
    windows: () => windows,
    setting: false,
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  windows = [{ kind: "seven_day", percentUsed: 100, resetsAt: "2026-10-06T15:00:00Z" }];
  await clock.advance(62 * MIN);
  expect(seen.submitted.length).toBe(0);
  expect((seen.store["limit:S1"] as Episode).fireAt).toBe(Date.parse("2026-10-06T15:01:00Z"));
  windows = [];
  await clock.set(Date.parse("2026-10-06T15:01:30Z"));
  expect(seen.submitted.length).toBe(1);
});

test("subagent failures are ignored", async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    setting: false,
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit("agent-7"));
  await clock.advance(1);
  expect(seen.store["limit:S1"]).toBeUndefined();
});

test("reopened after the reset: the continue is put in the prompt, not sent", async ($, on) => {
  const armed = {
    state: "armed",
    resetAt: T0 - 2 * H,
    fireAt: T0 - 2 * H + MIN,
    createdAt: T0 - 5 * H,
    rehits: 0,
    attempts: 0,
  };
  const { clock, seen } = harness(on, { store: { "limit:S1": armed } });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await clock.advance(1);
  expect(seen.filled).toEqual([CONTINUE]);
  expect(seen.submitted.length).toBe(0);
});

test("reopened before the reset: re-armed from the store", async ($, on) => {
  const armed = {
    state: "armed",
    resetAt: T0 + H,
    fireAt: T0 + H + MIN,
    createdAt: T0 - H,
    rehits: 0,
    attempts: 0,
  };
  const { clock, seen } = harness(on, { store: { "limit:S1": armed } });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await clock.advance(H + 2 * MIN);
  expect(seen.submitted.length).toBe(1);
});

test("/rewake in 30m schedules a message; a leading slash is refused", async ($, on) => {
  const { clock, seen } = harness(on);
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  const ok = await $.command.run({ command: "rewake", args: "in 30m run the tests" } as never);
  expect(ok.text).toMatch(/^Scheduled for /);
  const bad = await $.command.run({ command: "rewake", args: "in 5m /compact" } as never);
  expect(bad.text).toBe('A scheduled message cannot start with "/".');
  await clock.advance(31 * MIN);
  expect(seen.submitted).toEqual(["run the tests"]);
});

test("a copy of the record, without text, goes to the shared state folder", async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    setting: false,
    store: { prefs: { autoContinue: "always" } },
    config: JSON.stringify({ stateDir: "/state" }),
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  const copy = JSON.parse(seen.files["/state/hosts/claude-code/sessions/S1.json"] ?? "{}");
  expect(copy).toMatchObject({
    schemaVersion: 1,
    host: "claude-code",
    sessionId: "S1",
    state: "armed",
    kind: "five_hour",
  });
  expect(JSON.stringify(copy)).not.toContain("Continue from");
});

test("Claude Code's own auto-continuation (origin auto-continuation) settles the episode", async ($, on) => {
  const { clock, seen } = harness(on, {
    setting: false,
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect((seen.store["limit:S1"] as Episode).state).toBe("armed");
  await $.prompt.submit({
    text: "continue",
    wait: false,
    origin: { kind: "auto-continuation" },
  } as never);
  await clock.advance(1);
  expect(seen.store["limit:S1"]).toBeUndefined();
});

test("an Agent SDK or -p session (not interactive) is left alone", async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: null, isInteractive: false, cwd: "/work" } as never);
  await $.classic.StopFailure(limit());
  await clock.advance(2 * H);
  expect(seen.store["limit:S1"]).toBeUndefined();
  expect(seen.submitted.length).toBe(0);
});

test("/rewake cancel cancels only the continue; scheduled messages stay", async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    setting: false,
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.command.run({ command: "rewake", args: "in 3h run the tests" } as never);
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  const r = await $.command.run({ command: "rewake-cancel", args: "" } as never);
  expect(r.text).toMatch(
    /^Cancelled the automatic continue at .+\. Your scheduled messages stay\.$/,
  );
  expect(seen.store["limit:S1"]).toBeUndefined();
  expect((seen.store["sched:S1"] as unknown[]).length).toBe(1);
});

test("/rewake clear asks before deleting scheduled messages", async ($, on) => {
  const { seen } = harness(on, { answer: "Keep it" });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.command.run({ command: "rewake", args: "at 6pm stretch" } as never);
  const kept = await $.command.run({ command: "rewake", args: "clear" } as never);
  expect(kept.text).toBe("Kept your scheduled message.");
  expect(seen.questions.at(-1)?.question).toBe("Delete the scheduled message in this session?");
  expect((seen.store["sched:S1"] as unknown[]).length).toBe(1);
});

test("still limited after the last re-check: offered for the later reset, not dropped", async ($, on) => {
  const windows = [{ kind: "seven_day", percentUsed: 100, resetsAt: "2026-10-06T15:00:00Z" }];
  const armed = {
    state: "armed",
    resetAt: T0 + MIN,
    fireAt: T0 + 2 * MIN,
    createdAt: T0,
    rehits: 0,
    attempts: 4,
  };
  const { clock, seen } = harness(on, { windows: () => windows, store: { "limit:S1": armed } });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await clock.advance(3 * MIN);
  expect((seen.store["limit:S1"] as Episode).state).toBe("offered");
  expect((seen.store["limit:S1"] as Episode).fireAt).toBe(Date.parse("2026-10-06T15:01:00Z"));
  expect(seen.status.at(-1)).toMatch(
    /^Usage limit reached · \/rewake-continue to continue after the reset (at|on) /,
  );
  expect(seen.submitted.length).toBe(0);
});

test('"/rewake ask" turns "always" off, and the list says how', async ($, on) => {
  const { seen } = harness(on, { store: { prefs: { autoContinue: "always" } } });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  const list = await $.command.run({ command: "rewake", args: "" } as never);
  expect(list.text).toContain("To be asked each time: /rewake-ask");
  const r = await $.command.run({ command: "rewake", args: "ask" } as never);
  expect(r.text).toBe("Rewake will ask before continuing after a usage limit.");
  expect(seen.store.prefs).toEqual({});
});

test("/rewake-schedule asks when (presets with their times), then what", async ($, on) => {
  const { clock, seen } = harness(on, { answers: ["FIRST", "run the tests"] });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  const r = await $.command.run({ command: "rewake-schedule", args: "" } as never);
  expect(r.text).toMatch(/^Scheduled for /);
  expect(seen.questions[0]?.options?.length).toBe(4);
  const first = seen.questions[0]?.options?.[0];
  expect(typeof first === "string" ? first : first?.label).toMatch(/^In 30 minutes \(/);
  expect(seen.questions[1]?.question).toMatch(
    /^What should Rewake send into this session (at|on) /,
  );
  await clock.advance(31 * MIN);
  expect(seen.submitted).toEqual(["run the tests"]);
});

test("/rewake-schedule changes nothing when dismissed", async ($, on) => {
  const { seen } = harness(on);
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  const r = await $.command.run({ command: "rewake-schedule", args: "" } as never);
  expect(r.text).toBe("Nothing was scheduled.");
  expect(seen.store["sched:S1"]).toBeUndefined();
});

test("keeps the Mac awake, tied to Claude Code, while a continue is due within a few hours", async ($, on) => {
  const { clock, seen } = harness(on, {
    setting: false,
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect((seen.store["limit:S1"] as Episode).state).toBe("armed");
  expect(seen.spawned[0]).toEqual(["/usr/bin/caffeinate", "-s", "-w", "4242"]);
});

test("doesn't keep the Mac awake where it can't", async ($, on) => {
  const { clock, seen } = harness(on, {
    setting: false,
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    store: { prefs: { autoContinue: "always" } },
    caffeinate: false,
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect((seen.store["limit:S1"] as Episode).state).toBe("armed");
  expect(seen.spawned).toEqual([]);
});

test("follows Rewake's setting: never means no hold", async ($, on) => {
  const { clock, seen } = harness(on, {
    setting: false,
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    store: { prefs: { autoContinue: "always" } },
    config: JSON.stringify({ stateDir: "/state" }),
    settings: JSON.stringify({ keepAwake: "never" }),
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect((seen.store["limit:S1"] as Episode).state).toBe("armed");
  expect(seen.spawned).toEqual([]);
});

test('the Desktop app asks even with "always" (its own checkbox would continue too)', async ($, on) => {
  const { clock, seen } = harness(on, {
    windows: () => fiveHour("2026-10-06T11:00:00Z"),
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "desktop", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect(seen.asked).toBe(1);
});

test("a later window more than a day away is offered, not waited for silently", async ($, on) => {
  let windows = fiveHour("2026-10-06T11:00:00Z");
  const { clock, seen } = harness(on, {
    windows: () => windows,
    setting: false,
    store: { prefs: { autoContinue: "always" } },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  windows = [{ kind: "seven_day", percentUsed: 100, resetsAt: "2026-10-09T09:00:00Z" }];
  await clock.advance(62 * MIN);
  expect(seen.submitted.length).toBe(0);
  expect((seen.store["limit:S1"] as Episode).state).toBe("offered");
});

test("a limit that never gets a reset time stops holding up scheduled messages", async ($, on) => {
  const { clock, seen } = harness(on, { windows: () => [] });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await $.command.run({ command: "rewake", args: "in 30m run the tests" } as never);
  await $.classic.StopFailure(limit());
  await clock.advance(1);
  expect((seen.store["limit:S1"] as Episode).state).toBe("waiting");
  await clock.advance(31 * MIN);
  expect(seen.store["limit:S1"]).toBeUndefined();
  expect(seen.submitted).toEqual(["run the tests"]);
});

test("registers every command it answers", async ($, on) => {
  const { seen } = harness(on);
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  expect(seen.commands.sort()).toEqual(
    [
      "rewake",
      "rewake-ask",
      "rewake-cancel",
      "rewake-clear",
      "rewake-continue",
      "rewake-schedule",
    ].sort(),
  );
});

test("reopened while Claude Code's own wait was pending: Rewake asks instead", async ($, on) => {
  const { clock, seen } = harness(on, {
    store: {
      "limit:S1": {
        state: "native",
        createdAt: T0 - 10 * MIN,
        rehits: 0,
        attempts: 0,
        kind: "five_hour",
        resetAt: T0 + H,
        fireAt: T0 + H + MIN,
      },
    },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await clock.advance(1);
  expect(seen.asked).toBe(1);
});

/** An armed continue due two minutes in, as another Claude Code process with the session sees it too. */
const armedNow = (claim?: { by: string; at: number }) => ({
  state: "armed",
  resetAt: T0 + MIN,
  fireAt: T0 + 2 * MIN,
  createdAt: T0 - H,
  rehits: 0,
  attempts: 0,
  ...(claim && { claim }),
});

test("another process with the same session open claims the continue first: this one sends nothing", async ($, on) => {
  let other = false;
  const h = harness(on, {
    windows: () => {
      // While this process checks usage, the other one claims the send.
      const ep = h.seen.store["limit:S1"] as Record<string, unknown> | undefined;
      if (ep?.state === "armed" && !other) {
        h.seen.store["limit:S1"] = { ...ep, claim: { by: "other", at: T0 + 2 * MIN } };
        other = true;
      }
      return [];
    },
    store: { "limit:S1": armedNow() },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await h.clock.advance(3 * MIN);
  expect(other).toBe(true);
  expect(h.seen.submitted.length).toBe(0);
  await h.clock.advance(3 * MIN);
  expect(h.seen.submitted.length).toBe(0);
});

test("a claim left by a process that stopped mid-send doesn't hold the continue up", async ($, on) => {
  const { clock, seen } = harness(on, {
    store: { "limit:S1": armedNow({ by: "gone", at: T0 - 10 * MIN }) },
  });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await clock.advance(3 * MIN);
  expect(seen.submitted).toEqual([CONTINUE]);
});
