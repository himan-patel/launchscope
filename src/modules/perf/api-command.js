import { Option } from 'commander';
import { collect, onlyExplicitOptions } from './cli-options.js';
import { PERF_DEFAULTS, resolvePerfSettings } from './settings.js';
import { runPerf } from './run.js';

/** @typedef {import('./settings.js').PerfCliOptions} PerfCliOptions */

/**
 * Registers `launchscope api <target>`: the perf pipeline without a browser. Endpoints come
 * from `--endpoint`, an OpenAPI spec, or the repository, and are measured directly over HTTP,
 * then flow into the same endpoint statistics, findings, stress test, baseline comparison, and
 * report as `launchscope perf`. It reads the `perf` config section, so headers, budgets, and
 * stress settings are shared.
 *
 * @param {import('commander').Command} program
 * @param {import('../registry.js').ModuleServices} services
 */
export function registerApi(program, services) {
  program
    .command('api')
    .description('measure API endpoints directly (no browser), find bottlenecks, and stress test')
    .argument('<target>', 'base URL of the API, e.g. http://localhost:3000')
    .optionsGroup('Endpoints:')
    .option(
      '--endpoint <spec>',
      'endpoint to measure: "/api/health", or "POST /api/search @body.json" (repeatable)',
      collect,
    )
    .option(
      '--openapi <spec>',
      'measure GET operations from an OpenAPI JSON spec: "auto", a URL, or a file (default: auto when nothing is listed)',
    )
    .option('--repo <dir>', 'also read GET API routes from the app source (Next.js, Express, …)')
    .optionsGroup('Measurement:')
    .option('-n, --runs <n>', `calls per endpoint (default: ${PERF_DEFAULTS.runs})`)
    .option('--timeout <duration>', 'per-request timeout (default: 30s)')
    .optionsGroup('Authentication:')
    .option('--storage-state <file>', 'saved login session (see "launchscope login")')
    .option('-H, --header <header>', 'extra "Name: value" header for the target origin', collect)
    .optionsGroup('Stress testing:')
    .option('--stress', 'stress test the measured endpoints after measuring them')
    .addOption(
      new Option(
        '--stress-mode <mode>',
        'closed: users wait for responses; open: fixed arrival rate (default: closed)',
      ).choices(['closed', 'open']),
    )
    .option('--stress-stages <list>', 'concurrent users per stage (default: 1,5,10,25,50)')
    .option(
      '--stress-rates <list>',
      'open mode: endpoint rounds started per second, per stage (default: 1,5,10,25,50)',
    )
    .option('--stress-duration <duration>', 'duration of each stage (default: 10s)')
    .option('--stress-timeout <duration>', 'per-request timeout under stress (default: 10s)')
    .option(
      '--stress-replay <regex>',
      'also replay listed POST/PUT/PATCH endpoints whose path matches, with their bodies (repeatable)',
      collect,
    )
    .option('--allow-remote', 'allow stress testing a public host you own (use with care)')
    .optionsGroup('Output:')
    .option('--json', 'print the summary as JSON to stdout')
    .option('--dry-run', 'validate options and config without calling the API')
    .option('--export-k6', 'also write a k6 load-test script for the measured endpoints')
    .option(
      '--baseline <run>',
      'compare with an earlier API run: "latest" or a path to its summary.json',
    )
    .addOption(
      new Option('--fail-on <level>', 'exit 1 if a bottleneck at this level is found').choices([
        'none',
        'warning',
        'critical',
      ]),
    )
    .action(
      async (/** @type {string} */ target, /** @type {PerfCliOptions} */ options, command) => {
        const runtime = await services.resolveRuntime(command);
        const settings = resolvePerfSettings({
          target,
          cli: onlyExplicitOptions(options, command),
          config: runtime.config.values.perf,
          cwd: runtime.io.cwd,
          mode: 'api',
        });
        await runPerf(settings, runtime);
      },
    );
}
