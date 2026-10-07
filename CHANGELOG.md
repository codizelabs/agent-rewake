# Changelog

All notable changes to Agent Rewake are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.x`, a minor release may contain breaking changes, always called out below.

## [Unreleased]

### Added

- **Keep this computer awake for resumes and scheduled messages** (macOS): while a resume or scheduled message is due within six hours, or while the agent works on a scheduled message, Rewake stops the computer from idling to sleep with the system's own `caffeinate`, tied to Rewake's process so it ends with it. A new setting chooses *While it's plugged in* (default), *Always, also on battery* or *Never*; the thread says once when the computer is kept awake. In the Claude Code preview the same happens while a continue is due (Rewake's or Claude Code's own), and every preview keeps the computer awake while the agent works on the resumed session. Closing the lid still puts the computer to sleep, and Rewake can't wake a sleeping one. Linux and Windows aren't supported yet.

### Fixed

- A usage limit that names a spend limit or credits but also says when the plan's limit resets ("You've hit your individual spend limit · … · your session limit resets 7:50pm") is resumed at that time. Rewake ignored it before. The same applies to Codex, Copilot, Factory Droid, Amp, Z.AI and others ("purchase more credits or try again at 2:51 PM").
- When a limit can't be fixed by waiting (credits, billing or a spending limit), Rewake says so in the thread instead of saying nothing.
- Reset times are read in every format agents use: dates with a year, day-first dates, UTC and offsets, "in 4 days, 23 hours", "4hr 10min", "2h3m4s", "202ms", "next hour" and epoch times. "Try again after 1 seconds" no longer reads as 1 o'clock, "202ms" as 202 minutes, or "Jan 2, 2027, 3pm" as 8pm.
- A resume left over from an earlier limit no longer gets in the way. When Claude answers again before the old reset (another account, another model, bought usage), the old resume is cancelled, also after a restart. A missed resume, or one waiting for your answer, is replaced by the new limit's resume, and a sooner reset moves a scheduled resume earlier.
- "Automatic resume: on for new threads" also applies to a thread Rewake first sees when Zed reopens it, not only to threads created while Rewake runs.
- A limit that arrives while another Rewake question is open is still offered, as a line in the thread.
- Rewake exits when Zed closes it, even if the agent ignores the request to stop; the log moves to a new file each day.
- Rewake reads the error text wherever the agent puts it (`data.details`, a plain `data`, `data.error`), as Zed does, and recognises a lost session from more agents.
- **Codex preview:** an ordinary plan limit is resumed again. Rewake read Codex's "spending cap reached" flag as set whenever Codex sent it, and Codex sends it on every limit (as `false`), so every Codex limit was treated as billing. Codex's credit, spend-cap and plan messages are recognised from the message too, and the reset is the window that stopped the turn, not the weekly one.
- **Copilot CLI preview:** reads Copilot's own wording ("reset in 2 hours", reset dates in UTC), leaves short-term rate limits and errors Copilot recovered from to Copilot, and counts the monthly premium-request allowance as a usage limit. A reset date east of UTC is no longer dropped as already past.
- **Grok Build preview:** short team or plan rate limits and overloads are no longer treated as an 80-hour weekly wait; the weekly reset is used only when the weekly pool is what ran out.
- **Gemini CLI and Antigravity CLI previews:** a daily quota is resumed. Gemini words every quota error with "please check your plan and billing details", which Rewake read as billing; a reset time now wins over the offer of overages, and a wait of seconds is left to the agent.
- **Claude Code preview:** a gateway's daily spending cap, which resets within a day, is waited for; a monthly cap still isn't.
- A Copilot CLI or Grok session that no longer exists is reported as deleted, not as a failure.
- **Previews outside Zed:** a resume that is still limited at its time is tried again later. Before, on macOS the new timer couldn't be set from inside the one that was running, so the resume was dropped. Each re-arm now gets its own timer.
- **Previews outside Zed:** a resume can't be sent twice when two timers run at the same moment, and a resume cut off by a crash or restart is never sent again: Rewake tells you to check the session instead of leaving it stuck.
- **Previews outside Zed:** a continued session whose agent is still working half an hour later (for example, waiting for your approval) is stopped, and you're told to check it.
- **Previews outside Zed:** lost timers are restored whenever Rewake runs (`doctor`, `ui`, `install`, `continue` and each hook), not only from hooks. On Linux, `at` is used only when its service is running.
- **Previews outside Zed:** hooks and timers run the Rewake you last updated to; before, they kept the version you installed them with. `install --only claude-code` works when Rewake was started with `npx` or a global install.
- **Copilot CLI, Grok and Gemini CLI previews:** a session whose terminal was closed or crashed without ending the session is no longer taken as open for ever. Rewake remembers the agent's process at the start; once it's gone, a limit in that session is continued or offered as at a normal end, and `agent-rewake continue` lists it.
- **Previews outside Zed:** a missed resume, or one that needed your attention, no longer blocks a later limit in the same session from being continued.
- **Previews outside Zed:** `install --only <agent>` checks the agent's version even when it was installed with Homebrew, apt, WinGet or a standalone installer, by asking the agent (`--version`). Before, a version Rewake couldn't read skipped the check, so an agent too old for Rewake was set up anyway. When the version still can't be read, install says which version Rewake needs and how to update.
- **Gemini CLI preview:** install no longer refuses a default Gemini CLI setup: Gemini runs extension hooks unless they're turned off, and Rewake read a missing setting as off. A session is followed through a switch to a fallback model (Gemini gives the hook a new id then; Rewake now uses the session file's own), a limit followed by Gemini's own bookkeeping lines is still seen, and with an API key a quota with no reset time is continued after midnight Pacific time, when Gemini API daily quotas reset.
- **Previews outside Zed:** automatic resume follows "Automatic resume for new threads: on" even when Zed's "except when permissions are bypassed" is chosen; a resume outside Zed never bypasses permissions, so that exception never applied there and only turned automatic resume off. `agent-rewake continue --always` now has the effect it promises.
- **Previews outside Zed:** the schedules page (`agent-rewake ui`) shows the agent's name for their resumes, and changing a resume's time, sending it now, pausing, resuming or deleting it moves or removes its timer too. Before, the old timer kept its time. Pressing `a` on such a row explains how automatic resume is set for that agent instead of turning a Zed thread setting on, which made the agent's own hooks stand down.
- **Previews outside Zed:** `uninstall --only <agent>` cancels that agent's planned resumes and their timers.

### Changed

- Usage limits are recognised for every agent in Zed's registry, each from what it actually sends: Claude's rate-limit event (the same test Claude Code uses to continue on its own), Codex's error kinds, Gemini CLI, Qwen, Qoder, Kimi, Z.AI, MiniMax, Auggie, CodeBuddy, Devin, Junie, Mistral Vibe, goose, OpenCode, Kilo, Cline, Grok Build, Kimchi and Harn. Short-term rate limits, which the agent retries itself, are no longer treated as a usage limit.
- Cursor, GitHub Copilot, Amp, Factory Droid, Antigravity, goose, fast-agent, Cortex Code and Autohand report a limit only as the last line of a turn. Rewake now reads that line, and only when it starts with the agent's own fixed wording.

- `doctor` checks the whole setup and says in plain words what's left to do, grouped by Zed, Rewake, sign-in, scheduled messages and recent problems, with a fix for each and a "start here". It covers:
  - **Zed:** whether it's installed, and an old version.
  - **Zed's settings:** AI features or the agent turned off (also in a release-channel or OS section, counted only for an edition of Zed that's installed); a section that sets an agent again without Rewake; Zed's list of agents not downloaded yet.
  - **Rewake:** agents without it, and why some can't have it; Zed starting an older version, or a Node.js that has moved or is too old; Zed not having started Rewake yet (with where Rewake works and what it can't reach); its folder not writable.
  - **Settings that switch features off:** automatic resume or the agent's tools, on an agent or in the shell, and Claude Code's own continue setting.
  - **Sign-in:** an API key given to Claude Agent in Zed's settings, which Zed clears when Rewake runs it; the sign-in kind each agent reported (an API key means no usage windows).
  - **Scheduled messages:** past due, needs you, failed and missed ones, and the next one.
  - **Recently:** agents that couldn't start or kept stopping, lost conversations, and messages that failed for sign-in or billing.

  It works offline and prints no folders, accounts, keys or message text; `doctor --details` adds versions and folders (home shortened to `~`) for bug reports.
- Rewake records the sign-in kind an agent reports to Zed (account, API key, cloud provider, gateway or none), as one word, so `doctor` can explain it. It never records the account's email, organisation or plan.
- `install` explains when it adds Claude Agent because Zed has no external agents yet, warns when Zed's AI features are off, and its next steps name the Agent Panel and its shortcut.
- `install` says which version it updates each agent from and to, and `doctor`'s update advice uses `npx @codizelabs/agent-rewake@latest install` (a bare `npx` may run a copy it saved earlier).
- Docs: an **Update** section with the two steps that work for every version, why each is needed, `npm install -g` and downgrades, and a table of version-specific steps (none so far). Releases that need more add **Upgrade notes** here.
- `install` and `doctor` notice other coding agents on the computer (Claude Code, Codex, GitHub Copilot CLI, Grok Build, Gemini CLI, Antigravity) and say plainly that, outside Zed, Rewake doesn't work in them. They only look for the programs and read version files; they never run them. `doctor --details` lists their versions.
- Docs: a section on the previews outside Zed (how to install, use and remove each). `install` and `doctor` now name the previews you set up, and what each covers.
- Preview, being tested: Rewake for Gemini CLI and Antigravity's CLI (`agy`). `agent-rewake install --only gemini-cli` links a small Gemini CLI extension with Gemini's own command (Gemini asks you to confirm it, and its hooks must be turned on); `--only antigravity` adds one plugin folder. Both work like Copilot CLI and Grok: when a session stops at a usage limit and is closed, `agent-rewake continue` continues it after the reset. Antigravity's app and IDE conversations aren't continued. Neither is installed by default.
- Preview, being tested: Rewake for Grok Build in a terminal. `agent-rewake install --only grok` adds one hooks file Rewake owns; it works the same way as for Copilot CLI (`agent-rewake continue`). Grok's weekly limit is told apart from a spending cap, which is never resumed. It isn't installed by default.
- Preview, being tested: Rewake for GitHub Copilot CLI in a terminal. `agent-rewake install --only copilot-cli` adds one hooks file Rewake owns. When a session stops at a usage limit and is closed, Rewake tells you, and `agent-rewake continue` continues the same session after the reset (or `agent-rewake continue --always` lets it do that by itself when the reset is within a day). It never writes into a session that's open. It isn't installed by default.
- Preview, being tested: Rewake for Claude Code used on its own, in a terminal or the Claude desktop app's Code tab. `agent-rewake install --only claude-code` adds a small plugin with Claude Code's own commands. When a usage limit stops a session and Claude Code won't continue it by itself, Rewake asks there and continues the same session after the reset; `/rewake` schedules messages into the session. It isn't installed by default.
- Preview, being tested: Rewake for Codex used on its own, in a terminal. `agent-rewake install --only codex` adds a Codex plugin with Codex's own commands; you trust its hooks in Codex once. When a thread hits its usage limit, type `rewake` in it, and Rewake continues the same thread when the limit resets (through `codex queue`). It isn't installed by default.
- New `agent-rewake fire <id>`, run by Rewake's own one-shot timers (launchd on macOS, systemd or `at` on Linux, Task Scheduler on Windows) at a resume's time. It's the base for resuming agents outside Zed and isn't used yet. Agents Rewake runs in Zed are marked, so a later integration for the same agent's own app never resumes them a second time.
- Scheduled messages saved by a later version of Rewake for an agent this version doesn't support are left alone (never sent, changed or deleted), so going back to an earlier version stays safe.
- The README, docs and website say who Rewake is for ("Is it for you?"), with a troubleshooting entry for "installed, but nothing happens".

## [0.1.1] - 2026-10-06

### Fixed

- A scheduled message that is sent again after a usage limit is no longer shown twice in the thread; Rewake says it's sending it again instead.

## [0.1.0] - 2026-10-06

First release.

### Added

- **Resume after a usage limit**, with any agent: the thread offers to resume with an editable message, and sends it when the limit resets (following a later reset if the agent is still limited). Optional automatic resume per thread or for every new thread; it asks first for limits more than a day away and never resumes credit or billing limits.
- Follow-up messages queued after a resume, sent one after another.
- **Scheduled messages**: once, at a time you pick, or repeating (presets or any cron expression, read back in plain words before saving). The agent can propose schedules, which you approve in the thread.
- The **Rewake menu** in the thread toolbar, short forms with buttons, and `/schedule` commands for people who prefer typing.
- The **schedules page** for every thread and agent, in Zed's terminal or any terminal (`agent-rewake ui`).
- `agent-rewake install` / `uninstall`: puts Rewake in front of the agents you already use, under their own names, with backups and comments kept; `doctor` checks the setup.
- Works with Claude Agent, Codex, Gemini CLI, GitHub Copilot, OpenCode, goose and every other external agent Zed runs, npm-based or binary, plus custom agents.
- macOS, Linux (including Flatpak Zed) and Windows.

[0.1.1]: https://github.com/codizelabs/agent-rewake/releases/tag/v0.1.1
[0.1.0]: https://github.com/codizelabs/agent-rewake/releases/tag/v0.1.0
