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
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-339933.svg" alt="Node.js 22.12 or newer">
  <img src="https://img.shields.io/badge/version-0.2.0-4f46e5.svg" alt="Version 0.2.0">
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

- **Measures every route in a real browser.** Discovers routes from your sitemap and links (or
  takes a list), loads each one several times with a cold cache, and records Web Vitals (TTFB,
  FCP, LCP, CLS, TBT) plus every request: DNS, connect, TLS, server wait, and download times,
  compressed and decoded sizes, status, and caching.
- **Traces every hop.** Builds each page's request tree (document → scripts → API calls), detects
  API calls that wait on each other, follows redirects, reads `Server-Timing` for backend hops,
  and finds the critical path that decides when the page is done.
- **Finds bottlenecks from real numbers.** Slow and unstable endpoints, oversized and
  uncompressed payloads, duplicate calls, sequential API waterfalls, heavy pages, failing calls,
  missing caching, and Web Vitals over budget, each with evidence and a recommendation.
- **Stress tests the routes.** Replays each route's API calls in their real order with rising
  concurrency and reports the latency knee, the hop that degrades first, the throughput plateau,
  and the breaking point. Local and private targets only unless you opt in.
- **Writes a report you can share.** A self-contained HTML report with waterfalls and charts,
  plus JSON, CSV, Markdown, SVG, and redacted HAR files, organized per run.
- **Fits CI.** `--fail-on critical` exits 1, `--json` prints the summary, and budgets live in a
  config file.

## Quick start

Requires Node.js 22.12 or newer.

```sh
git clone https://github.com/himan-patel/launchscope.git
cd launchscope
npm ci
npm link                          # makes `launchscope` available everywhere
npx playwright install chromium   # or use --browser-channel chrome with an installed Chrome
```

Then, with your app running:

```sh
launchscope perf http://localhost:3000                         # discover and measure routes
launchscope perf http://localhost:3000 --routes /,/dashboard   # just these routes
launchscope perf http://localhost:3000 --stress                # add a stress test
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
├── routes/<route>/ screenshot, waterfall.svg, trace (hop tree), loads, redacted HAR
└── stress/         stages, per-hop stats, latency and throughput charts
```

## Principles

- **Runs locally.** No account, no API key, no telemetry. Nothing leaves your machine except
  requests to the site you are checking.
- **Safe by default.** Stress tests only target local and private addresses unless you pass
  `--allow-remote`, and only send GET requests to the target origin.
- **Reports you can share.** Response bodies are never stored; cookies, tokens, and auth headers
  are redacted; extra headers are only sent to the target origin.
- **Evidence over opinions.** Every finding cites the measurements behind it, and inferred
  results (like API chains) are labeled as inferred.

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

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| `0`  | Success                                                       |
| `1`  | Checks ran and at least one crossed a failure threshold       |
| `2`  | Invalid command, option, target, or configuration             |
| `70` | Unexpected internal error (please [open an issue][new-issue]) |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and how
check modules plug in, and [docs/architecture.md](docs/architecture.md) for the design.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public
issues.

## License

[MIT](LICENSE) © Himan Patel

[new-issue]: https://github.com/himan-patel/launchscope/issues/new/choose
