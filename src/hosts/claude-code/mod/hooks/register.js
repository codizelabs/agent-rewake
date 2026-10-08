// Agent Rewake's mod for Claude Code. When a usage limit stops this session it asks once, then
// continues the same session after the reset; it also sends messages scheduled with /rewake,
// Rewake's one command (the same in every place Rewake runs; see logic.js parseCommand).
//
// Everything runs inside this Claude Code process: nothing runs once it exits. A pending continue
// is kept in $.store and offered again when the session is reopened.
//
// $.store keys ($.store is one file shared by every Claude Code process, so two with the same
// session open both see its record; only the claim decides which one sends):
//   prefs         { autoContinue?: 'always' }
//   limit:<id>    { state, kind?, resetAt?, fireAt?, createdAt, sentAt?, rehits, attempts, claim? }
//                 state: waiting (no reset time yet) | native (Claude Code's own wait) |
//                        offered (not answered) | armed | sent
//                 claim: { by, at }, the process sending the armed continue right now
//   sched:<id>    [{ at, text }]
// A copy of each limit record (no message text) goes to Rewake's shared state folder, so
// `agent-rewake doctor` and the schedules page can show it. Installed by `agent-rewake install`,
// which writes that folder's path into rewake.json beside this plugin.

import {
  AFTER_RESET_MS,
  blockedUntil,
  blockingKind,
  CONTINUE_TEXT,
  expired,
  FAR_RESET_MS,
  FEATURES,
  featureOf,
  HOUR,
  helpText,
  MAX_REARMS,
  MAX_REHITS,
  MINUTE,
  mustAsk,
  nativeLikely,
  notHere,
  parseCommand,
  parseWhen,
  personAtPrompt,
  REHIT_WINDOW_MS,
  STALE_MS,
  safeId,
  splitWhen,
  surfaceOf,
  WAITING_EXPIRES_MS,
  WAKE_HORIZON_MS,
  when,
} from "./logic.js";

const TICK_MS = 60_000;
/** Prompt origins that mean the person (or Claude Code's own auto-continue) moved on. */
const MOVED_ON = new Set(["composer", "bridge", "sdk", "auto-continuation"]);
const NEVER = "Don't continue";
const QUESTION =
  "Continue this session automatically when your usage limit resets? Keep Claude Code open until then; if it's closed, a continue message will be waiting in the prompt for you to send.";

let isInteractive = false;
let surface = null;
/**
 * Claude Code's own "Continue automatically at usage limit" as this session started with it: the
 * running Claude Code keeps that value, so a change in the settings file mid-session doesn't count.
 */
let nativeSetting;
/** How long after the reset Claude Code's own continue may take before Rewake steps in. */
const NATIVE_GRACE_MS = 2 * 60_000;
/** How Claude Code was started (`CLAUDE_CODE_ENTRYPOINT`): "cli", "claude-vscode", "sdk-ts"… */
let entrypoint;
/** Sessions whose limit is being handled right now (a burst of StopFailures is one limit). */
const handling = new Set();
let busy = false;
/** The person's clock in Rewake's settings: "12h" (default) or "24h". */
let clock = "12h";
/** The armed continue's timer in this process: { id, timer }. */
let armed;
/** `<stateDir>/hosts/claude-code/sessions`, when the installer said where the state folder is. */
let mirrorDir;
/** This process, in a send's claim: two Claude Code processes can have one session open. */
const ME = Math.random().toString(36).slice(2);
/** A claim older than this was left by a process that stopped mid-send. */
const CLAIM_MS = 5 * MINUTE;
/** Rewake's keep-awake setting: "plugged-in" (default), "always" or "never". */
let keepAwake = "plugged-in";
/** Claude Code's PID when this Mac has caffeinate; null where Rewake can't keep it awake. */
let wakePid;
/** The running hold: { mode, stream }. */
let wakeHold;

const limitKey = (id) => `limit:${id}`;
const schedKey = (id) => `sched:${id}`;
const at = (ms, now) => when(ms, now, clock);
/** "at 3:05 PM today" or "on Saturday at 3:05 PM". */
const atWhen = (ms, now) => {
  const t = at(ms, now);
  return /^\d/.test(t) ? `at ${t}` : `on ${t}`;
};

async function loadConfig($) {
  try {
    const cfg = JSON.parse(await $.fs.read(`${$.plugin.root}/rewake.json`));
    if (typeof cfg.stateDir !== "string" || cfg.stateDir === "") return;
    mirrorDir = `${cfg.stateDir}/hosts/claude-code/sessions`;
    try {
      const settings = JSON.parse(await $.fs.read(`${cfg.stateDir}/settings.json`));
      if (settings.clock === "24h" || settings.clock === "12h") clock = settings.clock;
      if (["plugged-in", "always", "never"].includes(settings.keepAwake))
        keepAwake = settings.keepAwake;
    } catch {
      // No settings saved yet: the default clock.
    }
  } catch {
    // Installed without Rewake's CLI (for example from a marketplace): no shared copy.
  }
}

/** Write the record's metadata (never text) where Rewake's CLI reads it. Best effort. */
async function mirror($, id, ep) {
  if (!mirrorDir || !safeId(id)) return;
  const { state, kind, resetAt, fireAt, createdAt, sentAt, rehits, attempts } = ep ?? {
    state: "none",
  };
  const record = {
    schemaVersion: 1,
    host: "claude-code",
    sessionId: id,
    state,
    kind,
    resetAt,
    fireAt,
    createdAt,
    sentAt,
    rehits,
    attempts,
    updatedAt: await $.clock.now(),
  };
  try {
    await $.fs.write(`${mirrorDir}/${id}.json`, `${JSON.stringify(record)}\n`);
  } catch {
    // A read-only or missing folder must not stop the mod.
  }
}

async function save($, id, ep) {
  await $.store.set(limitKey(id), ep);
  await mirror($, id, ep);
}

async function drop($, id) {
  disarm(id);
  await $.store.delete(limitKey(id));
  await mirror($, id, undefined);
}

function disarm(id) {
  if (armed && (id === undefined || armed.id === id)) {
    armed.timer.cancel();
    armed = undefined;
  }
}

/** One timer for the armed continue, at its fireAt. The 60 s ticker catches up after a sleep. */
async function arm($, id, ep) {
  disarm();
  const now = await $.clock.now();
  armed = { id, timer: $.clock.after(Math.max(0, ep.fireAt - now), () => void fire($, id)) };
}

/**
 * Keep this Mac from idling to sleep while a continue is due within a few hours: Rewake's own, or
 * Claude Code's (its wait holds nothing while the session sits idle). `caffeinate -w` ties the hold
 * to Claude Code, so it ends with it even after a crash. Returns whether a hold is running.
 */
async function updateWake($, ep, now) {
  const due = ep?.state === "armed" ? ep.fireAt : ep?.state === "native" ? ep.resetAt : undefined;
  const want =
    keepAwake !== "never" &&
    due !== undefined &&
    due > now - STALE_MS &&
    due - now <= WAKE_HORIZON_MS;
  const mode = keepAwake === "always" ? "-i" : "-s";
  if (wakeHold && (!want || wakeHold.mode !== mode)) {
    void wakeHold.stream.return?.();
    wakeHold = undefined;
  }
  if (!want || wakeHold) return wakeHold !== undefined;
  if (wakePid === undefined) {
    try {
      // The shell's parent is Claude Code; no caffeinate (Linux, Windows) means no hold here.
      const r = await $.process.run(["/bin/sh", "-c", "test -x /usr/bin/caffeinate && echo $PPID"]);
      wakePid = r.exitCode === 0 && /^\d+$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
    } catch {
      wakePid = null;
    }
  }
  if (wakePid === null) return false;
  const stream = $.process.spawn({ argv: ["/usr/bin/caffeinate", mode, "-w", wakePid] });
  const hold = { mode, stream };
  wakeHold = hold;
  void (async () => {
    try {
      for await (const _ of stream) {
        // caffeinate writes nothing; the loop is the hold's life.
      }
    } catch {
      // It couldn't start: no hold.
    }
    if (wakeHold === hold) wakeHold = undefined;
  })();
  return true;
}

async function refreshStatus($, id, now) {
  const ep = await $.store.get(limitKey(id));
  const sched = (await $.store.get(schedKey(id))) ?? [];
  const awake = (await updateWake($, ep, now)) ? " · keeping this Mac awake" : "";
  if (ep?.state === "armed" && ep.fireAt !== undefined) {
    $.ui.status(`Continues at ${at(ep.fireAt, now)}${awake} · /rewake cancel`);
  } else if (ep?.state === "offered") {
    $.ui.status(
      `Usage limit reached · /rewake to continue after the reset${ep.fireAt !== undefined ? ` ${atWhen(ep.fireAt, now)}` : ""}`,
    );
  } else if (sched.length > 0) {
    const next = Math.min(...sched.map((s) => s.at));
    $.ui.status(`${sched.length} scheduled · next at ${at(next, now)} · /rewake list`);
  } else {
    $.ui.status(undefined);
  }
}

/** A limit whose reset time is known: leave it to Claude Code, or ask. */
async function classify($, id, ep, now) {
  const autoContinueAtUsageLimit =
    nativeSetting === undefined
      ? (await $.settings.read()).autoContinueAtUsageLimit
      : nativeSetting.value;
  if (
    nativeLikely({
      isInteractive,
      surface,
      setting: autoContinueAtUsageLimit,
      resetAt: ep.resetAt,
      now,
    })
  ) {
    // Claude Code waits and continues by itself; a quota_auto_resume_* notification says how it went.
    await save($, id, { ...ep, state: "native" });
    return;
  }
  await ask($, id, ep, now);
}

async function ask($, id, ep, now) {
  const prefs = (await $.store.get("prefs")) ?? {};
  let state = "armed";
  // A reset more than a day away is always asked about, even with "always".
  if (mustAsk({ autoContinue: prefs.autoContinue, fireAt: ep.fireAt, now, surface })) {
    const yes = `Continue at ${at(ep.fireAt, now)}`;
    const always = `${yes}, and from now on in every session when the reset is within a day`;
    try {
      const answer = await $.ui.ask(QUESTION, {
        options: [yes, always, NEVER],
        header: "Rewake",
      });
      if (answer === always) await $.store.set("prefs", { ...prefs, autoContinue: "always" });
      else if (answer !== yes) state = "declined";
    } catch {
      // Dismissed, or nobody to ask (-p, an SDK host): leave it offered, for /rewake.
      state = "offered";
    }
  }
  if (state === "declined") {
    await drop($, id);
  } else {
    await save($, id, { ...ep, state });
    if (state === "armed") await arm($, id, ep);
  }
  await refreshStatus($, id, await $.clock.now());
}

async function onLimit($, id) {
  // -p runs and other Agent SDK hosts (Zed's Claude adapter among them) have no person at the
  // prompt, and Rewake's ACP add-on already resumes Zed's threads. Claude Code's own editor
  // panels also run through the Agent SDK, but a person is there: they count.
  if (!personAtPrompt({ isInteractive, entrypoint })) return;
  // StopFailure comes in bursts: a second one while the first is still being handled is the same.
  if (handling.has(id)) return;
  handling.add(id);
  try {
    await onLimitOnce($, id);
  } finally {
    handling.delete(id);
  }
}

async function onLimitOnce($, id) {
  const now = await $.clock.now();
  let prev = await $.store.get(limitKey(id));
  if (expired(prev, now)) {
    await drop($, id);
    prev = undefined;
  }
  // StopFailure comes in bursts: one episode at a time.
  if (prev && prev.state !== "sent") return;
  const rehits =
    prev?.state === "sent" && now - prev.sentAt < REHIT_WINDOW_MS ? prev.rehits + 1 : 0;
  const { rateLimits } = await $.session.usage();
  const resetAt = blockedUntil(rateLimits, now);
  if (rehits >= MAX_REHITS) {
    // The limit keeps coming back right after continuing: offer it, don't continue on its own.
    if (resetAt === undefined) return drop($, id);
    await save($, id, {
      state: "offered",
      createdAt: now,
      rehits,
      attempts: 0,
      kind: blockingKind(rateLimits, now),
      resetAt,
      fireAt: resetAt + AFTER_RESET_MS,
    });
    await refreshStatus($, id, now);
    return;
  }
  const ep = { state: "waiting", createdAt: now, rehits, attempts: 0 };
  if (resetAt === undefined) {
    // No reset time yet, or a limit that a wait doesn't fix (credits, a spending cap, an API
    // key's 429): wait for session.measure, then forget it.
    await save($, id, ep);
    return;
  }
  await classify(
    $,
    id,
    { ...ep, kind: blockingKind(rateLimits, now), resetAt, fireAt: resetAt + AFTER_RESET_MS },
    now,
  );
}

async function onMeasure($, rateLimits) {
  const id = await $.session.id();
  const ep = await $.store.get(limitKey(id));
  if (ep?.state !== "waiting") return;
  const now = await $.clock.now();
  if (now - ep.createdAt > WAITING_EXPIRES_MS) return drop($, id);
  const resetAt = blockedUntil(rateLimits, now);
  if (resetAt === undefined) return;
  await classify(
    $,
    id,
    { ...ep, kind: blockingKind(rateLimits, now), resetAt, fireAt: resetAt + AFTER_RESET_MS },
    now,
  );
}

async function onNotification($, e) {
  const id = e.session_id;
  const ep = await $.store.get(limitKey(id));
  if (!ep) return;
  if (
    e.notification_type === "quota_auto_resume_fired" ||
    e.notification_type === "quota_auto_resume_stale"
  ) {
    // Claude Code continued, or waits for Enter after a sleep: nothing for Rewake to do.
    await drop($, id);
  } else if (e.notification_type === "quota_auto_resume_disabled" && ep.state === "native") {
    await ask($, id, ep, await $.clock.now());
    return;
  }
  await refreshStatus($, id, await $.clock.now());
}

async function standDown($) {
  const id = await $.session.id();
  const ep = await $.store.get(limitKey(id));
  if (ep && ep.state !== "sent") await drop($, id);
  await refreshStatus($, id, await $.clock.now());
}

/** Something due long ago (the machine slept): put it in the prompt box instead of sending it. */
async function offer($, text) {
  await $.prompt.fill({ text });
  $.ui.toast("Rewake: press Enter to send the message waiting in the prompt.");
}

/** The armed continue is due: re-check the limit, then send once. */
async function fire($, id) {
  if (busy) return;
  busy = true;
  try {
    // A /clear, /resume or /branch moved this process to another conversation: keep the record
    // for when that one is reopened, and send nothing here.
    if ((await $.session.id()) !== id) return disarm(id);
    const ep = await $.store.get(limitKey(id));
    const now = await $.clock.now();
    if (ep?.state !== "armed" || ep.fireAt === undefined || now < ep.fireAt) return;
    if (now - ep.fireAt > STALE_MS) {
      await drop($, id);
      await offer($, CONTINUE_TEXT);
    } else {
      // $.store is one file shared by every Claude Code process: another one with this session
      // open has the same continue armed. Claim it, and go on only if the claim is still ours
      // after the usage check.
      if (ep.claim && ep.claim.by !== ME && now - ep.claim.at < CLAIM_MS) return;
      await $.store.set(limitKey(id), { ...ep, claim: { by: ME, at: now } });
      const still = blockedUntil((await $.session.usage()).rateLimits, now);
      const mine = await $.store.get(limitKey(id));
      if (mine?.state !== "armed" || mine.claim?.by !== ME) return disarm(id);
      // A later window more than a day away is asked about, never waited for silently (rule 2).
      if (still !== undefined && ep.attempts < MAX_REARMS && still - now <= FAR_RESET_MS) {
        // Another window is still used up (a weekly limit behind a 5-hour one): wait for it.
        const next = {
          ...ep,
          resetAt: still,
          fireAt: still + AFTER_RESET_MS,
          attempts: ep.attempts + 1,
        };
        await save($, id, next);
        await arm($, id, next);
      } else if (still !== undefined) {
        // Still limited after the last re-check, or until more than a day from now: offer it for
        // the later reset instead.
        disarm(id);
        await save($, id, {
          ...ep,
          state: "offered",
          resetAt: still,
          fireAt: still + AFTER_RESET_MS,
          attempts: 0,
        });
      } else {
        disarm(id);
        await save($, id, { ...ep, state: "sent", sentAt: now });
        void $.prompt.submit({ text: CONTINUE_TEXT, asUser: true });
      }
    }
    await refreshStatus($, id, now);
  } finally {
    busy = false;
  }
}

/** Every minute: catch up on a continue whose timer slept through its time; send due schedules. */
async function tick($) {
  const id = await $.session.id();
  const now = await $.clock.now();
  let ep = await $.store.get(limitKey(id));
  if (expired(ep, now)) {
    await drop($, id);
    ep = undefined;
    await refreshStatus($, id, now);
  }
  if (ep?.state === "armed" && ep.fireAt !== undefined && now >= ep.fireAt) return fire($, id);
  // Claude Code was expected to continue by itself, but hasn't said so since the reset: Rewake
  // asks (or, with "always", continues), so a session never waits with nobody to continue it.
  if (ep?.state === "native" && ep.resetAt !== undefined && now >= ep.resetAt + NATIVE_GRACE_MS)
    return ask($, id, { ...ep, fireAt: now }, now);
  await updateWake($, ep, now);
  // Scheduled messages wait while a limit is pending; one per tick.
  if (busy || (ep && ep.state !== "sent")) return;
  const sched = (await $.store.get(schedKey(id))) ?? [];
  const due = sched.find((s) => s.at <= now);
  if (!due) return;
  const rest = sched.filter((s) => s !== due);
  if (rest.length > 0) await $.store.set(schedKey(id), rest);
  else await $.store.delete(schedKey(id));
  if (now - due.at > STALE_MS) await offer($, due.text);
  else void $.prompt.submit({ text: due.text, asUser: true });
  await refreshStatus($, id, now);
}

/** On start or resume: re-arm a pending continue; one that came due while closed is offered, not sent. */
async function reopen($) {
  const id = await $.session.id();
  const now = await $.clock.now();
  const ep = await $.store.get(limitKey(id));
  if (expired(ep, now)) {
    await drop($, id);
  } else if (ep?.state === "armed" && ep.fireAt !== undefined) {
    if (now >= ep.fireAt) {
      await drop($, id);
      await offer($, CONTINUE_TEXT);
    } else {
      await arm($, id, ep);
    }
  } else if (ep?.state === "native" && ep.fireAt !== undefined) {
    // Claude Code's own wait ended with the process that was waiting: Rewake takes over.
    if (now >= ep.fireAt) {
      await drop($, id);
      await offer($, CONTINUE_TEXT);
    } else {
      await ask($, id, ep, now);
      return;
    }
  }
  await refreshStatus($, id, now);
}

/** Add a scheduled message, kept in time order so `/rewake list` numbers them by time. */
async function addMessage($, id, when, text) {
  const sched = (await $.store.get(schedKey(id))) ?? [];
  await $.store.set(
    schedKey(id),
    [...sched, { at: when, text }].sort((x, y) => x.at - y.at),
  );
}

/**
 * `/rewake` in a session that isn't waiting at a limit: one question per step, when (presets with
 * their times, or Custom…), then what. Dismissing the first question shows what's scheduled.
 */
/** Messages to pick in `/rewake`'s second question; "Other" types any message. */
const MESSAGE_PRESETS = [
  "Continue from where you left off.",
  "Check where things stand and report back.",
];

async function scheduleFlow($, id, now) {
  const presets = [
    ["In 30 minutes", 30 * MINUTE],
    ["In 1 hour", HOUR],
    ["In 3 hours", 3 * HOUR],
  ].map(([label, ms]) => ({ label: `${label} (${at(now + ms, now)})`, at: now + ms }));
  const custom = "Custom…";
  let when;
  try {
    const answer = await $.ui.ask("When should Rewake send a message into this session?", {
      options: [...presets.map((p) => p.label), custom],
      header: "Rewake",
    });
    when = presets.find((p) => p.label === answer)?.at;
    // A time typed in the question's own free-text choice ("Other", "Type something").
    if (when === undefined && answer !== custom && String(answer).trim() !== "") {
      const p = parseWhen(String(answer).replace(/^\s*at\s+/i, ""), now);
      if (!p.ok) return `Rewake: ${p.error}`;
      when = p.at;
    }
    if (when === undefined && answer === custom) {
      // Real choices, not a bare question: Claude Code's VS Code and Cursor panels answer a
      // question without options with Yes/No. "Other" (the panels' own) types any time.
      const examples = ["in 45m", clock === "24h" ? "18:00" : "6pm", "tomorrow 9:00"]
        .map((t) => ({ t, p: parseWhen(t, now) }))
        .filter((e) => e.p.ok)
        .map((e) => ({ label: `${e.t} (${at(e.p.at, now)})`, t: e.t }));
      const typed = String(
        await $.ui.ask("When? Pick one, or type a time.", {
          options: examples.map((e) => e.label),
          header: "Rewake",
        }),
      );
      const picked = examples.find((e) => e.label === typed)?.t ?? typed;
      const p = parseWhen(picked.replace(/^\s*at\s+/i, ""), now);
      if (!p.ok) return `Rewake: ${p.error}`;
      when = p.at;
    }
  } catch {
    return `${await listText($, id, now)}\n\nType /rewake help to see what Rewake can do here.`;
  }
  if (when === undefined) return "Nothing was scheduled.";
  let text;
  try {
    text = String(
      await $.ui.ask(
        `What should Rewake send into this session ${atWhen(when, now)}? Pick one, or type your own.`,
        { options: MESSAGE_PRESETS, header: "Rewake" },
      ),
    ).trim();
  } catch {
    return "Nothing was scheduled.";
  }
  if (text === "") return "Nothing was scheduled.";
  if (text.startsWith("/")) return 'A scheduled message cannot start with "/".';
  await addMessage($, id, when, text);
  return `Scheduled for ${at(when, now)}.`;
}

/** What `/rewake list` says: the continue, then each scheduled message by number. */
async function listText($, id, now) {
  const ep = await $.store.get(limitKey(id));
  const sched = (await $.store.get(schedKey(id))) ?? [];
  const lines = [];
  if (ep?.state === "armed" && ep.fireAt !== undefined)
    lines.push(`Continues at ${at(ep.fireAt, now)}. To cancel: /rewake cancel`);
  for (const [i, s] of sched.entries()) lines.push(`${i + 1}. ${at(s.at, now)}: ${s.text}`);
  if (lines.length === 0) lines.push("Nothing scheduled in this session.");
  const prefs = (await $.store.get("prefs")) ?? {};
  if (prefs.autoContinue === "always")
    lines.push(
      "After a usage limit, Rewake continues without asking when the reset is within a day. To be asked each time: /rewake auto off",
    );
  return lines.join("\n");
}

/** Continue after the usage limit: at the reset, or at `when`. */
async function continueAt($, id, ep, when, now) {
  if (!ep || ep.state === "sent")
    return "This session isn't stopped at a usage limit. To schedule a message: /rewake in 1h <message>";
  if (ep.state === "native" && when === undefined)
    return `Claude Code continues this session by itself${ep.resetAt !== undefined ? ` after the reset ${atWhen(ep.resetAt, now)}` : ""}.`;
  const fireAt = when ?? ep.fireAt;
  if (fireAt === undefined)
    return "Rewake doesn't know when this limit resets yet. Give a time, for example /rewake 3:30pm.";
  if (ep.state === "armed" && when === undefined)
    return `This session already continues at ${at(fireAt, now)}. To cancel: /rewake cancel`;
  const next = { ...ep, state: "armed", fireAt, attempts: 0 };
  await save($, id, next);
  await arm($, id, next);
  return `This session continues at ${at(fireAt, now)}. To cancel: /rewake cancel`;
}

/** `/rewake <args>`: Rewake's one command (logic.js parseCommand), answered without Claude. */
async function runCommand($, args) {
  const id = await $.session.id();
  const now = await $.clock.now();
  const c = parseCommand(args);
  const ep = await $.store.get(limitKey(id));
  const sched = (await $.store.get(schedKey(id))) ?? [];
  const needs = featureOf(c);
  let text;
  if (needs && !FEATURES.has(needs)) {
    text = notHere(needs);
  } else if (c.kind === "help") {
    text = helpText();
  } else if (c.kind === "home") {
    const waiting = ep && ep.state !== "sent" && ep.state !== "armed";
    text = waiting ? await continueAt($, id, ep, undefined, now) : await scheduleFlow($, id, now);
  } else if (c.kind === "continue" || c.kind === "at") {
    const s = c.kind === "at" ? c.args : (c.when ?? "");
    const p = s ? splitWhen(s, now) : { ok: true, text: "" };
    if (!p.ok) {
      text = `Rewake: ${p.error}`;
    } else if (p.text === "" || c.kind === "continue") {
      text = await continueAt($, id, ep, p.at, now);
    } else if (p.text.startsWith("/")) {
      // $.prompt.submit refuses text that starts with "/" (it would run a command).
      text = 'A scheduled message cannot start with "/".';
    } else {
      await addMessage($, id, p.at, p.text);
      text = `Scheduled for ${at(p.at, now)}.`;
    }
  } else if (c.kind === "list") {
    text = await listText($, id, now);
  } else if (c.kind === "cancel" && c.which === undefined) {
    if (ep && ep.state !== "sent" && ep.fireAt !== undefined) {
      await drop($, id);
      text = `Cancelled the automatic continue at ${at(ep.fireAt, now)}.${sched.length > 0 ? " Your scheduled messages stay." : ""}`;
    } else {
      text = `Nothing is set to continue in this session.${sched.length > 0 ? " To delete a scheduled message: /rewake cancel N, or /rewake cancel all." : ""}`;
    }
  } else if (c.kind === "cancel" && c.which === "all") {
    if (sched.length === 0) {
      text = "Nothing scheduled in this session.";
    } else {
      const one = sched.length === 1;
      const yes = one ? "Delete it" : "Delete them";
      let answer;
      try {
        answer = await $.ui.ask(
          one
            ? "Delete the scheduled message in this session?"
            : `Delete all ${sched.length} scheduled messages in this session?`,
          { options: [yes, one ? "Keep it" : "Keep them"], header: "Rewake" },
        );
      } catch {
        answer = undefined;
      }
      if (answer === yes) {
        await $.store.delete(schedKey(id));
        text = one
          ? "Deleted the scheduled message."
          : `Deleted ${sched.length} scheduled messages.`;
      } else {
        text = one ? "Kept your scheduled message." : "Kept your scheduled messages.";
      }
    }
  } else if (c.kind === "cancel") {
    const n = Number(c.which);
    const s = Number.isInteger(n) && n >= 1 ? sched[n - 1] : undefined;
    if (!s) {
      text = `There's no scheduled message number ${c.which} in this session. Type /rewake list.`;
    } else {
      const rest = sched.filter((x) => x !== s);
      if (rest.length > 0) await $.store.set(schedKey(id), rest);
      else await $.store.delete(schedKey(id));
      text = `Deleted the message scheduled for ${at(s.at, now)}.`;
    }
  } else if (c.kind === "auto") {
    const prefs = (await $.store.get("prefs")) ?? {};
    const { autoContinue: _, ...rest } = prefs;
    if (c.on === true) {
      await $.store.set("prefs", { ...rest, autoContinue: "always" });
      text =
        "From now on, after a usage limit Rewake continues every session without asking when the reset is within a day. To be asked each time: /rewake auto off";
    } else if (c.on === false) {
      await $.store.set("prefs", rest);
      text = "Rewake will ask before continuing after a usage limit.";
    } else {
      text =
        prefs.autoContinue === "always"
          ? "After a usage limit, Rewake continues without asking when the reset is within a day. To be asked each time: /rewake auto off"
          : "After a usage limit, Rewake asks before continuing. To continue without asking: /rewake auto on";
    }
  } else {
    text = helpText();
  }
  await refreshStatus($, id, now);
  return { text };
}

/** Observe-only hooks: if one fails, the event goes on unchanged. */
const passOn = (_$, e, next) => (next.called ? undefined : next(e));

export function register(on) {
  on("session.start", async ($, e, next) => {
    isInteractive = e.isInteractive;
    entrypoint = await $.env.get("CLAUDE_CODE_ENTRYPOINT").catch(() => undefined);
    surface = surfaceOf({ surface: e.surface, entrypoint });
    try {
      nativeSetting = { value: (await $.settings.read()).autoContinueAtUsageLimit };
    } catch {
      nativeSetting = undefined;
    }
    await loadConfig($);
    $.clock.every(TICK_MS, () => void tick($));
    void reopen($);
    for (const entry of [
      {
        name: "rewake",
        description:
          "Agent Rewake: continue after a usage limit, and schedule messages (/rewake help)",
        argumentHint: "[in 1h <message> | 3:30pm | list | cancel [N|all] | auto on|off | help]",
      },
    ])
      try {
        await $.command.register(entry);
      } catch {
        // The name is taken: everything else still works.
      }
    return next(e);
  });

  on("classic.SessionStart", ($, e, next) => {
    // An in-process switch (/resume, /clear, /branch): the armed timer belongs to the old one.
    if (e.source === "resume" || e.source === "clear" || e.source === "fork") {
      disarm();
      void reopen($);
    }
    return next(e);
  }).catch(passOn);

  on("classic.StopFailure", ($, e, next) => {
    // Main conversation only: helper and subagent failures carry agent_id.
    if (e.error === "rate_limit" && e.agent_id === undefined) void onLimit($, e.session_id);
    return next(e);
  }).catch(passOn);

  on("session.measure", ($, e, next) => {
    if (e.changed.includes("rateLimits")) void onMeasure($, e.rateLimits);
    return next(e);
  }).catch(passOn);

  on("classic.Notification", ($, e, next) => {
    if (e.notification_type.startsWith("quota_auto_resume_")) void onNotification($, e);
    return next(e);
  }).catch(passOn);

  on("prompt.submit", ($, e, next) => {
    // Observe only: the person typed, or Claude Code's own auto-continue fired.
    if (MOVED_ON.has(e.origin.kind)) void standDown($);
    return next(e);
  }).catch(passOn);

  on("command.run", { command: "rewake" }, ($, e) => runCommand($, e.args));
}
