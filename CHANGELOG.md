# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `launchscope doctor`: verifies the environment by launching Chromium, Firefox, and WebKit,
  loading Lighthouse (and checking its Node.js requirement), and writing to the output directory;
  works the same on macOS, Linux, and Windows.

### Changed

- Node.js is pinned to 22.23.3 (LTS) in `.nvmrc` and `.node-version` (for fnm and Volta), npm
  refuses unsupported versions (`engine-strict`), and the minimum is now 22.19 so Lighthouse
  works on every supported Node.js. CI uses the pinned version and runs `doctor`.
- API chains are now observed, not inferred. A script installed before the page's own code
  records which request's response handler (fetch, its body methods, or XMLHttpRequest/axios
  completion handlers, including promise continuations) issued each new request. The previous
  rule ("started within 100 ms after another call finished") is gone, so calls made from timers
  or independently are no longer reported as dependent. Request records gain `causedBy`.
- TBT now follows Lighthouse's definition: long-task time beyond 50 ms between FCP and Time to
  Interactive, instead of until the end of collection. Each load waits (up to 20 s) until a 5 s
  CPU and network quiet window is observed. New `ttiMs` per load and route (report, CSV, and
  Markdown); `tbtComplete` and `tbtLowerBoundRuns` flag pages that never went quiet. Verified
  against Lighthouse's own TTI and TBT code on 500 generated loads.

## [0.3.0] - 2026-10-19

Production-ready performance module: every gap from the 0.2.0 review is closed.

### Added

- Graceful interruption for `perf`: Ctrl+C or SIGTERM during measurement or stress testing
  stops the run, writes a partial report (`"interrupted": true` in `summary.json`), and exits
  with code 130; a second signal exits immediately.
- GraphQL-aware endpoints: calls to `/graphql` are split by operation name and type (from
  `operationName` or the document; persisted and batched queries supported), so slow operations,
  duplicates, and payloads are reported per operation. Duplicate detection ignores calls whose
  variables differ. Hop trees, waterfalls, stress hops, and CSVs show the operation.
- WebSockets, server-sent events, and iframes: sockets are recorded (handshake status and time,
  frame counts and bytes, never contents), event streams are excluded from timing statistics,
  the critical path, and stress replays, and iframe requests are counted per route. New findings:
  `websocket-failed` and `iframe-weight`.

- `--baseline latest|<path>` (or `perf.baseline`) compares a run with an earlier one: per-route
  and per-endpoint before/after for timings, sizes, and requests; new and removed routes and
  endpoints; `regression` findings (10% and a per-metric minimum) that count toward `--fail-on`;
  a "Compared with baseline" report section and Markdown table.

- W3C Trace Context: `--trace-context` gives each measured page load its own trace ID and sends a
  sampled `traceparent` header (fresh span per request) to the target origin only; `--trace-url`
  (or `perf.traceContext.urlTemplate`) links each load's trace from the report.

- OpenAPI discovery: `--openapi auto|<url>|<file>` reads an OpenAPI 3.x / Swagger 2.0 JSON spec
  and measures its GET operations on the target origin directly (examples, defaults, enums, and
  `$ref` parameters supported; operations needing unknown input are skipped with reasons).
  Endpoints are labeled by how they were found, API-only endpoints are replayed by `--stress`,
  and `openapi.json` lists measured and skipped operations.

- Repository route discovery: `--repo <dir>` reads page routes from Next.js (App and Pages
  Router), SvelteKit, Nuxt, Astro, and Remix file conventions plus Angular and React Router
  route code, and GET API routes from Next.js route handlers, SvelteKit `+server` files, and
  Express. Dynamic segments come from `perf.routeParams`; routes needing unknown values are
  skipped and listed in `repo.json`.

- Client-side navigation measurement (`--spa`, `--spa-max`): clicks links between measured routes
  like a user and measures each transition from click until network and DOM settle (network and
  render split, requests, API calls, bytes, sequential API chain), detects full-page reloads,
  and adds `slow-navigation` (budget `navigationMs`), `navigation-api-chain`,
  `full-reload-navigation`, and `navigation-failed` findings plus a report section.

- Cross-browser comparison: `--browsers chromium,firefox,webkit` loads every measured route in
  Firefox and/or WebKit and compares load, LCP, and errors with Chromium in a report section and
  `browsers.json`; adds `browser-failed`, `browser-errors`, and `browser-slower` findings.
  Missing browsers are skipped with a warning.

- Open-model stress testing: `--stress-mode open --stress-rates 2,5,10` starts route replays at a
  fixed arrival rate regardless of response times, tracks peak work in flight, achieved rate, and
  replays dropped beyond `stress.maxInFlight`, and reports when the server falls behind. Charts,
  tables, CSVs, and findings label stages as users or replays per second.

- Opt-in write replay for stress tests: `--stress-replay <regex>` (or `perf.stress.replay`)
  replays matching same-origin POST/PUT/PATCH requests with the bodies captured during
  measurement (held in memory, never written to disk), with a console warning listing them.
  DELETE is never replayed; everything else stays GET-only.

- k6 export: `--export-k6` writes `stress/k6-script.js` from the measured scenarios (GET requests
  in dependency levels via `http.batch`, closed/open executors and stages, budget thresholds,
  header values from environment variables, no request bodies).

- Optional Lighthouse audits: `--lighthouse` runs Google Lighthouse once per measured route
  (mobile or desktop preset) against Playwright's Chromium, saves each HTML report, adds a report
  section, and raises `lighthouse-score` findings (budget `lighthouseScore`, lower is worse).
  Lighthouse is an optional peer dependency (`npm install lighthouse`, Node.js 22.19+).

- JSON Schema for `launchscope.config.json` (`schema/launchscope.config.schema.json`, shipped in
  the package) for editor autocomplete and validation; tests keep it in sync with the keys and
  budgets the code accepts.

### Changed

- CI runs the full suite (including real Chromium, Firefox, WebKit, and Lighthouse) on Ubuntu
  (Node 22 and 24), macOS, and Windows; line endings are normalized to LF on every platform.
- Bounded memory for large runs: each route is folded into the analysis as soon as it is measured
  and its raw loads are released, keeping only the representative load for the report and stress
  test (about 3.4× less heap on a 200-route synthetic run). `run.js` is split into
  `measure-routes.js`, `stress-phase.js`, and `console-output.js`.
- JSON payload shapes are summarized on every cold run (not only the first), so collection sizes
  reflect all measured loads.
- `stress/stages.csv` gains `mode`, `load`, `target_rate`, `achieved_rate`, and `dropped` columns;
  `stress/hops.csv` uses `load` instead of `concurrency`.
- Waterfalls show up to 150 requests (was 60) and say how many were left out; every request is
  always in `trace.json`.

### Fixed

- Lighthouse report links in the HTML report used the OS path separator and were broken on
  Windows; report links always use `/`.
- Pages with a server-sent event stream or other never-ending response no longer wait the full
  10-second settle timeout on every load.

## [0.2.0] - 2026-10-19

First release with a working check module: performance.

### Added

- Documentation: a full performance guide (`docs/perf.md`) covering install, recipes, every
  option, the configuration file, budgets, the report layout, bottleneck rules, stress-test
  safety, CI usage, measurement limits, and troubleshooting; an example config and GitHub
  Actions workflow in `examples/`; README and architecture updates.
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

### Fixed

- `--storage-state` help text and the missing-session hint now point to `launchscope login`.

[Unreleased]: https://github.com/himan-patel/launchscope/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/himan-patel/launchscope/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/himan-patel/launchscope/releases/tag/v0.2.0
