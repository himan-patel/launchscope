import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDuration } from '../../core/duration.js';
import { LaunchScopeError } from '../../core/errors.js';

/**
 * Optional Google Lighthouse audits (`--lighthouse`). Lighthouse is an optional peer dependency
 * (`npm install lighthouse`); it drives a separate Playwright Chromium over the remote debugging
 * protocol, once per measured route, with its own default throttling (simulated slow 4G and CPU
 * slowdown for mobile, Lighthouse's desktop preset for desktop).
 *
 * Signed-in pages: cookies from `--storage-state` are loaded into a temporary browser profile and
 * Lighthouse's storage reset is disabled. `--header` values are NOT passed to Lighthouse, because
 * Lighthouse would send them to every origin, including third parties.
 */

/**
 * @typedef {object} LighthouseRouteResult
 * @property {string} url
 * @property {string} slug
 * @property {number | null} score Performance score from 0 to 1.
 * @property {Record<string, number | null>} metrics Lab metrics in ms (CLS unitless).
 * @property {string | null} report Relative path of the HTML report.
 * @property {string | null} error
 */

const METRICS = /** @type {const} */ ([
  ['fcpMs', 'first-contentful-paint'],
  ['lcpMs', 'largest-contentful-paint'],
  ['tbtMs', 'total-blocking-time'],
  ['cls', 'cumulative-layout-shift'],
  ['speedIndexMs', 'speed-index'],
  ['ttiMs', 'interactive'],
]);

/**
 * Loads Lighthouse or explains how to install it. Called before measuring so a missing
 * dependency fails fast.
 *
 * @returns {Promise<{ lighthouse: (url: string, flags: object, config?: object) => Promise<any>, desktopConfig: object }>}
 */
export async function loadLighthouse() {
  try {
    const { default: lighthouse } = await import('lighthouse');
    const { default: desktopConfig } = await import('lighthouse/core/config/desktop-config.js');
    return { lighthouse, desktopConfig };
  } catch (error) {
    throw new LaunchScopeError('--lighthouse needs the optional "lighthouse" package.', {
      exitCode: 2,
      hint: 'Install it next to LaunchScope with "npm install lighthouse", then check with "launchscope doctor".',
      cause: error,
    });
  }
}

/**
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {import('./measure-routes.js').RouteRecord[]} options.routes
 * @param {string} options.perfDirectory
 * @param {import('../../core/logger.js').Logger} options.logger
 * @param {AbortSignal} options.signal
 * @returns {Promise<{ results: LighthouseRouteResult[], findings: import('./analyze/bottlenecks.js').Finding[] } | null>}
 */
export async function runLighthousePhase({ settings, routes, perfDirectory, logger, signal }) {
  const measurable = routes.filter((route) => route.trace);
  if (measurable.length === 0) return null;
  const { lighthouse, desktopConfig } = await loadLighthouse();
  if (Object.keys(settings.headers).length > 0) {
    logger.warn('--header values are not sent to Lighthouse (it would send them to every origin).');
  }

  logger.info('');
  logger.info(
    `${logger.paint.bold('Lighthouse')} · ${measurable.length} route(s), ${settings.device} preset`,
  );
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'launchscope-lighthouse-'));
  const playwright = await import('playwright');
  const context = await playwright.chromium.launchPersistentContext(profile, {
    headless: !settings.headed,
    channel: settings.browserChannel,
    args: [`--remote-debugging-port=${port}`],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const close = () => {
    context.close().catch(() => {});
  };
  signal.addEventListener('abort', close, { once: true });

  /** @type {LighthouseRouteResult[]} */
  const results = [];
  try {
    if (settings.storageStatePath) {
      const state = JSON.parse(await readFile(settings.storageStatePath, 'utf8'));
      await context.addCookies(state.cookies ?? []);
    }
    for (const route of measurable) {
      if (signal.aborted) break;
      results.push(
        await auditRoute({ route, settings, lighthouse, desktopConfig, port, perfDirectory }),
      );
      const last = results[results.length - 1];
      logger.info(
        `  ${last.error ? logger.paint.red('✖') : logger.paint.green('✔')} ${pathOf(route.url)}  ` +
          logger.paint.dim(
            last.error ??
              `score ${Math.round((last.score ?? 0) * 100)} · LCP ${formatDuration(last.metrics.lcpMs ?? Number.NaN)} · TBT ${formatDuration(last.metrics.tbtMs ?? Number.NaN)}`,
          ),
      );
    }
  } finally {
    signal.removeEventListener('abort', close);
    await context.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  }
  return { results, findings: lighthouseFindings(results, settings.budgets) };
}

/**
 * @param {object} options
 * @param {import('./measure-routes.js').RouteRecord} options.route
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {(url: string, flags: object, config?: object) => Promise<any>} options.lighthouse
 * @param {object} options.desktopConfig
 * @param {number} options.port
 * @param {string} options.perfDirectory
 * @returns {Promise<LighthouseRouteResult>}
 */
async function auditRoute({ route, settings, lighthouse, desktopConfig, port, perfDirectory }) {
  try {
    const result = await lighthouse(
      route.url,
      {
        port,
        output: ['html'],
        logLevel: 'error',
        onlyCategories: ['performance'],
        disableStorageReset: Boolean(settings.storageStatePath),
        maxWaitForLoad: settings.timeoutMs,
      },
      settings.device === 'desktop' ? desktopConfig : undefined,
    );
    const lhr = result?.lhr;
    if (!lhr || lhr.runtimeError) {
      return failure(route, lhr?.runtimeError?.message ?? 'Lighthouse returned no result');
    }
    // `report` is a link in the HTML report, so it always uses forward slashes.
    const report = `routes/${route.slug}/lighthouse.html`;
    await writeFile(
      join(perfDirectory, 'routes', route.slug, 'lighthouse.html'),
      String(result.report?.[0] ?? result.report ?? ''),
    );
    return {
      url: route.url,
      slug: route.slug,
      score: lhr.categories?.performance?.score ?? null,
      metrics: Object.fromEntries(
        METRICS.map(([key, audit]) => [key, round(lhr.audits?.[audit]?.numericValue)]),
      ),
      report,
      error: null,
    };
  } catch (error) {
    return failure(route, error instanceof Error ? error.message.split('\n')[0] : String(error));
  }
}

/**
 * Lower Lighthouse scores are worse, so the budget thresholds are minimums.
 *
 * @param {LighthouseRouteResult[]} results
 * @param {import('./analyze/budgets.js').Budgets} budgets
 * @returns {import('./analyze/bottlenecks.js').Finding[]}
 */
export function lighthouseFindings(results, budgets) {
  /** @type {import('./analyze/bottlenecks.js').Finding[]} */
  const findings = [];
  for (const result of results) {
    if (result.score === null || result.error) continue;
    const severity =
      result.score < budgets.lighthouseScore.critical
        ? 'critical'
        : result.score < budgets.lighthouseScore.warning
          ? 'warning'
          : null;
    if (!severity) continue;
    findings.push({
      id: `lighthouse-score:${result.slug}`,
      rule: 'lighthouse-score',
      severity,
      category: 'web-vitals',
      title: `Lighthouse performance score for ${pathOf(result.url)} is ${Math.round(result.score * 100)}`,
      detail: `LCP ${formatDuration(result.metrics.lcpMs ?? Number.NaN)}, TBT ${formatDuration(result.metrics.tbtMs ?? Number.NaN)}, CLS ${(result.metrics.cls ?? 0).toFixed(3)} (Lighthouse lab run).`,
      recommendation:
        'Open the Lighthouse report for this route to see its opportunities and diagnostics.',
      subject: { route: result.slug, routeUrl: result.url },
      evidence: { score: result.score, minimum: budgets.lighthouseScore[severity] },
      impact: (1 - result.score) * 1000,
    });
  }
  return findings;
}

/**
 * @param {import('./measure-routes.js').RouteRecord} route
 * @param {string} message
 * @returns {LighthouseRouteResult}
 */
function failure(route, message) {
  return {
    url: route.url,
    slug: route.slug,
    score: null,
    metrics: {},
    report: null,
    error: message,
  };
}

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** @param {number | undefined} value */
function round(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : null;
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
