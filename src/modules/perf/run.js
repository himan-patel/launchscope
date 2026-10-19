import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatBytes, formatDuration } from '../../core/duration.js';
import { createRunDirectory, writeJsonFile } from '../../core/report-dir.js';
import { summarize } from './analyze/stats.js';
import { launchBrowser } from './capture/browser.js';
import { readSitemap, RouteQueue } from './discover/routes.js';
import { measureRoute } from './measure.js';
import { createSlugAllocator } from './report/paths.js';
import { toReportableSettings } from './settings.js';
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

  if (settings.dryRun) {
    logger.success(`Dry run: settings resolved and written to ${perfDirectory}`);
    return;
  }

  const queue = await seedRouteQueue(settings, logger);
  const allocateSlug = createSlugAllocator();
  /** @type {RouteResult[]} */
  const results = [];
  const { browser, devices } = await launchBrowser(settings);

  try {
    logger.info('');
    for (let route = queue.next(); route; route = queue.next()) {
      const measurement = await measureRoute({ browser, devices, settings, url: route.url });
      if (route.depth < settings.depth) {
        for (const link of measurement.links) queue.add(link, route.depth + 1, 'link');
      }

      const slug = allocateSlug(route.url);
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

  logger.info('');
  const skipped = Object.entries(queue.skipped)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
  logger.info(
    `Measured ${results.length} route(s)${skipped ? logger.paint.dim(` · skipped: ${skipped}`) : ''}`,
  );
  logger.success(`Report directory: ${perfDirectory}`);
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
