<p align="center">
  <img src="docs/assets/logo.svg" width="72" height="72" alt="LaunchScope logo">
</p>

<h1 align="center">LaunchScope</h1>

<p align="center">
  <strong>Launch-readiness checks for web apps.</strong><br>
  Performance first: trace every route and API hop, pinpoint bottlenecks with real metrics, and
  stress test before you ship.
</p>

<p align="center">
  <a href="https://github.com/himan-patel/launchscope/actions/workflows/ci.yml"><img src="https://github.com/himan-patel/launchscope/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-339933.svg" alt="Node.js 22.19 or newer">
  <img src="https://img.shields.io/badge/version-0.3.0-4f46e5.svg" alt="Version 0.3.0">
</p>

---

Most launch problems are found by users: a dashboard that takes four seconds, an API that returns
2,000 rows to render 20, a page that falls over at 50 concurrent visitors. LaunchScope finds them
first, against a live site or the app on your laptop, and writes an organized report you can act
on or hand to a client.

```sh
launchscope perf http://localhost:3000
```

```text
  ✔ /dashboard  200 · TTFB 120 ms · LCP 1.92 s · 41 requests · 1.12 MB
      ↳ sequential API chain: 3 calls, 840 ms

Bottlenecks · 1 critical, 3 warning, 2 info
  ● GET /api/projects returns 2,000 items in one response
  ● /dashboard waits on 3 sequential API calls (840 ms)
  ● Latency 3.9× higher at 16 concurrent users; GET /api/slow degrades most

✔ Report: ./launchscope-reports/localhost-3000_2026-10-19_04-36-47Z/perf/index.html
```

## What it does

- **Measures every route in a real browser.** Discovers routes from your sitemap, links, source
  code (Next.js, SvelteKit, Nuxt, Astro, Remix, Angular, React Router, Express; each source route
  is verified against the live app), or a list; loads each one
  several times with a cold cache; and records Web Vitals (TTFB, FCP, LCP, CLS, TBT, TTI) plus every
  request: DNS, connect, TLS, server wait, and download times, sizes, status, and caching.
- **Traces every hop.** Builds each page's request tree (document → scripts → API calls), detects
  API calls that wait on each other, follows redirects, splits GraphQL by operation, tracks
  WebSockets, streams, and iframes, reads `Server-Timing`, and can send W3C `traceparent` headers
  so your tracing backend shows the database and service calls behind each page load.
- **Covers what pages don't call.** Measures GET endpoints from your OpenAPI spec or your routes
  directly, and measures client-side navigations in single-page apps the way users click.
- **Finds bottlenecks from real numbers.** Slow and unstable endpoints, oversized and
  uncompressed payloads, duplicate calls, sequential API waterfalls, slow navigations, heavy
  pages, failing calls, missing caching, Web Vitals over budget, and regressions against a
  previous run, each with evidence and a recommendation.
- **Stress tests the routes.** Replays each route's requests in their real order with rising
  concurrency or a fixed arrival rate and reports the latency knee, the hop that degrades first,
  capacity, and the breaking point. Local and private targets only unless you opt in; exports k6
  scripts for bigger tests.
- **Checks other browsers and Lighthouse.** Optional Firefox/WebKit comparison and Lighthouse
  scores per route.
- **Writes a report you can share.** A self-contained HTML report with waterfalls and charts,
  plus JSON, CSV, Markdown, SVG, and redacted HAR files, organized per run.
- **Fits CI.** `--fail-on`, `--baseline latest`, `--json`, budgets and a JSON Schema for the
  config file, graceful Ctrl+C/SIGTERM, and tests on Linux, macOS, and Windows.

## Quick start

Requires Node.js 22.19 or newer (the repo pins 22.23.3 in `.nvmrc`; see
[Node.js version](docs/perf.md#nodejs-version) for nvm, nvm-windows, fnm, and Volta).
Run `launchscope doctor` to verify your setup.

```sh
git clone https://github.com/himan-patel/launchscope.git
cd launchscope
nvm install && nvm use            # Node.js 22.23.3 from .nvmrc (Windows: see below)
npm ci
npm link                          # makes `launchscope` available everywhere
npx playwright install chromium   # or use --browser-channel chrome with an installed Chrome
launchscope doctor                # verifies Node.js, browsers, Lighthouse, and the output folder
```

Then, with your app running:

```sh
launchscope perf http://localhost:3000                         # discover and measure routes
launchscope perf http://localhost:3000 --routes /,/dashboard   # just these routes
launchscope perf http://localhost:3000 --stress                # add a stress test
launchscope perf http://localhost:3000 --spa --repo .          # client-side navigations + routes from source
launchscope perf http://localhost:3000 --baseline latest --fail-on warning   # catch regressions in CI
launchscope login https://staging.example.com/login            # sign in once…
launchscope perf https://staging.example.com --storage-state .auth/session.json  # …measure signed in
```

Open the `index.html` path printed at the end.

📖 **[Full performance guide](docs/perf.md)**: recipes, every option, the configuration file,
budgets, how to read the report, bottleneck rules, stress-test safety, CI, and troubleshooting.

## The report

Each run writes a new directory; earlier runs are never overwritten.

```text
launchscope-reports/<host>_<timestamp>/perf/
├── index.html      visual report: summary, bottlenecks, routes, waterfalls, endpoints, stress
├── summary.md      Markdown summary for PRs and tickets
├── summary.json    everything, machine-readable
├── routes.csv · endpoints.csv · bottlenecks.json · endpoints.json
├── routes/<route>/ screenshot, waterfall.svg, trace (hop tree), loads, redacted HAR, Lighthouse
├── navigations.json · browsers.json · openapi.json · repo.json   (when those features are used)
└── stress/         stages, per-hop stats, charts, k6 script
```

## Principles

- **Runs locally.** No account, no API key, no telemetry. Nothing leaves your machine except
  requests to the site you are checking.
- **Safe by default.** Stress tests only target local and private addresses unless you pass
  `--allow-remote`, and only send GET requests to the target origin unless you allowlist specific
  writes with `--stress-replay`.
- **Reports you can share.** Response bodies are never stored; cookies, tokens, and auth headers
  are redacted; extra headers are only sent to the target origin.
- **Evidence over opinions.** Every finding cites the measurements behind it. API chains are
  observed in the page (which response handler issued which request), not guessed from timing.

## Roadmap

| Module       | Status        | What it checks                                                                         |
| ------------ | ------------- | -------------------------------------------------------------------------------------- |
| `perf`       | **Available** | Every route and API hop, timing breakdowns, payload sizes, bottlenecks, stress testing |
| `seo`        | Planned       | Meta and Open Graph tags, sitemap and robots.txt, canonical URLs, structured data      |
| `security`   | Planned       | Security headers, TLS and certificates, exposed files, cookie flags, mixed content     |
| `a11y`       | Planned       | Automated WCAG checks on every route, keyboard and contrast issues                     |
| `compliance` | Planned       | Privacy and terms pages, consent before tracking, third-party data flows               |
| `domain`     | Planned       | SPF, DKIM, and DMARC records, DNS health, domain and certificate expiry                |

`launchscope modules` prints the same list.

## Command overview

| Command                   | Purpose                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `launchscope perf <url>`  | Measure routes, trace hops, find bottlenecks, optionally stress test ([guide](docs/perf.md)) |
| `launchscope login <url>` | Sign in once in a browser window and save the session for `--storage-state`                  |
| `launchscope modules`     | List available and planned check modules (`--json` supported)                                |

Global options go before the command: `-c, --config <path>`, `-o, --output-dir <dir>`,
`--no-color` (`NO_COLOR` is also honored), `-q, --quiet`, `--verbose`.

### Configuration

Settings can live in `launchscope.config.json`. Each module reads its own section, and strings
can reference environment variables so secrets stay out of the file:

```json
{
  "perf": {
    "routes": ["/", "/pricing", "/app"],
    "runs": 5,
    "headers": { "Authorization": "Bearer ${STAGING_API_TOKEN}" },
    "budgets": { "lcpMs": 2000, "apiP95Ms": 400 }
  }
}
```

See the [configuration reference](docs/perf.md#configuration-file) and
[`examples/`](examples/) for a full config and a GitHub Actions workflow.

### Exit codes

| Code  | Meaning                                                             |
| ----- | ------------------------------------------------------------------- |
| `0`   | Success                                                             |
| `1`   | Checks ran and at least one crossed a failure threshold             |
| `2`   | Invalid command, option, target, or configuration                   |
| `70`  | Unexpected internal error (please [open an issue][new-issue])       |
| `130` | Interrupted (Ctrl+C or SIGTERM); a partial report was still written |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and how
check modules plug in, and [docs/architecture.md](docs/architecture.md) for the design.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public
issues.

## License

[MIT](LICENSE) © Himan Patel

[new-issue]: https://github.com/himan-patel/launchscope/issues/new/choose
