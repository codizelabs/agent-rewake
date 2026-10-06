# Contributing to Agent Rewake

Thanks for your interest! Bug reports, fixes and ideas are all welcome.

## Before you start

- **Bugs and small fixes:** open a pull request directly.
- **New features or behaviour changes:** open an issue first so we can agree on the approach. Agent Rewake works within what Zed and the [Agent Client Protocol](https://agentclientprotocol.com) allow, and some ideas aren't possible from an add-on.
- Issues labelled `good first issue` or `help wanted` are open to anyone. Comment that you're working on one so nobody duplicates it.

## Development

Requirements: Node.js 22 or newer and npm.

```sh
git clone https://github.com/codizelabs/agent-rewake.git
cd agent-rewake
npm ci
npm run check        # type-check, lint, tests, build
npm run check:pack   # what the npm package would contain
```

`npm run build` writes the single-file bundle to `dist/agent-rewake.js`. To try your build in Zed, run `node dist/agent-rewake.js install`, quit Zed completely and reopen it. `node dist/agent-rewake.js uninstall` restores your agents.

The docs site lives in `site/` (Astro Starlight): `cd site && npm ci && npm run dev`, then open <http://localhost:4321/agent-rewake/>.

### Layout

| Path | What it is |
|---|---|
| `src/acp/` | JSON-RPC line reader/writer and the router between Zed and the agent |
| `src/adapters/` | Launching agents and recognising their usage limits |
| `src/core/` | Schedules, settings, locks, time and cron parsing |
| `src/ui/` | The schedules page (terminal UI) |
| `src/addon.ts` | The menu, forms, scheduling and resume logic |
| `src/cli.ts`, `src/install.ts` | Command line, `install` / `uninstall` |
| `test/` | Vitest tests; `e2e.test.ts` runs the built bundle |
| `site/` | Landing page and docs |

## Pull requests

- Keep each pull request to one concern, with a clear title: it becomes the commit message.
- Add tests for behaviour changes, and update the docs (`README.md`, `site/src/content/docs/docs.mdx`, `CHANGELOG.md`) when something users see changes.
- Branch names: `<type>/<description>`, for example `fix/missed-repeat-runs`. Types: `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`, `test`, `perf`, `release`.
- All checks must pass: tests on macOS, Linux and Windows, lint, docs and the site build.

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache-2.0 license](LICENSE).

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
