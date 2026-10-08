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

The docs site lives in `site/` (Astro Starlight): `cd site && npm ci && npm run dev`, then open <http://localhost:4321/>.

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
- Open pull requests against `develop` (the default branch). `main` holds released code only.
- Branch names: `<type>/<description>`, for example `fix/missed-repeat-runs`. Types: `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`, `test`, `perf`, `release`.
- All checks must pass: tests on macOS, Linux and Windows, lint, docs and the site build.

## Releasing

Publishing is automatic, from GitHub Actions with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): there is no npm token to manage ([`publish.yml`](.github/workflows/publish.yml)).

- **Every merge into `develop`** that changes the package stages a prerelease on npm, `X.Y.Z-next.<run>` with the dist-tag `next`. It isn't installable until a maintainer approves it on npmjs.com with 2FA; approved, it installs with `npx @codizelabs/agent-rewake@next`. Reject the ones you don't need.
- **A release:** on `develop`, set the new version in `package.json` (`npm version <x.y.z> --no-git-tag-version`) and add its section to `CHANGELOG.md`. Merge that into `develop` and let the workflow stage it. Then open a pull request from `develop` into `main` and merge it with a merge commit. Its `release-gate` check only passes when the version is new, `CHANGELOG.md` has its section, and this exact code was staged from `develop` (a successful `publish` run there with the same package files). The workflow publishes that version as `latest`, tags the commit `vX.Y.Z` and creates the GitHub release from the changelog. A merge into `main` without a new version publishes nothing.

**Upgrade notes.** Updating is two steps for every version: run `npx @codizelabs/agent-rewake@latest install`, then restart Zed (docs: *Update*). A release that needs anything more from people updating must, in the same pull request:

- add an `### Upgrade notes` section to its `CHANGELOG.md` entry, saying who is affected and exactly what to do;
- add a row to the *Version-specific steps* table in `site/src/content/docs/docs.mdx`;
- teach `doctor` to detect the situation and give the fix, where it can.

That covers, for example: a higher minimum Node.js or Zed version, a renamed or removed setting or environment variable, a new format for stored messages or settings (older versions would no longer read them, so say whether going back is safe), or a change to what `install` writes into Zed's settings that `install` can't update by itself.

Maintainers set this up once: on npmjs.com, the package's **Settings → Trusted Publisher** has two GitHub Actions entries for `codizelabs/agent-rewake` and `publish.yml`: environment `npm-stage` (staged publishing only) and environment `npm` (with `npm publish` allowed). `node scripts/apply-github-settings.mjs` limits those GitHub environments to `develop` and `main`.

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache-2.0 license](LICENSE).

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
