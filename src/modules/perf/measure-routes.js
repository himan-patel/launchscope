import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonFile } from '../../core/report-dir.js';
import { launchBrowser } from './capture/browser.js';
import { formatChainLine, formatRouteLine } from './console-output.js';
import { readSitemap, RouteQueue } from './discover/routes.js';
import { measureRoute } from './measure.js';
import { createSlugAllocator } from './report/paths.js';
import { buildTrace, pickRepresentativeLoad, renderTraceTree } from './trace/hop-tree.js';

const SITEMAP_TIMEOUT_MS = 10_000;

/**
 * What the rest of the run keeps about a measured route. Raw page loads are written to
 * `loads.json` and folded into the analysis right away, then released; only the
 * representative load survives, for the report's waterfall and the stress scenarios.
 *
 * @typedef {object} RouteRecord
 * @property {string} url
 * @property {string} slug Folder name under perf/routes/.
 * @property {number} depth
 * @property {'seed' | 'sitemap' | 'link'} source
 * @property {import('./trace/hop-tree.js').Trace | null} trace From the representative load.
 * @property {import('./capture/page-capture.js').PageLoad | null} representativeLoad
 * @property {boolean} hasScreenshot
 */

/**
 * Discovers and measures routes until the queue is empty, the route limit is reached, or the
 * run is interrupted.
 *
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {import('../../core/logger.js').Logger} options.logger
 * @param {string} options.perfDirectory
 * @param {AbortSignal} options.signal
 * @param {import('./analyze/index.js').RunAccumulator} options.accumulator
 * @returns {Promise<{ routes: RouteRecord[], skipped: Record<string, number> }>}
 */
export async function measureRoutes({ settings, logger, perfDirectory, signal, accumulator }) {
  const queue = await seedRouteQueue(settings, logger);
  const allocateSlug = createSlugAllocator();
  /** @type {RouteRecord[]} */
  const routes = [];
  const { browser, devices } = await launchBrowser(settings);
  // Closing the browser makes an in-flight measurement fail fast, so a stop takes effect now.
  const closeBrowser = () => {
    browser.close().catch(() => {});
  };
  signal.addEventListener('abort', closeBrowser, { once: true });

  try {
    logger.info('');
    for (let route = queue.next(); route && !signal.aborted; route = queue.next()) {
      const slug = allocateSlug(route.url);
      const routeDirectory = join(perfDirectory, 'routes', slug);
      await mkdir(routeDirectory, { recursive: true });
      let measurement;
      try {
        measurement = await measureRoute({
          browser,
          devices,
          settings,
          url: route.url,
          harPath: join(routeDirectory, 'page.har'),
        });
      } catch (error) {
        if (signal.aborted) break;
        throw error;
      }
      if (route.depth < settings.depth) {
        for (const link of measurement.links) queue.add(link, route.depth + 1, 'link');
      }

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
        await writeFile(
          join(routeDirectory, 'trace.txt'),
          `${renderTraceTree(trace).join('\n')}\n`,
        );
      }

      const summary = accumulator.addRoute({
        url: route.url,
        slug,
        depth: route.depth,
        source: route.source,
        loads: measurement.loads,
        trace,
        representativeRun: representative?.run ?? null,
      });
      routes.push({
        url: route.url,
        slug,
        depth: route.depth,
        source: route.source,
        trace,
        representativeLoad: representative,
        hasScreenshot: measurement.screenshot !== null,
      });

      logger.info(formatRouteLine(summary, logger.paint));
      const chainLine = formatChainLine(trace, logger.paint);
      if (chainLine) logger.info(chainLine);
      if (trace) {
        logger.debug(
          `Hop tree for ${route.url}:\n${renderTraceTree(trace, { maxNodes: 25 }).join('\n')}`,
        );
      }
    }
  } finally {
    signal.removeEventListener('abort', closeBrowser);
    await browser.close().catch(() => {});
  }
  if (signal.aborted) {
    logger.warn(`Stopped early: ${routes.length} route(s) were measured completely.`);
  }

  await writeJsonFile(join(perfDirectory, 'routes.json'), {
    measured: routes.map(({ url, slug, depth, source }) => ({ url, slug, depth, source })),
    skipped: queue.skipped,
  });
  return { routes, skipped: queue.skipped };
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
