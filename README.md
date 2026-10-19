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
  <img src="https://img.shields.io/badge/status-early%20development-orange.svg" alt="Early development">
</p>

---

> **Status: early development.** The CLI foundation is in place and the performance module is
> being built now. Expect breaking changes until `1.0`.

## Why LaunchScope

Most launch problems are found by users: a dashboard that takes four seconds, an API that returns
2,000 rows to render 20, a page that falls over at 50 concurrent visitors. LaunchScope runs those
checks for you, against a live site or the app on your laptop, and writes an organized report you
can act on or hand to a client.

- **Runs locally.** No account, no API key, no telemetry. Nothing leaves your machine except
  requests to the site you are checking.
- **Safe by default.** Stress tests only target local and private addresses unless you explicitly
  opt in, and only send read-only requests.
- **Reports you can share.** Cookies, tokens, and response bodies are kept out of report files.
- **CI friendly.** JSON output on stdout, human-readable progress on stderr, and stable exit codes.

## Roadmap

| Module       | Status          | What it checks                                                                         |
| ------------ | --------------- | -------------------------------------------------------------------------------------- |
| `perf`       | **In progress** | Every route and API hop, timing breakdowns, payload sizes, bottlenecks, stress testing |
| `seo`        | Planned         | Meta and Open Graph tags, sitemap and robots.txt, canonical URLs, structured data      |
| `security`   | Planned         | Security headers, TLS and certificates, exposed files, cookie flags, mixed content     |
| `a11y`       | Planned         | Automated WCAG checks on every route, keyboard and contrast issues                     |
| `compliance` | Planned         | Privacy and terms pages, consent before tracking, third-party data flows               |
| `domain`     | Planned         | SPF, DKIM, and DMARC records, DNS health, domain and certificate expiry                |

The performance module will trace each route's full request tree (document → scripts → API calls
→ redirects, plus server-side timings via `Server-Timing`), run each route multiple times for
p50/p95 numbers, detect bottlenecks such as slow endpoints, oversized payloads, duplicate calls, and
sequential API chains, and stress test routes under increasing concurrency. Results land in a
timestamped report directory with an HTML report, charts, JSON, and CSV.

## Installation

LaunchScope is not on npm yet. To try the current build from source:

```sh
git clone https://github.com/himan-patel/launchscope.git
cd launchscope
npm ci
npm link        # makes the `launchscope` command available globally
```

Requires Node.js 22.12 or newer.

## Usage

```sh
launchscope --help          # commands and global options
launchscope modules         # available and planned check modules
launchscope modules --json  # the same, as JSON on stdout
```

### Global options

| Option                   | Description                                         |
| ------------------------ | --------------------------------------------------- |
| `-c, --config <path>`    | Config file (default: `launchscope.config.json`)    |
| `-o, --output-dir <dir>` | Report directory (default: `launchscope-reports/`)  |
| `--no-color`             | Disable colored output (`NO_COLOR` is also honored) |
| `-q, --quiet`            | Only print errors                                   |
| `--verbose`              | Print debug details                                 |

### Configuration

Settings can live in `launchscope.config.json` in the directory you run from. Each module reads
its own section. String values can reference environment variables, so secrets stay out of the
file:

```json
{
  "outputDir": "launchscope-reports",
  "perf": {
    "headers": { "Authorization": "Bearer ${STAGING_API_TOKEN}" }
  }
}
```

A referenced variable that is not set is an error, never a silent empty string.

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
