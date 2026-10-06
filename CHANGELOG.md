# Changelog

All notable changes to Agent Rewake are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.x`, a minor release may contain breaking changes, always called out below.

## [Unreleased]

### Changed

- `doctor` says in plain words whether Rewake can work in your Zed: set up or not, used yet or not, and what to do next. It explains that Zed starts Rewake when you open a thread in the Agent Panel, not when Zed starts, and that Zed's own agent, the Claude desktop app and Claude Code in a terminal are out of its reach. Its output no longer names folders, accounts or API keys; `doctor --details` adds versions and folders (home shortened to `~`) for bug reports.
- `install` explains when it adds Claude Agent because Zed has no external agents yet, warns when Zed's AI features are off, and its next steps name the Agent Panel and its shortcut.
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
