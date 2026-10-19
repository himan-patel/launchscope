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
- Hop tracing for `perf`: each route's representative (median) load becomes a request tree
  (document → stylesheets/scripts → API calls) built from CDP initiators, with redirect hops,
  third-party marking, and parsed `Server-Timing` metrics. Sequential API chains
  (`await fetch(a); await fetch(b)`) are inferred from timing and call stacks, and the critical
  path to the last request is identified. Written as `trace.json` and a readable `trace.txt`.
- Route discovery for `perf`: breadth-first link crawling (`--depth`), `sitemap.xml` (including
  same-origin sitemap indexes), explicit `--routes`, `--max-routes`, and `--exclude`. Logout-like
  links, other origins, and non-page files are never visited; query-string variants are capped
  per path. `routes.json` records what was measured and why other URLs were skipped.
- `launchscope login <url>`: sign in once in a real browser window (SSO and MFA work) and save
  the session (owner-only file permissions) for `--storage-state`.
- Analysis for `perf`: per-route cold/warm distributions (p50/p75/p90/p95/p99) for Web Vitals,
  load time, requests, bytes, third-party weight, and API calls; per-endpoint statistics across
  all routes with templated paths (`/api/items/:id`), timing breakdowns, sizes, status codes,
  Server-Timing summaries, and JSON collection sizes.
- Bottleneck detection with severities (critical, warning, info), evidence, and recommendations:
  Web Vitals, slow and unstable endpoints (with the dominant Server-Timing component), large and
  oversized payloads, missing compression, duplicate calls, sequential API chains, dominant
  critical-path requests, redirects, failing routes and endpoints, page weight, request count,
  third-party weight, JavaScript errors, and static assets without long-lived caching.
- Stress testing (`--stress`): closed-loop virtual users replay each measured route's
  same-origin GET hops (document, then API calls in their real dependency order) across rising
  concurrency stages. Reports per-stage and per-hop latency distributions, throughput, errors,
  and a per-second timeline; detects the latency knee (and the hop that degrades most), the
  throughput plateau, and the breaking point. Safe by default: targets must resolve to loopback
  or private addresses unless `--allow-remote` is passed, only GET requests are sent, a circuit
  breaker stops the run when errors exceed `stress.maxErrorRate`, Ctrl+C stops gracefully, and
  requests carry an identifying User-Agent. Results in `stress/stress.json`.
- Report directory for `perf`: a self-contained `index.html` (works offline; light and dark
  themes; responsive; accessible tables) with summary tiles, ranked bottlenecks, route metrics,
  per-route screenshots, critical paths, API chains, hop trees, and request waterfalls, endpoint
  latency and bytes-by-type charts, and stress charts (latency percentiles, throughput, errors)
  with per-hop tables. Also `summary.md`, `routes.csv`, `endpoints.csv`, `stress/stages.csv`,
  `stress/hops.csv`, standalone SVG charts, and a redacted `page.har` per route (bodies omitted;
  credentials, cookies, and sensitive query parameters scrubbed). All report strings are escaped
  and CSV cells are protected against formula injection.
- Configurable budgets (`perf.budgets`), `summary.json`, `endpoints.json`, `bottlenecks.json`,
  `--json` (summary on stdout), and `--fail-on warning|critical` (exit code 1, reports still
  written).

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
