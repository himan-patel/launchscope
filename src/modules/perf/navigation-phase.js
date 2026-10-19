import { join } from 'node:path';
import { formatBytes, formatDuration } from '../../core/duration.js';
import { writeJsonFile } from '../../core/report-dir.js';
import { classify } from './analyze/budgets.js';
import { summarize } from './analyze/stats.js';
import { createMeasurementContext, launchBrowser } from './capture/browser.js';
import { measureNavigation } from './capture/navigation.js';
import { buildTrace, describeNode } from './trace/hop-tree.js';

/**
 * @typedef {object} NavigationSummary
 * @property {string} from
 * @property {string} to
 * @property {'soft' | 'full' | 'failed'} kind Soft when the app's router handled the click.
 * @property {number} runs
 * @property {number} failedRuns
 * @property {string | null} error
 * @property {import('./analyze/stats.js').Distribution | null} durationMs
 * @property {import('./analyze/stats.js').Distribution | null} networkMs
 * @property {import('./analyze/stats.js').Distribution | null} renderMs
 * @property {import('./analyze/stats.js').Distribution | null} requestCount
 * @property {import('./analyze/stats.js').Distribution | null} transferBytes
 * @property {import('./analyze/stats.js').Distribution | null} apiCalls
 * @property {Array<{ label: string, durationMs: number, startMs: number }>} requests Requests of the median run.
 * @property {import('./trace/hop-tree.js').RequestChain | null} longestChain
 * @property {string[]} chainLabels
 */

/**
 * Measures client-side navigations between measured routes: for every pair where page A links
 * to measured route B (up to `settings.spaMax` pairs), click A → B `settings.runs` times, each in
 * a fresh browser context.
 *
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {import('./measure-routes.js').RouteRecord[]} options.routes
 * @param {string} options.perfDirectory
 * @param {import('../../core/logger.js').Logger} options.logger
 * @param {AbortSignal} options.signal
 * @returns {Promise<{ navigations: NavigationSummary[], findings: import('./analyze/bottlenecks.js').Finding[] } | null>}
 */
export async function runNavigationPhase({ settings, routes, perfDirectory, logger, signal }) {
  const pairs = choosePairs(routes, settings.spaMax);
  if (pairs.length === 0) {
    logger.warn(
      'Skipping navigation measurement: no measured page links to another measured route.',
    );
    return null;
  }
  logger.info('');
  logger.info(
    `${logger.paint.bold('Navigations')} · ${pairs.length} link(s) between measured routes, ${settings.runs} run(s) each`,
  );

  const { browser, devices } = await launchBrowser(settings);
  const closeBrowser = () => {
    browser.close().catch(() => {});
  };
  signal.addEventListener('abort', closeBrowser, { once: true });
  /** @type {NavigationSummary[]} */
  const navigations = [];
  try {
    for (const { from, to } of pairs) {
      if (signal.aborted) break;
      /** @type {import('./capture/navigation.js').NavigationSample[]} */
      const samples = [];
      for (let run = 1; run <= settings.runs && !signal.aborted; run += 1) {
        const context = await createMeasurementContext(browser, devices, settings);
        try {
          samples.push(await measureNavigation({ context, settings, from, to }));
        } finally {
          await context.close().catch(() => {});
        }
      }
      if (samples.length === 0) break;
      const summary = summarizeNavigation(from, to, samples);
      navigations.push(summary);
      logger.info(formatNavigationLine(summary, logger.paint));
    }
  } finally {
    signal.removeEventListener('abort', closeBrowser);
    await browser.close().catch(() => {});
  }

  const findings = navigationFindings(navigations, settings.budgets);
  await writeJsonFile(join(perfDirectory, 'navigations.json'), navigations);
  return { navigations, findings };
}

/**
 * @param {import('./measure-routes.js').RouteRecord[]} routes
 * @param {number} limit
 * @returns {Array<{ from: string, to: string }>}
 */
export function choosePairs(routes, limit) {
  const measured = new Set(routes.filter((route) => route.trace).map((route) => route.url));
  /** @type {Array<{ from: string, to: string }>} */
  const pairs = [];
  for (const route of routes) {
    if (!route.trace) continue;
    for (const link of new Set(route.links.map(stripHash))) {
      if (link === route.url || !measured.has(link)) continue;
      pairs.push({ from: route.url, to: link });
      if (pairs.length >= limit) return pairs;
    }
  }
  return pairs;
}

/**
 * @param {string} from
 * @param {string} to
 * @param {import('./capture/navigation.js').NavigationSample[]} samples
 * @returns {NavigationSummary}
 */
export function summarizeNavigation(from, to, samples) {
  const ok = samples.filter((sample) => sample.kind !== 'failed');
  const kind =
    ok.length === 0 ? 'failed' : ok.some((sample) => sample.kind === 'soft') ? 'soft' : 'full';
  const sorted = [...ok].sort((a, b) => a.durationMs - b.durationMs);
  const median = sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
  const trace = median && median.requests.length > 1 ? buildTrace(median.requests, to) : null;
  const longestChain = trace?.chains[0] ?? null;
  const nodes = new Map((trace?.nodes ?? []).map((node) => [node.id, node]));
  const isApi = (/** @type {{ resourceType: string }} */ request) =>
    request.resourceType === 'Fetch' || request.resourceType === 'XHR';
  return {
    from,
    to,
    kind,
    runs: samples.length,
    failedRuns: samples.length - ok.length,
    error: ok.length === 0 ? (samples[0]?.error ?? 'failed') : null,
    durationMs: summarize(ok.map((sample) => sample.durationMs)),
    networkMs: summarize(ok.map((sample) => sample.networkMs)),
    renderMs: summarize(ok.map((sample) => sample.renderMs)),
    requestCount: summarize(ok.map((sample) => sample.requests.length)),
    transferBytes: summarize(
      ok.map((sample) => sample.requests.reduce((sum, r) => sum + r.transferBytes, 0)),
    ),
    apiCalls: summarize(ok.map((sample) => sample.requests.filter(isApi).length)),
    requests: (median?.requests ?? []).map((request) => ({
      label: `${request.method} ${pathOf(request.url)}${request.graphql ? ` (${request.graphql.name})` : ''}`,
      durationMs: request.durationMs,
      startMs: request.startMs,
    })),
    longestChain,
    chainLabels: longestChain
      ? longestChain.ids.map((id) => {
          const node = nodes.get(id);
          return node ? describeNode(node) : id;
        })
      : [],
  };
}

/**
 * @param {NavigationSummary[]} navigations
 * @param {import('./analyze/budgets.js').Budgets} budgets
 * @returns {import('./analyze/bottlenecks.js').Finding[]}
 */
export function navigationFindings(navigations, budgets) {
  /** @type {import('./analyze/bottlenecks.js').Finding[]} */
  const findings = [];
  const anySoft = navigations.some((navigation) => navigation.kind === 'soft');
  for (const navigation of navigations) {
    const label = `${pathOf(navigation.from)} → ${pathOf(navigation.to)}`;
    const subject = { routeUrl: navigation.to };
    if (navigation.kind === 'failed') {
      findings.push({
        id: `navigation-failed:${label}`,
        rule: 'navigation-failed',
        severity: 'warning',
        category: 'navigation',
        title: `Navigation ${label} failed`,
        detail: navigation.error ?? 'Every attempt failed.',
        recommendation: 'Check that the link is visible and clickable after the page loads.',
        subject,
        evidence: { runs: navigation.runs },
        impact: 500,
      });
      continue;
    }
    const median = navigation.durationMs?.p50;
    const severity = classify(budgets.navigationMs, median);
    if (severity && median !== undefined) {
      findings.push({
        id: `slow-navigation:${label}`,
        rule: 'slow-navigation',
        severity,
        category: 'navigation',
        title: `Navigating ${label} takes ${formatDuration(median)}`,
        detail: `Median of ${navigation.runs - navigation.failedRuns} run(s) from click until network and DOM settle (network ${formatDuration(navigation.networkMs?.p50 ?? 0)}, render ${formatDuration(navigation.renderMs?.p50 ?? 0)}); ${Math.round(navigation.requestCount?.p50 ?? 0)} request(s), ${formatBytes(navigation.transferBytes?.p50 ?? 0)}.`,
        recommendation:
          'Prefetch data for likely next routes, cache API responses across navigations, and avoid sequential fetches in route loaders.',
        subject,
        evidence: { medianMs: median, threshold: budgets.navigationMs[severity] },
        impact: median,
      });
    }
    const chain = navigation.longestChain;
    const chainSeverity = chain ? classify(budgets.chainLength, chain.ids.length) : null;
    if (chain && chainSeverity) {
      findings.push({
        id: `navigation-api-chain:${label}`,
        rule: 'navigation-api-chain',
        severity: chainSeverity,
        category: 'waterfall',
        title: `Navigating ${label} waits on ${chain.ids.length} sequential API calls (${formatDuration(chain.totalMs)})`,
        detail: `${navigation.chainLabels.join(' → ')}. Inferred from timing and call stacks.`,
        recommendation:
          'Fetch independent data in parallel or return it from one endpoint for this route.',
        subject,
        evidence: { calls: chain.ids.length, totalMs: chain.totalMs },
        impact: chain.totalMs,
      });
    }
    if (navigation.kind === 'full' && anySoft) {
      findings.push({
        id: `full-reload:${label}`,
        rule: 'full-reload-navigation',
        severity: 'info',
        category: 'navigation',
        title: `The link ${label} reloads the whole page`,
        detail:
          'Other links in this app navigate client-side, but this one makes the browser load a new document.',
        recommendation:
          "Use the router's link component for internal links so navigation stays client-side.",
        subject,
        evidence: { requests: Math.round(navigation.requestCount?.p50 ?? 0) },
        impact: navigation.durationMs?.p50 ?? 0,
      });
    }
  }
  return findings;
}

/**
 * @param {NavigationSummary} navigation
 * @param {import('../../core/logger.js').Palette} paint
 * @returns {string}
 */
function formatNavigationLine(navigation, paint) {
  const label = `${pathOf(navigation.from)} → ${pathOf(navigation.to)}`;
  if (navigation.kind === 'failed')
    return `  ${paint.red('✖')} ${label}  ${paint.red(navigation.error ?? 'failed')}`;
  return (
    `  ${paint.green('↪')} ${label}  ` +
    paint.dim(
      `${navigation.kind} · ${formatDuration(navigation.durationMs?.p50 ?? 0)} · ${Math.round(navigation.requestCount?.p50 ?? 0)} requests · ${formatBytes(navigation.transferBytes?.p50 ?? 0)}`,
    )
  );
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

/** @param {string} url */
function stripHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}
