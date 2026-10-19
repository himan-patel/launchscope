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
├── core/                 Shared building blocks with no knowledge of specific modules.
│   ├── brand.js          Product name, command, version, links.
│   ├── config.js         Loads launchscope.config.json, resolves ${ENV} references.
│   ├── errors.js         Exit codes and user-facing error types.
│   ├── logger.js         stderr logger with levels and NO_COLOR/FORCE_COLOR support.
│   ├── report-dir.js     Timestamped run directories and atomic JSON writes.
│   └── target.js         Target URL parsing and loopback/private/public host scope.
└── modules/
    └── registry.js       Every check module, shipped or planned (doubles as the roadmap).
test/                     End-to-end tests that run the real CLI binary.
```

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
