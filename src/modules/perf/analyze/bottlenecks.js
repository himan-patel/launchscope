import { formatBytes, formatDuration } from '../../../core/duration.js';
import { describeNode } from '../trace/hop-tree.js';
import { classify } from './budgets.js';

/**
 * Turns measurements into ranked, actionable findings. Every finding cites the numbers it is
 * based on (`evidence`) so readers can verify it, and says what to do about it.
 */

/** @typedef {'critical' | 'warning' | 'info'} Severity */

/**
 * @typedef {object} Finding
 * @property {string} id Stable identifier: rule plus subject.
 * @property {string} rule
 * @property {Severity} severity
 * @property {string} category
 * @property {string} title
 * @property {string} detail
 * @property {string} recommendation
 * @property {{ route?: string, routeUrl?: string, endpoint?: string }} subject
 * @property {Record<string, string | number>} evidence
 * @property {number} impact Rough sort weight within a severity (ms or KB).
 */

/**
 * @typedef {object} AnalysisInput
 * @property {import('./routes.js').RouteSummary[]} routes
 * @property {Map<string, import('../trace/hop-tree.js').Trace>} traces By route slug.
 * @property {import('./endpoints.js').EndpointSummary[]} endpoints
 * @property {import('./budgets.js').Budgets} budgets
 */

export const SEVERITY_ORDER = /** @type {const} */ ({ critical: 0, warning: 1, info: 2 });

const TEXT_TYPES = /json|javascript|ecmascript|css|html|xml|svg|text\//i;
const MIN_COMPRESSIBLE_BYTES = 1400;
const STATIC_TYPES = new Set(['Script', 'Stylesheet', 'Font', 'Image']);
const LONG_LIVED_CACHE = /max-age=(?:[1-9]\d{3,})|immutable/;
const IFRAME_HEAVY_BYTES = 500 * 1024;
const INSTABILITY_RATIO = 2.5;
const MIN_SAMPLES_FOR_INSTABILITY = 5;
const CRITICAL_SEGMENT_SHARE = 0.4;
const CRITICAL_SEGMENT_MIN_MS = 300;

/**
 * @param {AnalysisInput} input
 * @returns {Finding[]} Sorted by severity, then impact.
 */
export function detectBottlenecks({ routes, traces, endpoints, budgets }) {
  /** @type {Finding[]} */
  const findings = [];
  for (const route of routes) {
    findings.push(...routeFindings(route, budgets));
    const trace = traces.get(route.slug);
    if (trace) findings.push(...traceFindings(route, trace, budgets));
  }
  for (const endpoint of endpoints) findings.push(...endpointFindings(endpoint, budgets));
  findings.push(...staticCacheFindings(traces));
  return sortFindings(findings);
}

/**
 * One finding for all same-origin static assets (across every route) that lack long-lived
 * cache headers, so a shared stylesheet is reported once rather than once per page.
 *
 * @param {Map<string, import('../trace/hop-tree.js').Trace>} traces
 * @returns {Finding[]}
 */
function staticCacheFindings(traces) {
  /** @type {Map<string, { cacheControl: string | null, routes: Set<string> }>} */
  const assets = new Map();
  for (const [slug, trace] of traces) {
    for (const node of trace.nodes) {
      if (node.thirdParty || node.failed || !STATIC_TYPES.has(node.resourceType)) continue;
      if (LONG_LIVED_CACHE.test(node.cacheControl ?? '')) continue;
      const entry = assets.get(node.url) ?? { cacheControl: node.cacheControl, routes: new Set() };
      entry.routes.add(slug);
      assets.set(node.url, entry);
    }
  }
  if (assets.size === 0) return [];
  const listed = [...assets]
    .slice(0, 5)
    .map(
      ([url, entry]) =>
        `${pathLabel(url)} (${entry.cacheControl ?? 'no Cache-Control'}, on ${entry.routes.size} route(s))`,
    );
  return [
    {
      id: 'static-cache',
      rule: 'static-cache',
      severity: 'info',
      category: 'caching',
      title: `${assets.size} static asset(s) lack long-lived cache headers`,
      detail: `Repeat visits re-download or revalidate them: ${listed.join(', ')}${assets.size > 5 ? ', …' : ''}.`,
      recommendation:
        'Serve fingerprinted assets with "Cache-Control: public, max-age=31536000, immutable".',
      subject: {},
      evidence: { assets: assets.size },
      impact: assets.size,
    },
  ];
}

/**
 * @param {Finding[]} findings
 * @returns {Finding[]}
 */
export function sortFindings(findings) {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.impact - a.impact,
  );
}

/**
 * @param {import('./routes.js').RouteSummary} route
 * @param {import('./budgets.js').Budgets} budgets
 * @returns {Finding[]}
 */
function routeFindings(route, budgets) {
  /** @type {Finding[]} */
  const findings = [];
  const subject = { route: route.slug, routeUrl: route.url };
  const label = pathLabel(route.url);

  if (route.error) {
    findings.push({
      id: `route-failed:${route.slug}`,
      rule: 'route-failed',
      severity: 'critical',
      category: 'errors',
      title: `${label} failed to load`,
      detail: `Every measured run failed: ${route.error}`,
      recommendation:
        'Check that the route is reachable, the server is running, and the timeout is long enough.',
      subject,
      evidence: { error: route.error, runs: route.runs.cold },
      impact: 100_000,
    });
    return findings;
  }

  if (route.status !== null && route.status >= 400) {
    findings.push({
      id: `route-status:${route.slug}`,
      rule: 'route-status',
      severity: route.status >= 500 ? 'critical' : 'warning',
      category: 'errors',
      title: `${label} responds with HTTP ${route.status}`,
      detail: `The page document returned ${route.status}, so its measurements describe an error page.`,
      recommendation:
        route.status === 401 || route.status === 403
          ? 'Measure signed-in pages with --storage-state (see "launchscope login").'
          : 'Fix the route or remove it from the measured routes.',
      subject,
      evidence: { status: route.status },
      impact: 50_000,
    });
  }

  /** @type {Array<[keyof import('./budgets.js').Budgets, string, number | undefined, (value: number) => string, string]>} */
  const vitals = [
    [
      'lcpMs',
      'Largest Contentful Paint',
      route.metrics.lcpMs?.p50,
      formatDuration,
      'Speed up the largest element: optimize or preload the hero image, cut render-blocking CSS/JS, and reduce server response time.',
    ],
    [
      'fcpMs',
      'First Contentful Paint',
      route.metrics.fcpMs?.p50,
      formatDuration,
      'Reduce render-blocking resources and server response time so the first content paints sooner.',
    ],
    [
      'ttfbMs',
      'Time to first byte',
      route.metrics.ttfbMs?.p50,
      formatDuration,
      'The server is slow to start responding: cache rendered pages, move work off the request path, or use a CDN close to users.',
    ],
    [
      'cls',
      'Cumulative Layout Shift',
      route.metrics.cls?.p50,
      (value) => value.toFixed(3),
      'Reserve space for images, embeds, and late content (width/height or aspect-ratio), and avoid inserting content above existing content.',
    ],
    [
      'tbtMs',
      'Total Blocking Time',
      route.metrics.tbtMs?.p50,
      formatDuration,
      'Break up long JavaScript tasks, defer non-critical scripts, and remove unused code.',
    ],
  ];
  for (const [budget, name, value, format, recommendation] of vitals) {
    const severity = classify(budgets[budget], value);
    if (!severity || value === undefined) continue;
    findings.push({
      id: `${budget}:${route.slug}`,
      rule: `vitals-${budget}`,
      severity,
      category: 'web-vitals',
      title: `${name} on ${label} is ${format(value)}`,
      detail: `Median of ${route.runs.cold - route.runs.failed} cold run(s); ${severity} threshold is ${format(budgets[budget][severity])}.`,
      recommendation,
      subject,
      evidence: { median: value, threshold: budgets[budget][severity] },
      impact: budget === 'cls' ? value * 10_000 : value,
    });
  }

  const weight = route.metrics.transferBytes?.p50;
  const weightSeverity = classify(budgets.pageWeightBytes, weight);
  if (weightSeverity && weight !== undefined) {
    const top = route.resourceTypes[0];
    findings.push({
      id: `page-weight:${route.slug}`,
      rule: 'page-weight',
      severity: weightSeverity,
      category: 'payload',
      title: `${label} transfers ${formatBytes(weight)} per load`,
      detail: top
        ? `Largest contributor: ${top.type} (${formatBytes(top.transferBytes)} across ${top.requests} request(s)).`
        : 'Page weight is above budget.',
      recommendation:
        'Compress and resize images, split large bundles, and lazy-load below-the-fold content.',
      subject,
      evidence: { medianBytes: weight, threshold: budgets.pageWeightBytes[weightSeverity] },
      impact: weight / 1024,
    });
  }

  const requests = route.metrics.requestCount?.p50;
  const requestSeverity = classify(budgets.requestCount, requests);
  if (requestSeverity && requests !== undefined) {
    findings.push({
      id: `request-count:${route.slug}`,
      rule: 'request-count',
      severity: requestSeverity,
      category: 'network',
      title: `${label} makes ${Math.round(requests)} requests per load`,
      detail: `Threshold is ${budgets.requestCount[requestSeverity]}.`,
      recommendation:
        'Bundle small assets, remove unused third-party tags, and combine API calls where possible.',
      subject,
      evidence: { medianRequests: requests },
      impact: requests,
    });
  }

  const thirdPartyShare =
    weight && weight > 0 ? (route.metrics.thirdPartyBytes?.p50 ?? 0) / weight : 0;
  if (thirdPartyShare >= 0.5 && route.thirdParty.requests > 0) {
    findings.push({
      id: `third-party:${route.slug}`,
      rule: 'third-party',
      severity: 'info',
      category: 'third-party',
      title: `${Math.round(thirdPartyShare * 100)}% of ${label}'s bytes come from third parties`,
      detail: `${route.thirdParty.requests} request(s) to ${route.thirdParty.origins.length} other origin(s): ${route.thirdParty.origins.slice(0, 5).join(', ')}.`,
      recommendation:
        'Audit third-party scripts and embeds; load them after the page is interactive or remove unused ones.',
      subject,
      evidence: { share: round(thirdPartyShare), requests: route.thirdParty.requests },
      impact: thirdPartyShare * 100,
    });
  }

  for (const socket of route.realtime.websockets) {
    const failedHandshake = socket.status !== null && socket.status !== 101;
    if (!failedHandshake && socket.errors === 0 && socket.status !== null) continue;
    findings.push({
      id: `websocket:${route.slug}:${socket.url}`,
      rule: 'websocket-failed',
      severity: 'warning',
      category: 'errors',
      title: `WebSocket ${pathLabel(socket.url)} on ${label} ${socket.status === null ? 'never completed its handshake' : failedHandshake ? `was rejected (HTTP ${socket.status})` : `reported ${socket.errors} frame error(s)`}`,
      detail: `${socket.framesReceived} frame(s) received, ${socket.framesSent} sent before capture ended.`,
      recommendation:
        'Check the WebSocket endpoint, proxy upgrade support, and authentication for live features.',
      subject,
      evidence: { status: socket.status ?? 'none', errors: socket.errors },
      impact: 500,
    });
  }

  const iframeBytes = route.realtime.iframes.transferBytes;
  if (
    route.realtime.iframes.count > 0 &&
    (iframeBytes >= IFRAME_HEAVY_BYTES || ((weight ?? 0) > 0 && iframeBytes / (weight ?? 1) >= 0.3))
  ) {
    findings.push({
      id: `iframe-weight:${route.slug}`,
      rule: 'iframe-weight',
      severity: 'info',
      category: 'third-party',
      title: `${route.realtime.iframes.count} iframe(s) on ${label} add ${formatBytes(iframeBytes)}`,
      detail: `${route.realtime.iframes.requests} request(s) from embedded frames: ${route.realtime.iframes.origins.join(', ') || 'same origin'}.`,
      recommendation:
        'Lazy-load embeds (loading="lazy" or a click-to-load facade) so they do not compete with the page.',
      subject,
      evidence: { iframes: route.realtime.iframes.count, bytes: iframeBytes },
      impact: iframeBytes / 1024,
    });
  }

  if (route.pageErrors.length > 0 || route.consoleErrors.length > 0) {
    findings.push({
      id: `js-errors:${route.slug}`,
      rule: 'js-errors',
      severity: route.pageErrors.length > 0 ? 'warning' : 'info',
      category: 'errors',
      title: `${label} logs ${route.pageErrors.length} uncaught exception(s) and ${route.consoleErrors.length} console error(s)`,
      detail: [...route.pageErrors, ...route.consoleErrors].slice(0, 3).join(' | '),
      recommendation: 'Fix JavaScript errors; they often hide failed requests or broken features.',
      subject,
      evidence: { pageErrors: route.pageErrors.length, consoleErrors: route.consoleErrors.length },
      impact: route.pageErrors.length * 100 + route.consoleErrors.length,
    });
  }
  return findings;
}

/**
 * @param {import('./routes.js').RouteSummary} route
 * @param {import('../trace/hop-tree.js').Trace} trace
 * @param {import('./budgets.js').Budgets} budgets
 * @returns {Finding[]}
 */
function traceFindings(route, trace, budgets) {
  /** @type {Finding[]} */
  const findings = [];
  const subject = { route: route.slug, routeUrl: route.url };
  const label = pathLabel(route.url);
  const nodes = new Map(trace.nodes.map((node) => [node.id, node]));

  const [chain] = trace.chains;
  const chainSeverity = chain ? classify(budgets.chainLength, chain.ids.length) : null;
  if (chain && chainSeverity) {
    const steps = chain.ids.map((id) => {
      const node = nodes.get(id);
      return node ? `${describeNode(node)} (${formatDuration(node.durationMs)})` : id;
    });
    findings.push({
      id: `api-chain:${route.slug}`,
      rule: 'api-chain',
      severity: chainSeverity,
      category: 'waterfall',
      title: `${label} waits on ${chain.ids.length} sequential API calls (${formatDuration(chain.totalMs)})`,
      detail: `Each call starts only after the previous one finished: ${steps.join(' → ')}. Inferred from timing and call stacks; ${formatDuration(chain.idleMs)} is spent between calls.`,
      recommendation:
        'Fetch independent data in parallel (Promise.all), return what the page needs from one endpoint, or load it on the server.',
      subject,
      evidence: { calls: chain.ids.length, totalMs: chain.totalMs, idleMs: chain.idleMs },
      impact: chain.totalMs,
    });
  }

  const path = trace.criticalPath;
  if (path && path.totalMs > 0) {
    const dominant = path.segments
      .map((segment) => ({ segment, node: nodes.get(segment.id) }))
      .filter(
        ({ node, segment }) => node && segment.endMs - segment.startMs >= CRITICAL_SEGMENT_MIN_MS,
      )
      .sort(
        (a, b) => b.segment.endMs - b.segment.startMs - (a.segment.endMs - a.segment.startMs),
      )[0];
    if (dominant?.node) {
      const ms = dominant.segment.endMs - dominant.segment.startMs;
      const share = ms / path.totalMs;
      if (share >= CRITICAL_SEGMENT_SHARE) {
        findings.push({
          id: `critical-segment:${route.slug}:${dominant.node.url}`,
          rule: 'critical-segment',
          severity: 'warning',
          category: 'waterfall',
          title: `${describeNode(dominant.node)} takes ${Math.round(share * 100)}% of ${label}'s critical path`,
          detail: `${formatDuration(ms)} of the ${formatDuration(path.totalMs)} it takes the last request on ${label} to finish.`,
          recommendation:
            'Speed up this request first, start it earlier (preload or parallelize), or take it off the critical path.',
          subject,
          evidence: { segmentMs: round(ms), pathMs: path.totalMs, share: round(share) },
          impact: ms,
        });
      }
    }
  }

  const redirected = trace.nodes.filter((node) => node.redirectCount > 0);
  for (const node of redirected) {
    const from = pathLabel(node.redirectedFrom ?? node.url);
    findings.push({
      id: `redirect:${route.slug}:${node.url}`,
      rule: 'redirect',
      severity: node.resourceType === 'Document' ? 'warning' : 'info',
      category: 'network',
      title: `${from} redirects to ${pathLabel(node.url)} (${node.redirectCount} hop${node.redirectCount === 1 ? '' : 's'})`,
      detail: `Each redirect costs a full round trip before the real response starts (seen on ${label}).`,
      recommendation:
        'Link directly to the final URL and update internal links, sitemaps, and API clients.',
      subject,
      evidence: { redirects: node.redirectCount },
      impact: node.redirectCount * 100,
    });
  }
  return findings;
}

/**
 * @param {import('./endpoints.js').EndpointSummary} endpoint
 * @param {import('./budgets.js').Budgets} budgets
 * @returns {Finding[]}
 */
function endpointFindings(endpoint, budgets) {
  /** @type {Finding[]} */
  const findings = [];
  const subject = { endpoint: endpoint.key };
  const name = `${endpoint.method} ${endpoint.thirdParty ? `${endpoint.origin}${endpoint.pathTemplate}` : endpoint.pathTemplate}${endpoint.graphqlOperation ? ` (${endpoint.graphqlOperation})` : ''}`;
  const isApi = endpoint.resourceType === 'Fetch' || endpoint.resourceType === 'XHR';

  if (isApi && endpoint.durationMs) {
    const severity = classify(budgets.apiP95Ms, endpoint.durationMs.p95);
    const waitP50 = endpoint.waitMs?.p50 ?? 0;
    const waitSeverity = classify(budgets.serverWaitMs, waitP50);
    const chosen = worst(severity, waitSeverity);
    if (chosen) {
      const topTiming = [...endpoint.serverTiming].sort((a, b) => b.meanMs - a.meanMs)[0];
      const backend =
        topTiming && waitP50 > 0
          ? ` Server-Timing: "${topTiming.name}" averages ${formatDuration(topTiming.meanMs)} (${Math.round((topTiming.meanMs / waitP50) * 100)}% of server wait).`
          : '';
      findings.push({
        id: `slow-endpoint:${endpoint.key}`,
        rule: 'slow-endpoint',
        severity: chosen,
        category: 'server',
        title: `${name} is slow: p95 ${formatDuration(endpoint.durationMs.p95)}`,
        detail: `p50 ${formatDuration(endpoint.durationMs.p50)}, p95 ${formatDuration(endpoint.durationMs.p95)} over ${endpoint.durationMs.count} call(s); median server wait ${formatDuration(waitP50)}, download ${formatDuration(endpoint.downloadMs?.p50 ?? 0)}.${backend}`,
        recommendation: topTiming
          ? `Start with "${topTiming.name}", the largest server-side component; then cache the response or move work off the request path.`
          : 'Most of the time is spent waiting on the server: add caching, optimize the queries behind it, or emit Server-Timing headers to see where the time goes.',
        subject,
        evidence: {
          p50Ms: endpoint.durationMs.p50,
          p95Ms: endpoint.durationMs.p95,
          serverWaitP50Ms: waitP50,
          calls: endpoint.durationMs.count,
        },
        impact: endpoint.durationMs.p95,
      });
    }

    if (
      endpoint.durationMs.count >= MIN_SAMPLES_FOR_INSTABILITY &&
      endpoint.durationMs.p50 > 0 &&
      endpoint.durationMs.p95 / endpoint.durationMs.p50 >= INSTABILITY_RATIO &&
      endpoint.durationMs.p95 >= 200
    ) {
      findings.push({
        id: `unstable-endpoint:${endpoint.key}`,
        rule: 'unstable-endpoint',
        severity: 'info',
        category: 'server',
        title: `${name} has unstable latency (p95 is ${round(endpoint.durationMs.p95 / endpoint.durationMs.p50)}× p50)`,
        detail: `p50 ${formatDuration(endpoint.durationMs.p50)} vs p95 ${formatDuration(endpoint.durationMs.p95)} over ${endpoint.durationMs.count} calls.`,
        recommendation:
          'Look for cache misses, cold starts, lock contention, or noisy neighbors behind this endpoint.',
        subject,
        evidence: { p50Ms: endpoint.durationMs.p50, p95Ms: endpoint.durationMs.p95 },
        impact: endpoint.durationMs.p95 - endpoint.durationMs.p50,
      });
    }
  }

  const body = endpoint.bodyBytes?.p50;
  if (isApi && body !== undefined) {
    const severity = classify(budgets.apiPayloadBytes, body);
    if (severity) {
      findings.push({
        id: `large-payload:${endpoint.key}`,
        rule: 'large-payload',
        severity,
        category: 'payload',
        title: `${name} returns ${formatBytes(body)} per call`,
        detail: `Median decoded size ${formatBytes(body)}, ${formatBytes(endpoint.transferBytes?.p50 ?? 0)} on the wire.`,
        recommendation:
          'Return only the fields the page uses, paginate collections, and compress responses.',
        subject,
        evidence: { bodyBytes: body, transferBytes: endpoint.transferBytes?.p50 ?? 0 },
        impact: body / 1024,
      });
    }
  }

  if (isApi && endpoint.largestJsonArray !== null) {
    const severity = classify(budgets.jsonArrayItems, endpoint.largestJsonArray);
    if (severity) {
      findings.push({
        id: `oversized-collection:${endpoint.key}`,
        rule: 'oversized-collection',
        severity,
        category: 'payload',
        title: `${name} returns ${endpoint.largestJsonArray.toLocaleString('en-US')} items in one response`,
        detail:
          'Large collections cost server time, transfer time, and client parsing time even when the page only shows a few items.',
        recommendation: 'Paginate (limit/cursor) and let the client request more on demand.',
        subject,
        evidence: { items: endpoint.largestJsonArray },
        impact: endpoint.largestJsonArray / 10,
      });
    }
  }

  const compressible =
    !endpoint.compressed &&
    TEXT_TYPES.test(endpoint.contentType ?? '') &&
    (endpoint.bodyBytes?.p50 ?? 0) >= MIN_COMPRESSIBLE_BYTES;
  if (compressible && endpoint.bodyBytes) {
    findings.push({
      id: `uncompressed:${endpoint.key}`,
      rule: 'uncompressed',
      severity: endpoint.bodyBytes.p50 >= 100 * 1024 ? 'warning' : 'info',
      category: 'payload',
      title: `${name} is served without compression (${formatBytes(endpoint.bodyBytes.p50)})`,
      detail: `Text responses (${endpoint.contentType}) typically shrink 60–90% with gzip or Brotli.`,
      recommendation: 'Enable gzip or Brotli compression on the server or CDN for text responses.',
      subject,
      evidence: { bodyBytes: endpoint.bodyBytes.p50 },
      impact: endpoint.bodyBytes.p50 / 1024,
    });
  }

  const duplicateSeverity = classify(budgets.duplicateCalls, endpoint.maxIdenticalCallsPerLoad);
  if (duplicateSeverity) {
    findings.push({
      id: `duplicate-calls:${endpoint.key}`,
      rule: 'duplicate-calls',
      severity: duplicateSeverity,
      category: 'network',
      title: `${name} is requested ${endpoint.maxIdenticalCallsPerLoad}× with the same URL in one page load`,
      detail: `Seen on: ${endpoint.routes.join(', ')}.`,
      recommendation:
        'Deduplicate in the client (share one in-flight request or cache the result) instead of fetching the same data again.',
      subject,
      evidence: { identicalCalls: endpoint.maxIdenticalCallsPerLoad },
      impact: endpoint.maxIdenticalCallsPerLoad * (endpoint.durationMs?.p50 ?? 10),
    });
  }

  if (endpoint.failures > 0) {
    const serverErrors = Object.entries(endpoint.statusCounts)
      .filter(([status]) => Number(status) >= 500)
      .reduce((sum, [, count]) => sum + count, 0);
    findings.push({
      id: `failing-endpoint:${endpoint.key}`,
      rule: 'failing-endpoint',
      severity: serverErrors > 0 ? 'critical' : 'warning',
      category: 'errors',
      title: `${name} failed ${endpoint.failures} of ${endpoint.calls} time(s)`,
      detail: `Status codes: ${
        Object.entries(endpoint.statusCounts)
          .map(([status, count]) => `${status}×${count}`)
          .join(', ') || 'network errors only'
      }.`,
      recommendation:
        'Fix the failing calls; failed requests waste time and usually mean broken features.',
      subject,
      evidence: { failures: endpoint.failures, calls: endpoint.calls, serverErrors },
      impact: endpoint.failures * 100,
    });
  }
  return findings;
}

/**
 * @param {'critical' | 'warning' | null} a
 * @param {'critical' | 'warning' | null} b
 * @returns {'critical' | 'warning' | null}
 */
function worst(a, b) {
  if (a === 'critical' || b === 'critical') return 'critical';
  if (a === 'warning' || b === 'warning') return 'warning';
  return null;
}

/**
 * @param {string} url
 * @returns {string}
 */
function pathLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
