/**
 * What Agent Rewake does, when it works and when it doesn't, in plain words: the agent reads
 * this through the `about_rewake` tool to answer the user's questions, and the
 * first-use note in a thread is a short version of it. Every statement comes from the code or
 * from Zed v1.22.0's source; keep them in step.
 */

/** The short note shown once per thread, the first time someone schedules or turns on resume. */
export function introNote(agent: string, menu: boolean, tools: boolean): string {
  return [
    "How Rewake works:",
    "",
    "- Zed must be running with this project open. Rewake runs inside Zed, so nothing is sent while Zed is closed or the computer is asleep or off.",
    "- After restarting Zed, open this thread once. Zed reopens only your last-used thread; other threads send once you open them.",
    "- More than 15 minutes late? Rewake doesn't send it on its own: it asks you here. A repeating message skips that time.",
    "- You can work in other threads. Messages here are still sent on time; open this thread to see the reply. If the agent is busy here, the message goes right after its reply.",
    "- Permission prompts wait for you, even in a scheduled reply.",
    ...(tools
      ? [
          `- Ask ${agent}. It knows Rewake: it can schedule, change or delete messages in this thread (you approve each one), and answer any question about how Rewake works.`,
        ]
      : []),
    menu
      ? "- To change things, use the Rewake menu under the message box: *Schedules*, *Turn on auto-resume after limits…* (this thread), *Settings…* (all threads)."
      : "- To change things, type `/rewake list`, `/rewake cancel N` or `/rewake auto on|off`.",
  ].join("\n");
}

/** The full guide, for the agent. Markdown. */
export const AGENT_GUIDE = `# Agent Rewake: what it is and how it behaves

Use this to answer the user's questions about Agent Rewake. Answer from it; don't guess. If something isn't covered here, say you don't know rather than inventing behaviour.

## What it is

Agent Rewake is an open-source add-on for Zed's agent threads (Claude, Codex, Gemini and other ACP agents). It is not a Zed extension and not made by Zed or Anthropic. It sits between Zed and the agent ("an ACP proxy"): Zed starts Rewake, and Rewake starts the agent. It adds:

- **Scheduled messages**: a message sent into this thread later, once or repeating (presets or cron), as if the user typed it.
- **Resume after a usage limit**: when the agent stops at a usage limit, Rewake offers to send a resume message when the limit resets, or does it automatically if the user turned that on.
- **Messages after a resume**: more messages to send one after another after the resume, each when the previous reply finishes.
- **Your tools** (the agent's): schedule_message, list_scheduled_messages, update_scheduled_message, cancel_scheduled_message, and about_rewake (this guide). Every change waits for the user to approve it in the thread.

## Where the user controls it

- **The Rewake menu** in the toolbar under the message box (next to the model picker): *Schedules* (a table of this thread's messages), *Schedule a message…*, *Change a scheduled message…*, *Resume after the usage limit…* (after a limit; once a resume is scheduled it reads *Add a message after the resume…*), *Turn on/off auto-resume after limits…*, *Stop the scheduled reply* (while one runs), *Settings…*.
- **Commands** typed in the thread: \`/rewake <when> <message>\` (for example \`/rewake in 1h Run the tests\`, \`/rewake 9pm …\`, \`/rewake every weekday 09:00 …\`), \`/rewake list\`, \`/rewake cancel N\`, \`/rewake pause N\`, \`/rewake resume N\`, \`/rewake now N\`, \`/rewake\` or \`/rewake continue\` (after a limit; \`/rewake 3:30pm\` for another time), \`/rewake cancel\` (that resume), \`/rewake auto on|off\`, \`/rewake prompt <text>\` (this thread's resume message), \`/rewake stop\`.
- **The schedules page**: run \`agent-rewake ui\` in a terminal (or the Zed task Rewake adds) for every thread's messages, with mouse and keys. \`agent-rewake schedules\` lists them; \`agent-rewake doctor\` checks the setup.
- **Settings…** (they apply to every thread):
  - *Automatic resume after usage limits*: *On, even when permissions are bypassed* · *On, except when permissions are bypassed* · *Ask when a new thread opens* (default) · *Off*. "On" and "Ask" decide what new threads do ("On" also covers threads Rewake sees for the first time, such as ones reopened after installing it); the bypass part applies at every limit.
  - *Time format*: 12-hour (default) or 24-hour.
- **Per thread**: automatic resume on or off (menu or \`/rewake auto on|off\`), and the resume message (\`/rewake prompt\`, or edit it in the resume form; it's remembered for this thread).

## When a scheduled message is sent, and when it isn't

Rewake has no background service: it runs inside Zed, as part of the agent process Zed starts for each agent in each Zed window. So:

| Situation | What happens |
|---|---|
| Zed open, this thread open | Sent at its time (checked about every 30 seconds) |
| The agent is replying in this thread at that time | Marked *Queued* and sent right after the reply. The thread says "Rewake: Queued. …" |
| The user sends a message while a scheduled reply runs | The user's message is held and goes as soon as the scheduled reply finishes ("Rewake: Waiting. …"); to interrupt, *Stop the scheduled reply* or \`/rewake stop\` |
| The user is working in another thread (same agent, same window) | Still sent; each thread is handled separately. The user sees the reply when they switch back to this thread. Rewake shows no system notification |
| The user switched away long ago, or removed the thread from Zed's sidebar | Zed keeps only recent threads loaded (every running thread plus the 5 most recent idle ones). Rewake still sends the message in the background, reconnecting the thread to the agent first; the user doesn't see it happen. Whether the reply then shows when the thread is reopened hasn't been verified in Zed yet |
| A different agent, or another project window | Each has its own Rewake process and sends its own threads' messages |
| The same thread open in two Zed windows | The window that opened it first sends it. The other says "Another Zed window owns this thread, so that window will send it." |
| Zed is closed at that time | Nothing is sent. Nothing runs while Zed is closed |
| Zed restarted, thread not opened since | Not sent yet. Zed reopens only the last active thread by itself; any other thread's messages go once the user opens that thread |
| Opened again within 15 minutes of the time | Sent, and the thread says it was due at that time |
| Opened more than 15 minutes late | A one-off message (or resume) is marked *Missed* and Rewake asks: *Send it now*, *Pick a new time…* or *Delete it*. A repeating message skips that run and says when the next one is. The 15 minutes count until the thread is opened, not until Zed starts |
| Computer asleep | Nothing runs; on wake the same 15-minute rule applies. On macOS Rewake keeps the computer from idling to sleep while a message is due within six hours or the agent works on a scheduled message (Settings: *Keep this computer awake for resumes and scheduled messages*: *While it's plugged in*, the default; *Always, also on battery*; *Never*), and says so once in the thread. On every system it reads the computer's own sleep settings (no admin, never changed): if one would let it sleep while a message is due, the thread says so once with a link to the docs' "Keep your computer awake" section, and \`agent-rewake doctor\` shows it under "Sleep settings". It can't stop sleep when the lid closes, and can't wake a sleeping computer |
| Zed quit while a scheduled reply was running | When the thread is next opened, Rewake asks whether to send it again (it may have been cut off); a repeating message moves on to its next run |
| The agent process crashed during a scheduled reply | Zed restarts it; the reply is marked failed with "The agent restarted." and Rewake asks whether to try again |
| The agent lost the session ("Session not found") | Rewake reconnects the thread and retries once; if that fails, it asks |
| A permission prompt appears during a scheduled reply | It waits for the user, however long. Rewake never answers permission prompts. Threads in a mode that skips prompts (Claude's "bypass permissions", Codex's full access) don't get any |
| The message was paused | Not sent until resumed; if its time has passed, resuming sends it at once |
| Rewake removed (\`agent-rewake uninstall\`) | Nothing more is sent after Zed restarts; saved data stays until deleted by hand |
| The thread is deleted in Zed | Its messages and settings are deleted too |

Limits: one-off messages at most 30 days ahead; repeats have no limit unless given an end (a number of runs or a date). A message is at most 16 KB. Times are the user's local time; a clock time already passed today means tomorrow.

## Usage limits

- Rewake recognises usage limits for every agent in Zed's registry the way that agent reports them: error details and codes, or for some agents (Cursor, Copilot, Amp, Factory Droid, Antigravity, goose and others) a fixed last line at the end of the turn. Only that last line counts, never other text in a reply. Credit, billing and spend limits are never resumed, because waiting doesn't fix them; Rewake says so in the thread. If the message gives a reset time, even next to an offer of credits ("purchase more credits or try again at 2:51 PM"), the limit resets, and Rewake resumes the thread then.
- When a limit stops the agent, Zed shows the agent's limit text as its reply, and Rewake asks: "… hit its usage limit. It resets at …. Resume this thread when it resets?" with the resume message to edit. If the agent didn't say when it resets, the form asks when: in 30 minutes, 1, 3 or 5 hours, or a custom time.
- The resume goes 1 minute after the reset (plus up to 20 seconds).
- **Automatic resume** (per thread; new threads follow Settings): at a limit Rewake schedules the resume without asking. It asks instead when: the user chose *On, except when permissions are bypassed* and the thread bypasses permissions; with Claude, its "Continue automatically at usage limit" setting is off; the reset is more than 24 hours away; the agent gave the same reset time as last time; or the agent never says when it resets and the limit has lasted about a day.
- If the agent is still limited when the resume goes, Rewake follows the new reset time, as often as it moves later. With no new time, it stops and asks.
- If the user continues the thread by hand after the reset, the pending resume is cancelled ("you've already continued this thread"). Messages queued after the resume are kept, paused. This only works while Zed has stayed open since the limit; after a restart the resume is still sent.
- **Messages after a resume**: *Add a message after the resume…* in the menu adds one (up to 20). At the reset the resume goes first, then each next message when the reply before it finishes, like Zed's own queue (Rewake can't use Zed's queue itself: Zed doesn't let add-ons add to it). If the resume's reply is stopped, they're kept, paused.

## Your tools and the user's approval

- Your tools reach **only this thread**. Every schedule, change or cancel shows the user a form in the thread; they can edit the message, accept or decline. Your call waits up to 10 minutes for the answer; after that nothing changes, and a late answer changes nothing either.
- When a message you scheduled is sent, you see "[A message you scheduled earlier with Agent Rewake; the user approved it]" before it. An automatic resume is labelled too, so you know no person typed it.
- Use list_scheduled_messages for numbers, times and status; give the user exact times from it.
- If a tool says Rewake "isn't linked to this conversation yet", ask the user to reopen the thread.
- The user can turn your tools off by setting AGENT_REWAKE_AGENT_TOOLS=0 for the agent in Zed.

## Statuses the user may see

Scheduled · Paused · Queued (due, waiting for the current reply) · Sending · Sent · Failed (the agent returned an error) · Missed (Zed or the computer wasn't running) · Stopped · Cancelled · Needs you (still limited with no new reset time, a reset more than a day away to confirm, or interrupted because Zed closed).

## Outside Zed (previews)

Everything above is about Zed's Agent Panel. Separately, Rewake can be set up, one agent at a time with \`agent-rewake install --only <agent>\`, in Claude Code in a terminal, Codex, GitHub Copilot CLI, Grok Build, Gemini CLI and Antigravity CLI outside Zed. These are previews. There, Rewake runs at the reset even with Zed closed, but the computer must be on and awake then. If a resume is more than 30 minutes late, Rewake notifies the user instead of sending it. Copilot CLI, Grok, Gemini CLI and Antigravity sessions are continued once closed (\`agent-rewake continue\`, or by itself after \`agent-rewake continue --always\`); Claude Code asks in the session. The command is the same everywhere: \`/rewake\` in Zed, Claude Code and Gemini CLI, and \`rewake\` without the slash in Codex (Codex refuses slash commands it doesn't know). \`/rewake\` at a limit continues after the reset, \`/rewake 3:30pm\` at that time, \`/rewake cancel\` cancels it and \`/rewake help\` lists what works in that place; each place answers it without the model. Copilot CLI, Grok and Antigravity have no command in the conversation. \`agent-rewake doctor\` has an "Outside Zed" section.

## Data and privacy

Everything stays on the user's computer in Rewake's state folder (macOS: ~/Library/Application Support/agent-rewake; Linux: ~/.local/state/agent-rewake; Windows: %LOCALAPPDATA%\\agent-rewake; or AGENT_REWAKE_STATE_DIR). It holds the scheduled messages, per-thread settings, settings.json and logs with metadata only (no message text). Rewake doesn't send the user's messages or data anywhere except to the agent. Its only network use is downloading an agent's own published program when Zed hasn't downloaded it yet.

## Good answers

- "Will it run if I close Zed?" No. Zed must be running with the project open; after restarting Zed, open the thread once.
- "Do I need to keep this thread open on screen?" No. Zed must be running with the project; the user can work in other threads.
- "What if I'm away when it's due?" If Zed and the computer are on, it's sent. If not, a message more than 15 minutes late is held and the user is asked.
- "Can you schedule it for me?" Yes: call schedule_message; the user approves in the thread.
- "How do I stop a scheduled reply?" *Stop the scheduled reply* in the Rewake menu, or /rewake stop.
- More help: https://rewake.js.org/ · source: https://github.com/codizelabs/agent-rewake
`;
