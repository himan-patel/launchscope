# Contributing to LaunchScope

Thanks for helping make launches less stressful. This guide covers setup, conventions, and the
pull request process.

## Development setup

Requirements: Node.js 22.19 or newer and npm. The repo pins **22.23.3** in `.nvmrc` and
`.node-version`: run `nvm install && nvm use` (macOS/Linux), `nvm install 22.23.3 && nvm use 22.23.3`
(nvm-windows), or `fnm use` (any OS). `npm ci` refuses other unsupported versions
(`engine-strict`), and `launchscope doctor` verifies the whole setup.

```sh
git clone https://github.com/himan-patel/launchscope.git
cd launchscope
npm ci
npm start -- --help   # run the CLI from source
```

## Scripts

| Command                 | What it does                                             |
| ----------------------- | -------------------------------------------------------- |
| `npm test`              | Run all tests with the built-in `node:test` runner       |
| `npm run test:coverage` | Run tests with coverage                                  |
| `npm run lint`          | ESLint                                                   |
| `npm run format`        | Format with Prettier                                     |
| `npm run typecheck`     | Type-check the JavaScript sources (JSDoc + TypeScript)   |
| `npm run check`         | Everything CI runs: lint, format check, types, and tests |

Run `npm run check` before opening a pull request.

## Conventions

- **JavaScript with JSDoc types.** Source is plain ES modules with JSDoc annotations, checked by
  TypeScript in strict mode. There is no build step.
- **Tests next to code.** `src/core/config.js` is covered by `src/core/config.test.js`. End-to-end
  tests that run the real CLI live in `test/`. New behavior and bug fixes need tests.
- **stdout is for data, stderr is for people.** Use the logger for progress and messages; only
  machine-readable output goes to stdout.
- **Expected errors are `UsageError` or `LaunchScopeError`.** They print a clean message and a
  hint instead of a stack trace.
- **Dependencies are deliberate.** Prefer Node built-ins. New runtime dependencies need a reason
  in the pull request description.

## Adding a check module

Check modules live in `src/modules/` and are listed in `src/modules/registry.js`. Read the module
contract in [docs/architecture.md](docs/architecture.md#check-module-contract) before starting,
and open an issue first for new modules so the scope can be agreed.

## Commits and pull requests

- Branch from `main` and keep pull requests focused on one change.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for
  example `feat(perf): add request waterfall` or `fix(config): reject empty outputDir`.
- Update `CHANGELOG.md` under **Unreleased** for user-facing changes.
- Update the README and docs when behavior, options, or output change.
- CI must pass before merge. It runs on Ubuntu (Node 22 and 24), macOS, and Windows, so avoid
  platform assumptions: build file paths with `node:path`, but always use `/` in report links.

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/himan-patel/launchscope/issues/new/choose). Report
security issues privately as described in [SECURITY.md](SECURITY.md).
