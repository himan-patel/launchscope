import { formatBytes } from '../../../core/duration.js';
import { describeNode } from '../trace/hop-tree.js';
import {
  formatMs,
  groupedBarChart,
  lineChart,
  stackedBarChart,
  TYPE_GROUPS,
  typeClass,
  typeGroup,
  waterfallChart,
} from './svg.js';

export const MAX_WATERFALL_ROWS = 150;
const MAX_ENDPOINT_ROWS = 15;

/**
 * @typedef {ReturnType<typeof waterfallChart>} ChartSpec
 */

/**
 * @param {object} input
 * @param {string} input.routeLabel
 * @param {import('../trace/hop-tree.js').Trace} input.trace
 * @param {import('../capture/page-capture.js').PageLoad} input.load Representative load.
 * @returns {ChartSpec}
 */
export function routeWaterfall({ routeLabel, trace, load }) {
  const requests = new Map(load.requests.map((request) => [request.id, request]));
  const critical = new Set(trace.criticalPath?.segments.map((segment) => segment.id) ?? []);
  const rows = trace.nodes.slice(0, MAX_WATERFALL_ROWS).map((node) => {
    const request = requests.get(node.id);
    const phases = request?.phases;
    const timing = phases
      ? ` · queue ${round(phases.queueMs)} · dns ${round(phases.dnsMs)} · connect ${round(phases.connectMs)} · tls ${round(phases.tlsMs)} · wait ${round(phases.waitMs)} · download ${round(phases.downloadMs)} ms`
      : '';
    return {
      label: describeNode(node),
      group: typeGroup(node.resourceType),
      startMs: node.startMs,
      responseStartMs: request?.responseStartMs ?? null,
      endMs: node.endMs,
      critical: critical.has(node.id),
      tip: `${node.method} ${node.url}\n${node.resourceType}${node.status ? ` ${node.status}` : ''} · ${formatMs(node.durationMs)} · ${formatBytes(node.transferBytes)} transferred${timing}${critical.has(node.id) ? '\nOn the critical path' : ''}`,
    };
  });
  /** @type {Array<{ label: string, atMs: number }>} */
  const markers = [];
  if (load.vitals?.fcpMs) markers.push({ label: 'FCP', atMs: load.vitals.fcpMs });
  if (load.vitals?.lcpMs) markers.push({ label: 'LCP', atMs: load.vitals.lcpMs });
  const truncated =
    trace.nodes.length > MAX_WATERFALL_ROWS
      ? ` (first ${MAX_WATERFALL_ROWS} of ${trace.nodes.length} requests)`
      : '';
  return waterfallChart({
    rows,
    markers,
    title: `Request waterfall for ${routeLabel}${truncated}`,
  });
}

/**
 * @param {import('../analyze/endpoints.js').EndpointSummary[]} endpoints
 * @returns {ChartSpec | null}
 */
export function endpointLatencyChart(endpoints) {
  const rows = endpoints
    .filter((endpoint) => endpoint.durationMs)
    .slice(0, MAX_ENDPOINT_ROWS)
    .map((endpoint) => ({
      label: endpointLabel(endpoint),
      values: { p50: endpoint.durationMs?.p50 ?? null, p95: endpoint.durationMs?.p95 ?? null },
      tip: `${endpoint.key}\np50 ${formatMs(endpoint.durationMs?.p50 ?? 0)} · p95 ${formatMs(endpoint.durationMs?.p95 ?? 0)} · ${endpoint.calls} call(s)`,
    }));
  if (rows.length === 0) return null;
  return groupedBarChart({
    rows,
    series: [
      { key: 'p50', label: 'p50', cls: 's1' },
      { key: 'p95', label: 'p95', cls: 's2' },
    ],
    format: formatMs,
    title: 'Slowest endpoints by p95 duration',
  });
}

/**
 * @param {import('../analyze/routes.js').RouteSummary[]} routes
 * @returns {ChartSpec | null}
 */
export function bytesByTypeChart(routes) {
  const rows = routes
    .filter((route) => route.resourceTypes.length > 0)
    .map((route) => {
      /** @type {Map<string, number>} */
      const byGroup = new Map();
      for (const entry of route.resourceTypes) {
        const group = typeGroup(entry.type);
        byGroup.set(group, (byGroup.get(group) ?? 0) + entry.transferBytes);
      }
      return {
        label: routeLabel(route.url),
        segments: [...byGroup].map(([key, value]) => ({ key, value })),
        tip: `${route.url}\n${[...byGroup].map(([key, value]) => `${key} ${formatBytes(value)}`).join(' · ')}`,
      };
    });
  if (rows.length === 0) return null;
  const used = new Set(rows.flatMap((row) => row.segments.map((segment) => segment.key)));
  return stackedBarChart({
    rows,
    series: TYPE_GROUPS.filter((group) => used.has(group)).map((group) => ({
      key: group,
      label: group,
      cls: typeClass(group),
    })),
    format: formatBytes,
    title: 'Transferred bytes by resource type (representative load)',
  });
}

/**
 * @param {import('../stress/runner.js').StressResult} stress
 * @returns {{ latency: ChartSpec, throughput: ChartSpec, errors: ChartSpec | null } | null}
 */
export function stressCharts(stress) {
  const stages = stress.stages.filter((stage) => stage.requests > 0);
  if (stages.length === 0) return null;
  const xLabels = stages.map((stage) => String(stage.load ?? stage.concurrency));
  const xTitle = stress.mode === 'open' ? 'replays per second' : 'concurrent users';
  const latency = lineChart({
    xLabels,
    xTitle,
    series: [
      { key: 'p50', label: 'p50', cls: 's1', values: stages.map((s) => s.latencyMs?.p50 ?? null) },
      { key: 'p95', label: 'p95', cls: 's2', values: stages.map((s) => s.latencyMs?.p95 ?? null) },
      { key: 'p99', label: 'p99', cls: 's3', values: stages.map((s) => s.latencyMs?.p99 ?? null) },
    ],
    format: formatMs,
    title: `Request latency by ${stress.mode === 'open' ? 'arrival rate' : 'concurrency'}`,
  });
  const throughput = lineChart({
    xLabels,
    xTitle,
    series: [
      {
        key: 'rps',
        label: 'Requests per second',
        cls: 's1',
        values: stages.map((stage) => stage.requestsPerSecond),
      },
    ],
    format: (value) => `${Math.round(value)}/s`,
    title: `Throughput (requests per second) by ${stress.mode === 'open' ? 'arrival rate' : 'concurrency'}`,
  });
  const errors = stages.some((stage) => stage.errors > 0)
    ? lineChart({
        xLabels,
        xTitle,
        series: [
          {
            key: 'errors',
            label: 'Error rate',
            cls: 's1',
            values: stages.map((stage) => stage.errorRate * 100),
          },
        ],
        format: (value) => `${Math.round(value * 10) / 10}%`,
        title: `Error rate by ${stress.mode === 'open' ? 'arrival rate' : 'concurrency'}`,
      })
    : null;
  return { latency, throughput, errors };
}

/**
 * @param {import('../analyze/endpoints.js').EndpointSummary} endpoint
 * @returns {string}
 */
export function endpointLabel(endpoint) {
  const host = endpoint.thirdParty ? new URL(endpoint.origin).host : '';
  const operation = endpoint.graphqlOperation ? ` (${endpoint.graphqlOperation})` : '';
  return `${endpoint.method} ${host}${endpoint.pathTemplate}${operation}`;
}

/**
 * @param {string} url
 * @returns {string}
 */
export function routeLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** @param {number} value */
function round(value) {
  return Math.round(value);
}
