# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `launchscope perf <target>` command with route, measurement, authentication, stress, and output
  options; settings merge CLI flags, the `perf` config section, and defaults with strict
  validation (unknown config keys are rejected). `--dry-run` validates without a browser.
- Browser capture for `perf`: each route is loaded in real Chromium (Playwright) with a fresh
  context per cold run, recording every request via the Chrome DevTools Protocol: timing phases
  (queue, DNS, connect, TLS, send, wait, download), compressed and decoded sizes, initiators,
  redirect hops, cache status, allow-listed response headers, and JSON payload shape (bodies are
  never stored). Web Vitals (TTFB, FCP, LCP, CLS, TBT) are collected in the page. Supports
  desktop/mobile profiles, 4G/3G throttling, warm-cache runs, installed browser channels, and
  extra headers sent to the target origin only. Per-route `loads.json` and `screenshot.png` are
  written to the report directory.

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
