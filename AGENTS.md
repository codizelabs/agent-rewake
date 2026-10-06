# AGENTS.md

Agent Rewake is an add-on for the Zed editor's external agents (Agent Client Protocol). It resumes an agent thread when the agent's usage limit resets, and schedules messages into threads. TypeScript, Node.js 22+, ESM, bundled to one file with esbuild.

## Commands

```sh
npm ci
npm run check        # tsc --noEmit, biome check, vitest, build
npm run check:pack   # npm package contents
node dist/agent-rewake.js doctor
```

Docs site: `cd site && npm ci && npm run build`.

## Layout

- `src/acp/`: JSON-RPC (newline-delimited) reader/writer and the router between Zed and the agent.
- `src/adapters/`: agent launching and usage-limit recognition (Claude, Codex, Gemini and generic).
- `src/core/`: schedule store, thread settings, locks, time and cron parsing. Independent of Zed and of any specific agent.
- `src/addon.ts`: the Rewake menu, forms, scheduling and resume. `src/mcp.ts`: the agent's scheduling tools.
- `src/install.ts`, `src/wrap.ts`, `src/cli.ts`: install/uninstall, wrapping agents, the command line.
- `test/`: Vitest. `site/`: Astro Starlight landing page and the one-page docs (`site/src/content/docs/docs.mdx`).

## Rules

- Keep `src/core/` free of Zed, ACP and agent-specific code.
- Stdout carries the protocol: never print anything else there.
- No `eslint-disable`/`biome-ignore`; fix the cause. Keep dependencies minimal; the Claude adapter is a runtime dependency and must never be bundled (`scripts/check-pack.mjs`).
- Behaviour must work on macOS, Linux and Windows: use `src/util/paths.ts` for directories and `src/util/spawn.ts` to start programs.
- Every user-visible change updates `README.md`, the docs page and `CHANGELOG.md`, and is covered by tests.
- Run `npm run check` before calling work done.
