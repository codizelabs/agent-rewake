<div align="center">

<img src="site/src/assets/logo.svg" alt="" width="72" height="72">

# Agent Rewake

**Auto-resume your AI coding agent when its usage limit resets.** Same session, same context, same thread.

Works where you already use your agent: Claude Code in a terminal or in its VS Code and Cursor panel, Cursor's own agent, Codex, GitHub Copilot CLI, Gemini CLI, Grok Build and Antigravity CLI in a terminal, and every external agent in [Zed](https://zed.dev). Everything outside Zed is a preview.

[![npm](https://img.shields.io/npm/v/@codizelabs/agent-rewake?color=f4a949&label=npm)](https://www.npmjs.com/package/@codizelabs/agent-rewake)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)
[![macOS · Linux · Windows](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555)](#requirements)

[Docs](https://codizelabs.github.io/agent-rewake/docs/) · [Website](https://codizelabs.github.io/agent-rewake/) · [Report a bug](https://github.com/codizelabs/agent-rewake/issues/new/choose)

<br>

[![Watch the 1-minute intro: an agent stops at its limit at 3 AM, and Rewake resumes the thread on its own](site/public/video/rewake-intro-poster.jpg)](https://codizelabs.github.io/agent-rewake/#film)

<sub>▶ <a href="https://codizelabs.github.io/agent-rewake/#film">Watch the 1-minute intro</a> (with narration and captions)</sub>

</div>

---

## The problem

Coding agents stop at their usage limit: Claude's 5-hour session limit, Codex's message limits, Gemini's daily quota. It always happens mid-task, and the limit often resets at 3 AM, when nobody is there to type "continue". The work just sits there.

## What Agent Rewake does

<img src="site/public/images/rewake-demo.gif" alt="A Zed agent thread: the agent stops at its usage limit, Rewake asks whether to resume, and at 5:01 PM the thread continues on its own" width="100%">

- **Resumes after a usage limit.** When the agent stops, Rewake asks once whether to continue (or does it on its own, if you turned that on). At the reset, plus a minute, it sends a message that resumes the same session, and the agent carries on. If the agent is still limited, Rewake waits for the new reset time (outside Zed it tries again up to four times, then tells you).
- **Automatic, if you want.** Choose *from now on* when Rewake asks (Claude Code), turn on auto-resume in Zed's **Rewake** menu, or run `agent-rewake continue --always` (Copilot CLI, Gemini CLI, Grok Build, Antigravity CLI), and Rewake resumes without asking. It asks first when a limit resets more than a day away, never resumes credit or billing limits (and says so), and never approves permission prompts for you.
- **Sends messages later.** `/rewake in 1h Run the tests` schedules a message into the session (Zed and Claude Code; in Zed also on a repeat, such as every weekday at 9).
- **Keeps the computer awake, if it can.** On macOS, while a resume is due within six hours, Rewake stops the computer from idling to sleep (while plugged in, by default). Closing the lid still puts it to sleep. `agent-rewake doctor` tells you if your computer's own sleep settings would let it sleep, and [which settings to change](https://codizelabs.github.io/agent-rewake/docs/#keep-your-computer-awake).
- **Same agent, same session.** No new agent to pick: Rewake works inside or in front of the agents you already use, so your sessions and threads keep going where they stopped.

## Where you work

Install once with `npx @codizelabs/agent-rewake install`: it finds what's on your computer and lets you pick. Everything outside Zed is a preview: new, installed one place at a time, and it may change. Most previews have been tried on a Mac with a simulated usage limit; none has hit a real one yet ([what's been tried](https://codizelabs.github.io/agent-rewake/docs/#outside-zed-previews)).

| Where | Agents | What Rewake does there | Status |
|---|---|---|---|
| **A terminal** | Claude Code | Asks once at the limit, then continues the same session. `/rewake` sends messages later. If you close it at the limit first, `agent-rewake continue` continues the closed session (macOS, Linux) | Preview, tried on a Mac; the closed-session part isn't tried against a real limit |
| | Codex | Type `rewake` at the limit; the thread continues after the reset | Preview, limit not tried by hand yet |
| | GitHub Copilot CLI, Gemini CLI, Grok Build | Continues a closed session after the reset (`agent-rewake continue`, or on its own) | Preview, tried on a Mac |
| | Antigravity CLI | The same | Preview, not tried yet |
| **VS Code, Cursor** | Claude Code's panel | The same as in a terminal: the same plugin loads there | Preview, tried on a Mac |
| | Codex's extension | Rewake's hooks show up there, waiting to be trusted; the rest isn't tried yet | Not tried yet |
| | Cursor's own agent | At a usage limit, continues the chat at the time you choose (within 4 hours), while its window stays open | Preview, limit not tried yet |
| **Zed** | Claude Agent, Codex, Gemini CLI, GitHub Copilot, OpenCode, goose and every other external agent | Resumes the thread at the reset; a **Rewake** menu, scheduled and repeating messages, a schedules page | In daily use |
| **JetBrains IDEs, Devin Desktop** | Claude Agent, Codex (picked in AI Assistant or the agent selector) | Resumes after a limit while the IDE stays open, through the same add-on as in Zed | Preview, not tried yet |

Not supported yet: GitHub Copilot's own chat in VS Code. The Claude desktop app's Code tab: Rewake's plugin has code for it (it always asks first), but it hasn't been tried. Out of reach: claude.ai, the Claude desktop app's chat and Zed's own built-in agent, which let no add-on in.

Guides for each: [Claude Code](https://codizelabs.github.io/agent-rewake/docs/#claude-code) · [Codex](https://codizelabs.github.io/agent-rewake/docs/#codex) · [Copilot CLI](https://codizelabs.github.io/agent-rewake/docs/#github-copilot-cli) · [Gemini CLI](https://codizelabs.github.io/agent-rewake/docs/#gemini-cli) · [Grok Build](https://codizelabs.github.io/agent-rewake/docs/#grok-build) · [Antigravity CLI](https://codizelabs.github.io/agent-rewake/docs/#antigravity-cli) · [Cursor](https://codizelabs.github.io/agent-rewake/docs/#cursor) · [Zed](https://codizelabs.github.io/agent-rewake/docs/#zed)

## Quick start

```sh
npx @codizelabs/agent-rewake install
```

`install` shows what it found on your computer (each coding agent, your editors, Zed) and what Rewake does in each. Tick the places you want, see every change together, and answer once; one line per place then gives its next step, for example:

- **Claude Code** (terminal, VS Code, Cursor): start a new session.
- **Codex**: open it once and trust Rewake's hooks when it says "Hooks need review".
- **Copilot CLI, Gemini CLI, Grok Build, Antigravity CLI**: start a new session.
- **Zed, JetBrains, Devin Desktop**: restart the app (below for Zed).

**In Zed,** `install` lists the agents it will add Rewake to. Each settings file is backed up first, and your comments and settings are kept. Then **quit Zed completely and open it again** (⌘Q on macOS, Ctrl+Q on Linux; on Windows, close every Zed window), open the **Agent Panel**, and open or start a thread with one of your agents. Zed starts Rewake with that thread, not when Zed itself starts. A **Rewake** menu now sits under the message box, next to the model picker.

If you have no external agents yet, `install` offers to add **Claude Agent**: pick it in the Agent Panel and sign in with your Claude account.

Check the setup at any time. `doctor` looks at every place you set up (Zed and its agents, each preview), sign-in, your scheduled messages and recent problems, and says in plain words what's left to do. It works offline and prints no folders, accounts or keys:

```sh
npx @codizelabs/agent-rewake doctor
```

`doctor --json` prints the same findings for scripts, and `doctor --report` writes one redacted text file for a bug report (your home folder as `~`, session ids hashed, no message text; nothing is sent). `agent-rewake history` says what happened to your messages and resumes lately, `agent-rewake <command> --help` shows a command's options, and `agent-rewake completion <bash|zsh|fish>` prints a shell completion script. `doctor` also says how long ago this version was installed and how to update, without going online.

### Updating

From any version: run `npx @codizelabs/agent-rewake@latest install`. Previews use the new version from their next session; in Zed, quit Zed completely and open it again. Your sessions, scheduled messages and settings stay. Details, and any version-specific steps (none so far), are in the [docs](https://codizelabs.github.io/agent-rewake/docs/#update). To see which version you run: `agent-rewake --version` (in Zed also the **Rewake** menu).

### Requirements

- [Node.js](https://nodejs.org) 22 or newer
- For Zed: [Zed](https://zed.dev) 1.22 or newer, with its AI features on, and an external agent in the Agent Panel (for example Claude Agent, signed in). `install` can add Claude Agent for you
- For a preview: a recent version of that agent ([the versions](https://codizelabs.github.io/agent-rewake/docs/#outside-zed-previews))
- macOS, Linux (including Flatpak Zed) or Windows

## How it works

Rewake joins each agent the way that agent allows, and always continues the same session:

- **Inside the agent**: a plugin in Claude Code's own session (terminal, VS Code, Cursor). It sees the limit, asks, and sends the resume message itself, while Claude Code stays open. If Claude Code is closed first, Rewake continues the session the way it does for the agents below, with `claude --resume`.
- **Through the agent's hooks**: Codex, Copilot CLI, Gemini CLI, Grok Build and Antigravity CLI tell Rewake about the limit (and you say when, with `rewake`, `/rewake` or `agent-rewake continue`, unless Rewake does it on its own); at the reset your system's own timer runs Rewake once, and it continues the closed session with the agent's own resume command (Codex: its own message queue).
- **In front of the agent**: in Zed, JetBrains and Devin Desktop, the editor talks to agents over the [Agent Client Protocol](https://agentclientprotocol.com). Rewake sits on that connection and passes your messages and the agent's replies through. It adds its own menu and forms (in Zed), and sends messages into the same thread at the right time. For Claude Agent it runs its own pinned copy of the Claude adapter.

Everything runs on your computer; nothing runs in the cloud.

## Use it

In Zed, the **Rewake** menu under the message box does everything; elsewhere, type `/rewake` in the session (in Codex, `rewake` without the slash), or run `agent-rewake continue` in a terminal for a closed session.

| To… | In Zed | Elsewhere |
|---|---|---|
| Resume after a limit | **Rewake → Resume after the usage limit…** (offered automatically) | Answer Rewake's question, or type `/rewake` (or `/rewake 3:30pm`); for a closed session, `agent-rewake continue` |
| Resume automatically | **Rewake → Turn on auto-resume after limits…** | Choose "from now on" in Rewake's question, `/rewake auto on` (Claude Code only), or `agent-rewake continue --always` (every agent outside Zed, Claude Code included) |
| Schedule a message | **Rewake → Schedule a message…** | `/rewake in 3h Run the tests` (Claude Code) |
| Repeat a message | **Custom time…** in the schedule form, or `/rewake every weekday 09:00 Check the build` | Not yet |
| See or change messages | **Rewake → Schedules**, **Change a scheduled message…** | `/rewake list` and `/rewake cancel` (Claude Code, Gemini CLI; in Codex without the slash). `/rewake cancel N` deletes one message: Claude Code only |
| See what's planned | The Zed task **Agent Rewake: schedules** | `/rewake list` in the session; `agent-rewake doctor` shows the next planned resume of a closed session |

**One command everywhere:** `/rewake` is the same in Zed, Claude Code and Gemini CLI (in Codex, type `rewake` without the slash). At a usage limit it continues after the reset; `/rewake <time>` continues then, `/rewake cancel` cancels it, and `/rewake help` lists what else works where you are. Rewake answers it itself, without using the model.

Full guide: **[codizelabs.github.io/agent-rewake/docs](https://codizelabs.github.io/agent-rewake/docs/)**.

## Agents in Zed

In Zed, Rewake works the same way in front of every external agent: **Claude Agent, Codex, Gemini CLI, GitHub Copilot, OpenCode, goose** and the rest, npm-based or binary, plus custom agents. Rewake has built-in rules for how each agent it knows by name reports a limit: an error, its own error codes, or a last line such as Cursor's "Upgrade your plan to continue". When the agent says when the limit resets, in any of the formats agents use, Rewake resumes at that time; otherwise it lets you pick when. Any other agent, or a custom command, gets the general rules, and its limit may not be recognised. An agent Zed starts from neither an npm package nor a binary can't be added.

## Privacy

The whole picture, with what Rewake never does and how to undo it, is on the [privacy and security page](https://codizelabs.github.io/agent-rewake/docs/privacy-and-security/). In short:

- Runs locally. Rewake sends nothing about you anywhere, and never sees your credentials: sign-in goes through each agent's own flow. Its only network use is fetching an agent's own program (a download, or `npm install`) when Zed hasn't already done it.
- Sends only what you scheduled, approved, or turned on.
- Stores scheduled messages and per-thread settings in a private folder on your machine; logs hold metadata only (events, codes and program names), never message text.
- Keeps your message off the command line, with exceptions. When Rewake continues a closed Copilot CLI or Gemini CLI session, it hands the message to the agent on its standard input; for Grok Build, in a file only you can read. Three cases put it on a command line, where another program on your computer can read it from the process list for as long as the command runs: **Codex** (`codex queue --message <text>`), **Antigravity CLI** (`-p <text>`), and **Gemini CLI** when you've turned its sandbox on (Gemini then starts itself again with the text as an argument). Claude Code, Cursor and Zed don't use a command line for it.

## Uninstall

```sh
npx @codizelabs/agent-rewake uninstall
```

This takes Rewake out of every place it's set up in, after showing every change and asking once. `doctor --details` shows the folder where Rewake keeps its data, if you want to delete that too.

## Status

Version 0.3. Rewake's automated tests run on macOS, Linux and Windows with Node.js 22 and 24, and the author uses it daily in Zed. The previews outside Zed are new: the docs say [what's been tried for each](https://codizelabs.github.io/agent-rewake/docs/#outside-zed-previews), and what hasn't. What changed in each release is in the [changelog](https://codizelabs.github.io/agent-rewake/changelog/). Feedback and bug reports are very welcome: [open an issue](https://github.com/codizelabs/agent-rewake/issues/new/choose). If Rewake missed a usage limit, [say how](https://codizelabs.github.io/agent-rewake/docs/#report-a-limit-rewake-missed).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## Support

Agent Rewake is free and open source. If it saves you time, you can [support it on Ko-fi](https://ko-fi.com/R5R31N7TP) ☕, or star the repository so others find it.

## License

[Apache-2.0](LICENSE) © KASHAN HAIDER · [Codize Labs](https://github.com/codizelabs)

<p align="center">
  <a href="https://github.com/codizelabs">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="site/public/images/codizelabs-logo-reversed.png">
      <img src="site/public/images/codizelabs-logo.png" alt="A Codize Labs project" width="180">
    </picture>
  </a>
</p>

<sub>Agent Rewake is an independent project, not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Google, GitHub, xAI or Zed Industries. Claude and Claude Code are trademarks of Anthropic, PBC. Zed is a trademark of Zed Industries, Inc. Other product names are trademarks of their owners.</sub>
