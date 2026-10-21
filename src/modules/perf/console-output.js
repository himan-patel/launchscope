import { formatBytes, formatDuration } from '../../core/duration.js';
import { countBySeverity } from './analyze/index.js';

/**
 * Human-readable progress lines for the terminal (written to stderr through the logger).
 */

const MAX_FINDINGS_IN_CONSOLE = 10;

/**
 * @param {import('./settings.js').PerfSettings} settings
 * @param {import('../../core/logger.js').Logger} logger
 */
export function writeRunHeader(settings, logger) {
  logger.banner();
  logger.info(`Target   ${logger.paint.cyan(settings.targetUrl.href)} (${settings.scope})`);
  if (settings.mode === 'api') {
    logger.info(
      `Plan     ${settings.runs} run(s) per endpoint, no browser, timeout ${formatDuration(settings.timeoutMs)}` +
        (settings.storageStatePath ? ', signed in via storage state' : ''),
    );
    return;
  }
  logger.info(
    `Plan     ${settings.runs} cold run(s)${settings.warmRuns ? ` + ${settings.warmRuns} warm` : ''} per route, ` +
      `${settings.device}, throttle ${settings.throttle}, timeout ${formatDuration(settings.timeoutMs)}`,
  );
  logger.info(
    `Routes   up to ${settings.maxRoutes}, crawl depth ${settings.depth}, sitemap ${settings.sitemap ? 'on' : 'off'}` +
      (settings.storageStatePath ? ', signed in via storage state' : ''),
  );
}

/**
 * One line per measured route, from its summary.
 *
 * @param {import('./analyze/routes.js').RouteSummary} route
 * @param {import('../../core/logger.js').Palette} paint
 * @returns {string}
 */
export function formatRouteLine(route, paint) {
  const url = new URL(route.url);
  const path = `${url.pathname}${url.search}`;
  if (route.error) return `  ${paint.red('✖')} ${path}  ${paint.red(route.error)}`;
  const m = route.metrics;
  const icon = route.status !== null && route.status >= 400 ? paint.yellow('!') : paint.green('✔');
  return (
    `  ${icon} ${path}  ` +
    paint.dim(
      `${route.status ?? '–'} · TTFB ${fmt(m.ttfbMs?.p50, formatDuration)} · LCP ${fmt(m.lcpMs?.p50, formatDuration)} · ` +
        `${m.requestCount ? Math.round(m.requestCount.p50) : '–'} requests · ${fmt(m.transferBytes?.p50, formatBytes)}`,
    )
  );
}

/**
 * @param {import('./trace/hop-tree.js').Trace | null} trace
 * @param {import('../../core/logger.js').Palette} paint
 * @returns {string | null}
 */
export function formatChainLine(trace, paint) {
  const longest = trace?.chains[0];
  if (!longest) return null;
  return paint.dim(
    `      ↳ sequential API chain: ${longest.ids.length} calls, ${formatDuration(longest.totalMs)}`,
  );
}

/**
 * @param {import('./analyze/bottlenecks.js').Finding[]} findings
 * @param {import('../../core/logger.js').Logger} logger
 */
export function writeFindings(findings, logger) {
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
 * @param {number | undefined} value
 * @param {(value: number) => string} format
 */
function fmt(value, format) {
  return value === undefined ? '–' : format(value);
}
