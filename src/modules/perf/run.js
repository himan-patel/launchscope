import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatBytes, formatDuration } from '../../core/duration.js';
import { createRunDirectory, writeJsonFile } from '../../core/report-dir.js';
import { summarize } from './analyze/stats.js';
import { launchBrowser } from './capture/browser.js';
import { measureRoute } from './measure.js';
import { assignRouteSlugs } from './report/paths.js';
import { toReportableSettings } from './settings.js';

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

  const routes = settings.routes.length > 0 ? settings.routes : [settings.targetUrl.href];
  const slugs = assignRouteSlugs(routes);
  const { browser, devices } = await launchBrowser(settings);

  try {
    logger.info('');
    for (const url of routes) {
      const measurement = await measureRoute({ browser, devices, settings, url });
      const slug = /** @type {string} */ (slugs.get(url));
      const routeDirectory = join(perfDirectory, 'routes', slug);
      await mkdir(routeDirectory, { recursive: true });
      await writeJsonFile(join(routeDirectory, 'loads.json'), measurement.loads);
      if (measurement.screenshot) {
        await writeFile(join(routeDirectory, 'screenshot.png'), measurement.screenshot);
      }
      logger.info(formatRouteLine(measurement, logger.paint));
    }
  } finally {
    await browser.close();
  }

  logger.info('');
  logger.success(`Report directory: ${perfDirectory}`);
}

/**
 * @param {import('./measure.js').RouteMeasurement} measurement
 * @param {import('../../core/logger.js').Palette} paint
 * @returns {string}
 */
function formatRouteLine(measurement, paint) {
  const cold = measurement.loads.filter((load) => load.cache === 'cold');
  const failed = cold.filter((load) => load.error !== null);
  const path = new URL(measurement.url).pathname;
  if (failed.length === cold.length) {
    return `  ${paint.red('✖')} ${path}  ${paint.red(failed[0]?.error ?? 'failed')}`;
  }
  const p50 = (/** @type {Array<number | null | undefined>} */ values) => summarize(values)?.p50;
  const ttfb = p50(cold.map((load) => load.vitals?.ttfbMs));
  const lcp = p50(cold.map((load) => load.vitals?.lcpMs));
  const requests = p50(cold.map((load) => load.requests.length));
  const bytes = p50(cold.map((load) => sumTransfer(load)));
  return (
    `  ${paint.green('✔')} ${path}  ` +
    paint.dim(
      `TTFB ${fmt(ttfb, formatDuration)} · LCP ${fmt(lcp, formatDuration)} · ` +
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
