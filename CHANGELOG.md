# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `launchscope` CLI with branded help, `--version`, and global options for config, output
  directory, color, and verbosity.
- `launchscope modules` command listing available and planned check modules (`--json` supported).
- Check module registry so new areas (performance, SEO, security, accessibility, compliance,
  domain) plug into one CLI.
- `launchscope.config.json` support with `${ENV_VAR}` interpolation for secrets.
- Shared core for target URL parsing and host scope, timestamped report directories, atomic JSON
  writes, and a stderr logger honoring `NO_COLOR` and `FORCE_COLOR`.
- Stable exit codes: `0` success, `1` threshold failed, `2` usage error, `70` internal error.
- Tooling: `node:test` suite, ESLint, Prettier, TypeScript type-checking of JSDoc, GitHub Actions
  CI on Node 22 and 24, and Dependabot.
- Project docs: README, architecture overview, contributing guide, and security policy.
