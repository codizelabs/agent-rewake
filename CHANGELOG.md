# Changelog

All notable changes to Agent Rewake are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.x`, a minor release may contain breaking changes, always called out below.

## [Unreleased]

### Changed

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
