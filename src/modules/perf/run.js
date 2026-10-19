import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAND } from '../../core/brand.js';
import { formatBytes, formatDuration } from '../../core/duration.js';
import { ExitCode, LaunchScopeError } from '../../core/errors.js';
import { createRunDirectory, writeJsonFile } from '../../core/report-dir.js';
import { SEVERITY_ORDER, sortFindings } from './analyze/bottlenecks.js';
import { analyzeRun, countBySeverity } from './analyze/index.js';
import { summarize } from './analyze/stats.js';
import { launchBrowser } from './capture/browser.js';
import { readSitemap, RouteQueue } from './discover/routes.js';
import { measureRoute } from './measure.js';
import { createSlugAllocator } from './report/paths.js';
import { writeReport } from './report/write-report.js';
import { toReportableSettings } from './settings.js';
import { analyzeStress } from './stress/analyze.js';
import { runStress } from './stress/runner.js';
import { assertStressAllowed } from './stress/safety.js';
import { buildScenarios, loadCookieJar } from './stress/scenario.js';
import { buildTrace, pickRepresentativeLoad, renderTraceTree } from './trace/hop-tree.js';

const SITEMAP_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} RouteResult
 * @property {string} url
 * @property {string} slug Folder name under perf/routes/.
 * @property {number} depth
 * @property {'seed' | 'sitemap' | 'link'} source
 * @property {import('./measure.js').RouteMeasurement} measurement
 * @property {import('./trace/hop-tree.js').Trace | null} trace From the representative load.
 * @property {number | null} representativeRun
 */

/**
 * Runs the performance module end to end.
 *
 * @param {import('./settings.js').PerfSettings} settings
 * @param {import('../../runtime.js').Runtime} runtime
 * @returns {Promise<void>}
 */
export async function runPerf(settings, runtime) {
  const { logger, io } = runtime;
  logger.banner();
  logger.info(`Target   ${logger.paint.cyan(settings.targetUrl.href)} (${settings.scope})`);
  logger.info(
    `Plan     ${settings.runs} cold run(s)${settings.warmRuns ? ` + ${settings.warmRuns} warm` : ''} per route, ` +
      `${settings.device}, throttle ${settings.throttle}, timeout ${formatDuration(settings.timeoutMs)}`,
  );
  logger.info(
    `Routes   up to ${settings.maxRoutes}, crawl depth ${settings.depth}, sitemap ${settings.sitemap ? 'on' : 'off'}` +
      (settings.storageStatePath ? ', signed in via storage state' : ''),
  );

  const runDirectory = await createRunDirectory({
    outputDir: runtime.outputDir,
    cwd: io.cwd,
    targetUrl: settings.targetUrl,
  });
  const perfDirectory = join(runDirectory, 'perf');
  await mkdir(perfDirectory, { recursive: true });
  await writeJsonFile(join(perfDirectory, 'settings.json'), toReportableSettings(settings));

  if (settings.stress.enabled) {
    const safety = await assertStressAllowed({
      targetUrl: settings.targetUrl,
      allowRemote: settings.stress.allowRemote,
    });
    logger.info(
      `Stress   stages ${settings.stress.stages.join(' → ')} concurrent users, ${formatDuration(settings.stress.stageDurationMs)} each`,
    );
    if (safety.remote) {
      logger.warn(
        `Stress testing a public host (${safety.addresses.join(', ')}). Only do this on systems you own or are authorized to test.`,
      );
    }
  }

  if (settings.dryRun) {
    logger.success(`Dry run: settings resolved and written to ${perfDirectory}`);
    return;
  }

  const startedAt = new Date();
  const queue = await seedRouteQueue(settings, logger);
  const allocateSlug = createSlugAllocator();
  /** @type {RouteResult[]} */
  const results = [];
  const { browser, devices } = await launchBrowser(settings);

  try {
    logger.info('');
    for (let route = queue.next(); route; route = queue.next()) {
      const slug = allocateSlug(route.url);
      await mkdir(join(perfDirectory, 'routes', slug), { recursive: true });
      const measurement = await measureRoute({
        browser,
        devices,
        settings,
        url: route.url,
        harPath: join(perfDirectory, 'routes', slug, 'page.har'),
      });
      if (route.depth < settings.depth) {
        for (const link of measurement.links) queue.add(link, route.depth + 1, 'link');
      }

      const result = await writeRouteArtifacts({
        perfDirectory,
        slug,
        route,
        measurement,
      });
      results.push(result);
      logger.info(formatRouteLine(measurement, logger.paint));
      const longest = result.trace?.chains[0];
      if (longest) {
        logger.info(
          logger.paint.dim(
            `      ↳ sequential API chain: ${longest.ids.length} calls, ${formatDuration(longest.totalMs)}`,
          ),
        );
      }
      if (result.trace) {
        logger.debug(
          `Hop tree for ${route.url}:\n${renderTraceTree(result.trace, { maxNodes: 25 }).join('\n')}`,
        );
      }
    }
  } finally {
    await browser.close();
  }

  await writeJsonFile(join(perfDirectory, 'routes.json'), {
    measured: results.map(({ url, slug, depth, source }) => ({ url, slug, depth, source })),
    skipped: queue.skipped,
  });

  const analysis = analyzeRun(
    results.map((result) => ({
      url: result.url,
      slug: result.slug,
      depth: result.depth,
      source: result.source,
      loads: result.measurement.loads,
      trace: result.trace,
      representativeRun: result.representativeRun,
    })),
    settings.budgets,
  );

  const stress = settings.stress.enabled
    ? await runStressPhase({ settings, results, perfDirectory, logger })
    : null;
  if (stress) {
    analysis.bottlenecks = sortFindings([...analysis.bottlenecks, ...stress.findings]);
    analysis.totals.findings = countBySeverity(analysis.bottlenecks);
  }

  const summary = {
    schemaVersion: 1,
    tool: { name: BRAND.command, version: BRAND.version },
    target: settings.targetUrl.href,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    settings: toReportableSettings(settings),
    totals: analysis.totals,
    routes: analysis.routes,
    endpoints: analysis.endpoints,
    bottlenecks: analysis.bottlenecks,
    stress: stress ? { ...stress.result, insights: stress.insights } : null,
    skippedUrls: queue.skipped,
  };
  await writeJsonFile(join(perfDirectory, 'summary.json'), summary);
  await writeJsonFile(join(perfDirectory, 'endpoints.json'), analysis.endpoints);
  await writeJsonFile(join(perfDirectory, 'bottlenecks.json'), analysis.bottlenecks);
  const report = await writeReport({
    perfDirectory,
    summary,
    details: new Map(
      results.map((result) => [
        result.slug,
        {
          trace: result.trace,
          load:
            result.measurement.loads.find(
              (load) =>
                load.cache === 'cold' &&
                load.error === null &&
                load.run === result.representativeRun,
            ) ?? null,
          files: { screenshot: result.measurement.screenshot !== null, har: true },
        },
      ]),
    ),
  });

  logger.info('');
  const skipped = Object.entries(queue.skipped)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
  logger.info(
    `Measured ${results.length} route(s), ${analysis.endpoints.length} endpoint(s)` +
      (skipped ? logger.paint.dim(` · skipped: ${skipped}`) : ''),
  );
  writeFindings(analysis.bottlenecks, logger);
  logger.success(`Report: ${logger.paint.cyan(report.html)}`);
  logger.info(logger.paint.dim(`  All files: ${perfDirectory}`));

  if (settings.json) io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  enforceFailOn(analysis.bottlenecks, settings.failOn);
}

/**
 * Replays the measured routes under increasing concurrency and writes `stress/` artifacts.
 * Ctrl+C stops the current stage and keeps what was measured so far.
 *
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {RouteResult[]} options.results
 * @param {string} options.perfDirectory
 * @param {import('../../core/logger.js').Logger} options.logger
 * @returns {Promise<{ result: import('./stress/runner.js').StressResult, insights: import('./stress/analyze.js').StressInsights, findings: import('./analyze/bottlenecks.js').Finding[] } | null>}
 */
async function runStressPhase({ settings, results, perfDirectory, logger }) {
  const { paint } = logger;
  const scenarios = buildScenarios(results, {
    targetOrigin: settings.targetUrl.origin,
    includeAssets: settings.stress.includeAssets,
  });
  if (scenarios.length === 0) {
    logger.warn('Skipping the stress test: no route loaded successfully on the target origin.');
    return null;
  }

  const cookieFor = await loadCookieJar(settings.storageStatePath);
  const controller = new AbortController();
  const onInterrupt = () => {
    logger.warn('Stopping the stress test after the current requests…');
    controller.abort();
  };
  process.once('SIGINT', onInterrupt);

  logger.info('');
  logger.info(
    paint.bold('Stress test') +
      paint.dim(
        ` · ${scenarios.length} route scenario(s), GET requests to ${settings.targetUrl.origin} only`,
      ),
  );
  let result;
  try {
    result = await runStress({
      scenarios,
      settings: settings.stress,
      headers: settings.headers,
      cookieFor,
      signal: controller.signal,
      onStage: (stage) => {
        const icon = stage.errorRate > 0 ? paint.yellow('!') : paint.green('✔');
        logger.info(
          `  ${icon} ${String(stage.concurrency).padStart(4)} users  ` +
            paint.dim(
              `${stage.requestsPerSecond.toFixed(1)} req/s · p50 ${formatDuration(stage.latencyMs?.p50 ?? Number.NaN)} · ` +
                `p95 ${formatDuration(stage.latencyMs?.p95 ?? Number.NaN)} · errors ${(stage.errorRate * 100).toFixed(1)}%`,
            ),
        );
      },
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
  if (result.stoppedReason) logger.warn(result.stoppedReason);

  const { insights, findings } = analyzeStress(result, settings.budgets);
  const stressDirectory = join(perfDirectory, 'stress');
  await mkdir(stressDirectory, { recursive: true });
  await writeJsonFile(join(stressDirectory, 'stress.json'), { ...result, insights });
  return { result, insights, findings };
}

const MAX_FINDINGS_IN_CONSOLE = 10;

/**
 * @param {import('./analyze/bottlenecks.js').Finding[]} findings
 * @param {import('../../core/logger.js').Logger} logger
 */
function writeFindings(findings, logger) {
  const { paint } = logger;
  const counts = countBySeverity(findings);
  logger.info('');
  if (findings.length === 0) {
    logger.success('No bottlenecks found within the configured budgets.');
    return;
  }
  logger.info(
    paint.bold('Bottlenecks') +
      paint.dim(` · ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info`),
  );
  const icons = {
    critical: paint.red('●'),
    warning: paint.yellow('●'),
    info: paint.dim('○'),
  };
  for (const finding of findings.slice(0, MAX_FINDINGS_IN_CONSOLE)) {
    logger.info(`  ${icons[finding.severity]} ${finding.title}`);
    logger.info(paint.dim(`      ${finding.recommendation}`));
  }
  if (findings.length > MAX_FINDINGS_IN_CONSOLE) {
    logger.info(paint.dim(`  … ${findings.length - MAX_FINDINGS_IN_CONSOLE} more in the report`));
  }
  logger.info('');
}

/**
 * Exits with code 1 (after all reports are written) when findings reach `--fail-on`.
 *
 * @param {import('./analyze/bottlenecks.js').Finding[]} findings
 * @param {import('./settings.js').FailOnLevel} failOn
 */
export function enforceFailOn(findings, failOn) {
  if (failOn === 'none') return;
  const failing = findings.filter(
    (finding) => SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[failOn],
  );
  if (failing.length > 0) {
    throw new LaunchScopeError(
      `${failing.length} bottleneck(s) at or above "${failOn}" (--fail-on ${failOn}).`,
      { exitCode: ExitCode.CHECK_FAILED },
    );
  }
}

/**
 * Seeds the queue with explicit routes (or the target) and, when enabled, the sitemap.
 *
 * @param {import('./settings.js').PerfSettings} settings
 * @param {import('../../core/logger.js').Logger} logger
 * @returns {Promise<RouteQueue>}
 */
async function seedRouteQueue(settings, logger) {
  const queue = new RouteQueue({
    targetUrl: settings.targetUrl,
    exclude: settings.exclude,
    maxRoutes: settings.maxRoutes,
  });
  const seeds = settings.routes.length > 0 ? settings.routes : [settings.targetUrl.href];
  for (const seed of seeds) queue.add(seed, 0, 'seed');

  if (settings.sitemap) {
    const sitemap = await readSitemap({
      targetUrl: settings.targetUrl,
      headers: settings.headers,
      timeoutMs: Math.min(SITEMAP_TIMEOUT_MS, settings.timeoutMs),
    });
    if (sitemap.error) logger.warn(`Could not read sitemap.xml: ${sitemap.error}`);
    let added = 0;
    for (const url of sitemap.urls) {
      // Sitemap routes are measured but not crawled further.
      if (queue.add(url, settings.depth, 'sitemap')) added += 1;
    }
    if (sitemap.urls.length > 0) {
      logger.debug(`sitemap.xml listed ${sitemap.urls.length} URL(s); queued ${added}`);
    }
  }
  return queue;
}

/**
 * @param {object} options
 * @param {string} options.perfDirectory
 * @param {string} options.slug
 * @param {import('./discover/routes.js').QueuedRoute} options.route
 * @param {import('./measure.js').RouteMeasurement} options.measurement
 * @returns {Promise<RouteResult>}
 */
async function writeRouteArtifacts({ perfDirectory, slug, route, measurement }) {
  const routeDirectory = join(perfDirectory, 'routes', slug);
  await mkdir(routeDirectory, { recursive: true });
  await writeJsonFile(join(routeDirectory, 'loads.json'), measurement.loads);
  if (measurement.screenshot) {
    await writeFile(join(routeDirectory, 'screenshot.png'), measurement.screenshot);
  }

  const representative = pickRepresentativeLoad(measurement.loads);
  const trace = representative
    ? buildTrace(representative.requests, representative.finalUrl ?? route.url)
    : null;
  if (representative && trace) {
    await writeJsonFile(join(routeDirectory, 'trace.json'), {
      representativeRun: representative.run,
      ...trace,
    });
    await writeFile(join(routeDirectory, 'trace.txt'), `${renderTraceTree(trace).join('\n')}\n`);
  }

  return {
    url: route.url,
    slug,
    depth: route.depth,
    source: route.source,
    measurement,
    trace,
    representativeRun: representative?.run ?? null,
  };
}

/**
 * @param {import('./measure.js').RouteMeasurement} measurement
 * @param {import('../../core/logger.js').Palette} paint
 * @returns {string}
 */
function formatRouteLine(measurement, paint) {
  const cold = measurement.loads.filter((load) => load.cache === 'cold');
  const failed = cold.filter((load) => load.error !== null);
  const url = new URL(measurement.url);
  const path = `${url.pathname}${url.search}`;
  if (failed.length === cold.length) {
    return `  ${paint.red('✖')} ${path}  ${paint.red(failed[0]?.error ?? 'failed')}`;
  }
  const status = cold.find((load) => load.status !== null)?.status ?? null;
  const p50 = (/** @type {Array<number | null | undefined>} */ values) => summarize(values)?.p50;
  const ttfb = p50(cold.map((load) => load.vitals?.ttfbMs));
  const lcp = p50(cold.map((load) => load.vitals?.lcpMs));
  const requests = p50(cold.map((load) => load.requests.length));
  const bytes = p50(cold.map((load) => sumTransfer(load)));
  const icon = status !== null && status >= 400 ? paint.yellow('!') : paint.green('✔');
  return (
    `  ${icon} ${path}  ` +
    paint.dim(
      `${status ?? '–'} · TTFB ${fmt(ttfb, formatDuration)} · LCP ${fmt(lcp, formatDuration)} · ` +
        `${requests ?? '–'} requests · ${fmt(bytes, formatBytes)}`,
    )
  );
}

/**
 * @param {import('./capture/page-capture.js').PageLoad} load
 * @returns {number}
 */
function sumTransfer(load) {
  return load.requests.reduce((total, request) => total + request.transferBytes, 0);
}

/**
 * @param {number | undefined} value
 * @param {(value: number) => string} format
 */
function fmt(value, format) {
  return value === undefined ? '–' : format(value);
}
