# Architecture

LaunchScope is a Node.js command-line tool built from a small shared core and independent
**check modules**. Each module owns one area of launch readiness (performance, SEO, security, and
so on) and plugs into the same CLI, configuration, output, and reporting conventions.

## Layout

```text
bin/launchscope.js        Executable entry point. Wires real process streams into run().
src/
├── cli.js                Command tree, global options, error-to-exit-code mapping.
├── runtime.js            Resolves global options + config into a Runtime for a command.
├── commands/
│   └── login.js          `launchscope login`: save a browser session for any module.
├── core/                 Shared building blocks with no knowledge of specific modules.
│   ├── brand.js          Product name, command, version, links.
│   ├── config.js         Loads launchscope.config.json, resolves ${ENV} references.
│   ├── duration.js       Duration parsing and ms/bytes formatting.
│   ├── errors.js         Exit codes and user-facing error types.
│   ├── logger.js         stderr logger with levels and NO_COLOR/FORCE_COLOR support.
│   ├── report-dir.js     Timestamped run directories and atomic JSON writes.
│   └── target.js         Target URL parsing and loopback/private/public host scope.
└── modules/
    ├── registry.js       Every check module, shipped or planned (doubles as the roadmap).
    └── perf/             The performance module (see below).
test/                     End-to-end tests that run the real CLI binary against a fixture app.
```

## The `perf` module

```text
src/modules/perf/
├── index.js              Registers `launchscope perf <target>` and its options.
├── settings.js           CLI > config > defaults, validated at the trust boundary.
├── run.js                Orchestrates discovery → measurement → analysis → stress → report.
├── measure.js            Cold and warm runs of one route, each in a fresh browser context.
├── discover/routes.js    Breadth-first route queue, sitemap reader, URL filtering.
├── capture/
│   ├── browser.js        Chromium launch, device/throttle presets, origin-scoped headers, HAR.
│   ├── page-capture.js   One page load: navigation, network idle, vitals, links, screenshot.
│   ├── network-recorder.js  CDP events → request records (phases, sizes, initiators, redirects).
│   └── vitals.js         In-page Web Vitals observer (LCP, CLS, TBT, FCP, TTFB).
├── trace/
│   ├── hop-tree.js       Request tree, inferred API chains, critical path, text rendering.
│   └── server-timing.js  W3C Server-Timing parser.
├── analyze/
│   ├── stats.js          Percentile distributions.
│   ├── routes.js         Per-route summaries.
│   ├── endpoints.js      Per-endpoint aggregation with path templates.
│   ├── budgets.js        Default thresholds, config overrides, classification.
│   ├── bottlenecks.js    Rules that turn measurements into ranked findings.
│   └── index.js          Glue: routes + endpoints + findings + totals.
├── stress/
│   ├── safety.js         DNS-verified loopback/private target check.
│   ├── scenario.js       Route replay plans from traces; storage-state cookie jar.
│   ├── runner.js         Closed-loop virtual users, stages, circuit breaker.
│   └── analyze.js        Knee, saturation, breaking point, stress findings.
└── report/
    ├── write-report.js   Writes HTML, Markdown, CSV, and SVG files.
    ├── html.js           Self-contained HTML report.
    ├── charts.js · svg.js  Chart specs and dependency-free SVG rendering.
    ├── tables.js         CSV exports and Markdown summary.
    ├── har.js            HAR redaction.
    ├── escape.js         HTML and CSV escaping.
    └── paths.js          Route folder names.
```

Data flows one way: capture produces `PageLoad` records, tracing turns the representative load
into a `Trace`, analysis turns loads and traces into route summaries, endpoint statistics, and
findings, and the report layer only reads those results. Each layer is unit tested on its own,
and `test/perf-*.test.js` run the whole pipeline in real Chromium against
`test/fixtures/app-server.js`, a small app with deliberate problems.

Unit tests sit next to the code they cover (`*.test.js`) and run with the built-in `node:test`
runner.

## Request flow

```text
argv ──▶ bin/launchscope.js ──▶ run(argv, io)
                                  │
                                  ├─ createProgram(io)   commander tree; modules register here
                                  ├─ parseAsync(argv)    action handler runs
                                  │     └─ services.resolveRuntime(command)
                                  │           ├─ logger   (level, color)
                                  │           ├─ config   (file + ${ENV} interpolation)
                                  │           └─ outputDir (flag > config > default)
                                  └─ errors ──▶ exit code (0, 1, 2, 70)
```

`run` never calls `process.exit`. It returns an exit code, and process streams, environment, and
working directory are injected through `CliIO`, which keeps every command testable in-process.

## Check module contract

A module is an entry in `src/modules/registry.js`:

```js
{
  id: 'perf',                 // subcommand name and config section key
  title: 'Performance',
  status: 'in-progress',      // 'available' | 'in-progress' | 'planned'
  summary: 'One line shown in `launchscope modules` and the README roadmap.',
  register(program, services) {
    program
      .command('perf <target>')
      .description('…')
      .action(async (target, options, command) => {
        const runtime = await services.resolveRuntime(command);
        // validate runtime.config.values.perf, run checks, write reports
      });
  },
}
```

Rules for modules:

1. **Own your config section.** Read `runtime.config.values[id]` and validate it. The core only
   checks that it is an object.
2. **Own your output folder.** Create the run directory with `createRunDirectory` and write into a
   folder named after the module id, so several modules can share one run.
3. **Respect the output streams.** Machine-readable output (`--json`) goes to `runtime.io.stdout`.
   Progress, warnings, and errors go through `runtime.logger`, which writes to stderr.
4. **Throw `UsageError` for bad input.** Throw `LaunchScopeError` with an exit code for expected
   failures. Anything else is reported as an internal error.
5. **Be safe by default.** Never put credentials, cookies, tokens, or response bodies in reports.
   Anything that generates load must be opt-in and limited to targets the user controls.

Planned modules stay in the registry without a `register` function, so `launchscope modules` and the
README roadmap remain accurate.

## Output conventions

| Stream / artifact | Contents                                                           |
| ----------------- | ------------------------------------------------------------------ |
| stdout            | Machine-readable results only (for example `--json`)               |
| stderr            | Banner, progress, warnings, errors                                 |
| Run directory     | `<outputDir>/<host>[-port]_<UTC timestamp>/`, never reused         |
| Exit code         | `0` ok, `1` threshold failed, `2` usage error, `70` internal error |

## Security principles

- No accounts, API keys, or telemetry. The only network traffic goes to the target being checked.
- Credentials are rejected in target URLs. Secrets in config come from environment variables via
  `${NAME}` references, and a missing variable is an error.
- Host scope (`loopback`, `private`, `public`) is classified from the literal hostname. Features
  that generate load must additionally check the resolved address before sending traffic.
- Reports are written atomically, never overwrite earlier runs, and exclude sensitive headers,
  cookies, and response bodies.
