# Security policy

## Supported versions

| Version | Supported |
|---|---|
| Latest `0.x` release | Yes |
| Older `0.x` releases | No, please upgrade |

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include what an attacker could do and under what conditions, the affected version, steps to reproduce, and any suggested fix.

You can expect an acknowledgement within 7 days and an assessment within 14 days. A fix, or a mitigation plan, is agreed with you before anything is disclosed, and you'll be credited in the advisory unless you prefer not to be.

## Scope

Agent Rewake sits between Zed and a coding agent and sends messages to that agent on the user's behalf. Reports are most welcome about:

- **Credentials and sessions:** anything that exposes credentials, session tokens or environment values. Rewake never reads or stores them; sign-in passes through to the agent.
- **Process execution:** any way to make Rewake run a program other than the configured agent, or run commands through a shell.
- **Scheduled messages and local state:** ways for untrusted input to create, change or trigger scheduled messages without the user's action, or to send a message twice.
- **Logs:** any leak of prompts, code or file contents into logs or state files (logs hold metadata only).
- **Untrusted content:** any way repository files, agent output or web content can change what Rewake sends or when, for example by faking a usage-limit reset time.
- **Permissions:** Rewake never approves an agent's permission requests. Report anything that does.

**Out of scope:** vulnerabilities in Zed, the agents or their adapters (report those upstream), and attacks that need code already running as the same OS user.

## Safe use

Rewake acts with your privileges and your agent account while you may be away. Schedule only messages you'd be comfortable having sent unattended, and check the agent's permission settings before turning on automatic resume.
