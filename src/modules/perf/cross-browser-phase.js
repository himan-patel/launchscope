import { join } from 'node:path';
import { formatDuration } from '../../core/duration.js';
import { LaunchScopeError } from '../../core/errors.js';
import { writeJsonFile } from '../../core/report-dir.js';
import { summarizeRoute } from './analyze/routes.js';
import { captureBrowserLoad } from './capture/browser-load.js';
import { createMeasurementContext, launchBrowser } from './capture/browser.js';

const SLOWER_RATIO = 1.5;
const SLOWER_MIN_MS = 500;

/**
 * @typedef {object} BrowserRouteResult
 * @property {string} url
 * @property {string} slug
 * @property {number | null} status
 * @property {string | null} error
 * @property {import('./analyze/routes.js').RouteMetrics} metrics
 * @property {number} failedRequests Failed or 4xx/5xx requests in the median run.
 * @property {string[]} consoleErrors
 * @property {string[]} pageErrors
 */

/**
 * @typedef {object} BrowserResult
 * @property {'firefox' | 'webkit'} browser
 * @property {string} version
 * @property {BrowserRouteResult[]} routes
 */

/**
 * Loads every measured route in Firefox and/or WebKit (`settings.runs` cold loads each) and
 * compares them with the primary Chromium results. Browsers that are not installed are skipped
 * with a warning so the main report is never lost.
 *
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {import('./measure-routes.js').RouteRecord[]} options.routes
 * @param {import('./analyze/routes.js').RouteSummary[]} options.chromium Primary route summaries.
 * @param {string} options.perfDirectory
 * @param {import('../../core/logger.js').Logger} options.logger
 * @param {AbortSignal} options.signal
 * @returns {Promise<{ browsers: BrowserResult[], findings: import('./analyze/bottlenecks.js').Finding[] } | null>}
 */
export async function runCrossBrowserPhase({
  settings,
  routes,
  chromium,
  perfDirectory,
  logger,
  signal,
}) {
  const others = /** @type {Array<'firefox' | 'webkit'>} */ (
    settings.browsers.filter((name) => name !== 'chromium')
  );
  if (others.length === 0 || routes.length === 0) return null;
  if (settings.throttle !== 'none' || settings.device === 'mobile') {
    logger.info(logger.paint.dim('  Network throttling and CPU slowdown apply to Chromium only.'));
  }

  /** @type {BrowserResult[]} */
  const browsers = [];
  for (const browserName of others) {
    if (signal.aborted) break;
    let launched;
    try {
      launched = await launchBrowser(settings, browserName);
    } catch (error) {
      if (error instanceof LaunchScopeError) {
        logger.warn(`${error.message} ${error.hint ?? ''} Skipping it.`.trim());
        continue;
      }
      throw error;
    }
    const { browser, devices } = launched;
    const closeBrowser = () => {
      browser.close().catch(() => {});
    };
    signal.addEventListener('abort', closeBrowser, { once: true });
    logger.info('');
    logger.info(`${logger.paint.bold(label(browserName))} ${logger.paint.dim(browser.version())}`);
    /** @type {BrowserRouteResult[]} */
    const results = [];
    try {
      for (const route of routes) {
        if (signal.aborted) break;
        /** @type {import('./capture/page-capture.js').PageLoad[]} */
        const loads = [];
        for (let run = 1; run <= settings.runs && !signal.aborted; run += 1) {
          const context = await createMeasurementContext(browser, devices, settings, {
            browserName,
          });
          try {
            loads.push(await captureBrowserLoad({ context, url: route.url, settings, run }));
          } finally {
            await context.close().catch(() => {});
          }
        }
        if (loads.length === 0) break;
        const summary = summarizeRoute({
          url: route.url,
          slug: route.slug,
          depth: route.depth,
          source: route.source,
          loads,
          representativeRun: null,
        });
        const median = [...loads]
          .filter((load) => !load.error)
          .sort((a, b) => a.wallTimeMs - b.wallTimeMs)[Math.floor((loads.length - 1) / 2)];
        results.push({
          url: route.url,
          slug: route.slug,
          status: summary.status,
          error: summary.error,
          metrics: summary.metrics,
          failedRequests: (median?.requests ?? []).filter(
            (request) => request.failure || (request.status !== null && request.status >= 400),
          ).length,
          consoleErrors: summary.consoleErrors,
          pageErrors: summary.pageErrors,
        });
        const last = results[results.length - 1];
        logger.info(
          `  ${last.error ? logger.paint.red('✖') : logger.paint.green('✔')} ${pathOf(route.url)}  ` +
            logger.paint.dim(
              last.error ??
                `load ${formatDuration(last.metrics.loadMs?.p50 ?? Number.NaN)} · ${Math.round(last.metrics.requestCount?.p50 ?? 0)} requests`,
            ),
        );
      }
    } finally {
      signal.removeEventListener('abort', closeBrowser);
      await browser.close().catch(() => {});
    }
    browsers.push({ browser: browserName, version: browser.version(), routes: results });
  }

  await writeJsonFile(join(perfDirectory, 'browsers.json'), browsers);
  return { browsers, findings: crossBrowserFindings(browsers, chromium) };
}

/**
 * @param {BrowserResult[]} browsers
 * @param {import('./analyze/routes.js').RouteSummary[]} chromium
 * @returns {import('./analyze/bottlenecks.js').Finding[]}
 */
export function crossBrowserFindings(browsers, chromium) {
  const baseline = new Map(chromium.map((route) => [route.slug, route]));
  /** @type {import('./analyze/bottlenecks.js').Finding[]} */
  const findings = [];
  for (const { browser, routes } of browsers) {
    const name = label(browser);
    for (const route of routes) {
      const primary = baseline.get(route.slug);
      if (!primary) continue;
      const subject = { route: route.slug, routeUrl: route.url };
      const where = pathOf(route.url);
      if (route.error && !primary.error) {
        findings.push({
          id: `browser-failed:${browser}:${route.slug}`,
          rule: 'browser-failed',
          severity: 'critical',
          category: 'cross-browser',
          title: `${where} fails to load in ${name}`,
          detail: route.error,
          recommendation: `Reproduce in ${name}; it loads in Chromium, so look for browser-specific APIs or headers.`,
          subject,
          evidence: { browser },
          impact: 100_000,
        });
        continue;
      }
      const newErrors = route.pageErrors.filter((message) => !primary.pageErrors.includes(message));
      if (newErrors.length > 0 || route.failedRequests > 0) {
        findings.push({
          id: `browser-errors:${browser}:${route.slug}`,
          rule: 'browser-errors',
          severity: 'warning',
          category: 'cross-browser',
          title: `${where} has errors in ${name} that Chromium does not`,
          detail: [
            ...newErrors.slice(0, 3),
            route.failedRequests ? `${route.failedRequests} failed request(s)` : '',
          ]
            .filter(Boolean)
            .join(' | '),
          recommendation: `Check ${name} support for the APIs and features this page uses.`,
          subject,
          evidence: { browser, pageErrors: newErrors.length, failedRequests: route.failedRequests },
          impact: 1000,
        });
      }
      const load = route.metrics.loadMs?.p50;
      const primaryLoad = primary.metrics.loadMs?.p50;
      if (
        load !== undefined &&
        primaryLoad !== undefined &&
        load >= primaryLoad * SLOWER_RATIO &&
        load - primaryLoad >= SLOWER_MIN_MS
      ) {
        findings.push({
          id: `browser-slower:${browser}:${route.slug}`,
          rule: 'browser-slower',
          severity: 'warning',
          category: 'cross-browser',
          title: `${where} loads ${Math.round((load / primaryLoad) * 10) / 10}× slower in ${name}`,
          detail: `Load event at ${formatDuration(load)} in ${name} vs ${formatDuration(primaryLoad)} in Chromium (medians).`,
          recommendation: `Profile the page in ${name}; look for features that are slow or polyfilled there.`,
          subject,
          evidence: { browser, loadMs: load, chromiumLoadMs: primaryLoad },
          impact: load - primaryLoad,
        });
      }
    }
  }
  return findings;
}

/** @param {'chromium' | 'firefox' | 'webkit'} browser */
export function label(browser) {
  return browser === 'firefox' ? 'Firefox' : browser === 'webkit' ? 'WebKit' : 'Chromium';
}

/** @param {string} url */
function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
