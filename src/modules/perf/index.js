import { Option } from 'commander';
import { registerApi } from './api-command.js';
import { collect, onlyExplicitOptions } from './cli-options.js';
import { PERF_DEFAULTS, resolvePerfSettings } from './settings.js';
import { runPerf } from './run.js';

/** @typedef {import('./settings.js').PerfCliOptions} PerfCliOptions */

/**
 * Registers `launchscope perf <target>` and its browserless sibling, `launchscope api <target>`.
 *
 * @param {import('commander').Command} program
 * @param {import('../registry.js').ModuleServices} services
 */
export function registerPerf(program, services) {
  program
    .command('perf')
    .description('measure every route and API hop, find bottlenecks, and stress test')
    .argument('<target>', 'URL of the app, e.g. http://localhost:3000 or https://example.com')
    .optionsGroup('Routes:')
    .option('-r, --routes <paths>', 'comma-separated routes to measure, e.g. /,/pricing,/app')
    .option('--max-routes <n>', `maximum routes to measure (default: ${PERF_DEFAULTS.maxRoutes})`)
    .option(
      '--endpoint <spec>',
      'also measure this endpoint directly: "/api/health" or "POST /api/search @body.json" (repeatable)',
      collect,
    )
    .option(
      '--import <file>',
      'also measure the API requests recorded in a HAR file (repeatable)',
      collect,
    )
    .option('--import-writes', 'also import recorded POST/PUT/PATCH requests, with their bodies')
    .option(
      '--openapi <spec>',
      'also measure GET operations from an OpenAPI spec (JSON or YAML): "auto", a URL, or a file',
    )
    .option(
      '--repo <dir>',
      'also read page and API routes from the app source (Next.js, SvelteKit, Nuxt, …)',
    )
    .option('--depth <n>', `link-crawl depth from the target (default: ${PERF_DEFAULTS.depth})`)
    .option('--no-sitemap', 'do not read /sitemap.xml')
    .option('--exclude <regex>', 'skip URLs matching this pattern (repeatable)', collect)
    .optionsGroup('Measurement:')
    .option('-n, --runs <n>', `cold-cache runs per route (default: ${PERF_DEFAULTS.runs})`)
    .option('--warm-runs <n>', 'extra warm-cache runs per route (default: 0)')
    .addOption(
      new Option('--device <profile>', 'device profile (default: desktop)').choices([
        'desktop',
        'mobile',
      ]),
    )
    .addOption(
      new Option('--throttle <profile>', 'network throttling (default: none)').choices([
        'none',
        '4g',
        '3g',
      ]),
    )
    .option('--timeout <duration>', 'page load timeout (default: 30s)')
    .option('--browser-channel <name>', 'use an installed browser, e.g. chrome or msedge')
    .option(
      '--browsers <list>',
      'also compare in firefox and/or webkit, e.g. chromium,firefox,webkit',
    )
    .option('--headed', 'show the browser window while measuring')
    .option('--spa', 'also measure client-side navigations between measured routes')
    .option('--spa-max <n>', 'maximum navigations to measure with --spa (default: 20)')
    .optionsGroup('Authentication:')
    .option('--storage-state <file>', 'saved login session (see "launchscope login")')
    .option('-H, --header <header>', 'extra "Name: value" header for the target origin', collect)
    .option(
      '--trace-context',
      'send a W3C traceparent header so backend traces line up with each load',
    )
    .option(
      '--trace-url <template>',
      'link traces in the report, e.g. https://tracing.example.com/trace/{traceId}',
    )
    .optionsGroup('Stress testing:')
    .option('--stress', 'stress test the measured routes after measuring them')
    .addOption(
      new Option(
        '--stress-mode <mode>',
        'closed: users wait for responses; open: fixed arrival rate (default: closed)',
      ).choices(['closed', 'open']),
    )
    .option('--stress-stages <list>', 'concurrent users per stage (default: 1,5,10,25,50)')
    .option(
      '--stress-rates <list>',
      'open mode: route replays started per second, per stage (default: 1,5,10,25,50)',
    )
    .option('--stress-duration <duration>', 'duration of each stage (default: 10s)')
    .option('--stress-timeout <duration>', 'per-request timeout under stress (default: 10s)')
    .option(
      '--stress-replay <regex>',
      'also replay same-origin POST/PUT/PATCH requests whose path matches (repeatable)',
      collect,
    )
    .option('--stress-include-assets', 'also replay same-origin scripts, styles, and images')
    .option('--allow-remote', 'allow stress testing a public host you own (use with care)')
    .optionsGroup('Output:')
    .option('--json', 'print the summary as JSON to stdout')
    .option('--dry-run', 'validate options and config without opening a browser')
    .option('--export-k6', 'also write a k6 load-test script built from the measured routes')
    .option('--lighthouse', 'also run Google Lighthouse on each route (npm install lighthouse)')
    .option(
      '--baseline <run>',
      'compare with an earlier run: "latest" or a path to its summary.json',
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
        });
        await runPerf(settings, runtime);
      },
    );

  registerApi(program, services);
}
