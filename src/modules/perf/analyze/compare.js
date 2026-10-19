import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { formatBytes, formatDuration } from '../../../core/duration.js';
import { UsageError } from '../../../core/errors.js';

/**
 * Compares a run with an earlier one (its `summary.json`) to surface regressions. Routes are
 * matched by path and query and endpoints by method and path template (plus origin for third
 * parties), so a baseline taken on staging can be compared with a run on localhost.
 *
 * A change only counts when it clears BOTH a relative threshold (10%) and an absolute floor per
 * metric, so normal run-to-run noise on fast pages is not reported as a regression.
 */

const RELATIVE_THRESHOLD = 0.1;
const CRITICAL_RELATIVE = 0.5;
const CRITICAL_FLOOR_MULTIPLIER = 3;
/** Run directories are named <host>_<YYYY-MM-DD_HH-mm-ss>Z, plus -<n> on collision. */
const RUN_SUFFIX = /_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z(?:-\d+)?$/;

/** @typedef {'ms' | 'bytes' | 'count' | 'score'} Unit */

/** @type {Array<{ key: string, label: string, unit: Unit, floor: number, pick: (route: any) => number | undefined }>} */
const ROUTE_METRICS = [
  { key: 'ttfbMs', label: 'TTFB', unit: 'ms', floor: 50, pick: (r) => r.metrics?.ttfbMs?.p50 },
  { key: 'fcpMs', label: 'FCP', unit: 'ms', floor: 100, pick: (r) => r.metrics?.fcpMs?.p50 },
  { key: 'lcpMs', label: 'LCP', unit: 'ms', floor: 100, pick: (r) => r.metrics?.lcpMs?.p50 },
  { key: 'cls', label: 'CLS', unit: 'score', floor: 0.02, pick: (r) => r.metrics?.cls?.p50 },
  { key: 'tbtMs', label: 'TBT', unit: 'ms', floor: 50, pick: (r) => r.metrics?.tbtMs?.p50 },
  { key: 'loadMs', label: 'Load', unit: 'ms', floor: 100, pick: (r) => r.metrics?.loadMs?.p50 },
  {
    key: 'transferBytes',
    label: 'Transferred',
    unit: 'bytes',
    floor: 10 * 1024,
    pick: (r) => r.metrics?.transferBytes?.p50,
  },
  {
    key: 'requestCount',
    label: 'Requests',
    unit: 'count',
    floor: 5,
    pick: (r) => r.metrics?.requestCount?.p50,
  },
];

/** @type {Array<{ key: string, label: string, unit: Unit, floor: number, pick: (endpoint: any) => number | undefined }>} */
const ENDPOINT_METRICS = [
  { key: 'p50Ms', label: 'p50', unit: 'ms', floor: 50, pick: (e) => e.durationMs?.p50 },
  { key: 'p95Ms', label: 'p95', unit: 'ms', floor: 50, pick: (e) => e.durationMs?.p95 },
  {
    key: 'bodyBytes',
    label: 'size',
    unit: 'bytes',
    floor: 10 * 1024,
    pick: (e) => e.bodyBytes?.p50,
  },
];

/**
 * @typedef {object} MetricChange
 * @property {string} metric
 * @property {string} label
 * @property {Unit} unit
 * @property {number} before
 * @property {number} after
 * @property {number} delta
 * @property {number | null} relative Change as a fraction of `before` (null when before is 0).
 * @property {'regression' | 'improvement' | 'unchanged'} verdict
 */

/**
 * @typedef {object} Comparison
 * @property {{ path: string, target: string, startedAt: string }} baseline
 * @property {Array<{ route: string, slug: string, changes: MetricChange[] }>} routes
 * @property {Array<{ endpoint: string, changes: MetricChange[] }>} endpoints
 * @property {string[]} newRoutes Measured now, not in the baseline.
 * @property {string[]} missingRoutes In the baseline, not measured now.
 * @property {string[]} newEndpoints
 * @property {string[]} missingEndpoints
 * @property {{ regressions: number, improvements: number }} counts
 */

/**
 * Locates and reads a baseline summary. `reference` may be `latest` (the newest earlier run for
 * the same host in the output directory), a `summary.json` file, a `perf/` directory, or a run
 * directory.
 *
 * @param {object} options
 * @param {string} options.reference
 * @param {string} options.outputDirectory Absolute base directory for runs.
 * @param {string} options.currentRunDirectory Excluded when looking for `latest`.
 * @returns {Promise<{ path: string, summary: any } | null>} Null when `latest` finds nothing.
 */
export async function loadBaseline({ reference, outputDirectory, currentRunDirectory }) {
  let path;
  if (reference === 'latest') {
    path = await findLatestSummary(outputDirectory, currentRunDirectory);
    if (!path) return null;
  } else {
    path = await resolveSummaryPath(reference);
  }

  let summary;
  try {
    summary = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`Could not read baseline ${path}.`, { cause: error });
  }
  if (
    summary?.schemaVersion !== 1 ||
    !Array.isArray(summary.routes) ||
    !Array.isArray(summary.endpoints)
  ) {
    throw new UsageError(`Baseline ${path} is not a LaunchScope perf summary (schemaVersion 1).`);
  }
  return { path, summary };
}

/**
 * @param {string} reference
 * @returns {Promise<string>}
 */
async function resolveSummaryPath(reference) {
  const candidates = [
    reference,
    join(reference, 'summary.json'),
    join(reference, 'perf', 'summary.json'),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next layout.
    }
  }
  throw new UsageError(`No LaunchScope summary found at ${reference}.`, {
    hint: 'Pass a summary.json file, a perf/ directory, or a run directory.',
  });
}

/**
 * @param {string} outputDirectory
 * @param {string} currentRunDirectory
 * @returns {Promise<string | null>}
 */
async function findLatestSummary(outputDirectory, currentRunDirectory) {
  const current = basename(currentRunDirectory);
  const host = current.replace(RUN_SUFFIX, '');
  let entries;
  try {
    entries = await readdir(outputDirectory);
  } catch {
    return null;
  }
  const previous = entries
    .filter(
      (name) => name !== current && name.replace(RUN_SUFFIX, '') === host && RUN_SUFFIX.test(name),
    )
    .sort()
    .reverse();
  for (const name of previous) {
    const candidate = join(resolve(outputDirectory), name, 'perf', 'summary.json');
    try {
      const summary = JSON.parse(await readFile(candidate, 'utf8'));
      if (!summary.interrupted) return candidate;
    } catch {
      // Not a completed perf run; keep looking.
    }
  }
  return null;
}

/**
 * @param {object} input
 * @param {{ routes: any[], endpoints: any[] }} input.current
 * @param {any} input.baseline Baseline summary.
 * @param {string} input.baselinePath
 * @returns {Comparison}
 */
export function compareRuns({ current, baseline, baselinePath }) {
  const baselineRoutes = new Map(
    baseline.routes.map((/** @type {any} */ route) => [routeKey(route.url), route]),
  );
  const currentRoutes = new Map(current.routes.map((route) => [routeKey(route.url), route]));
  const baselineEndpoints = new Map(
    baseline.endpoints.map((/** @type {any} */ endpoint) => [endpointKey(endpoint), endpoint]),
  );
  const currentEndpoints = new Map(
    current.endpoints.map((endpoint) => [endpointKey(endpoint), endpoint]),
  );

  const routes = [];
  for (const [key, route] of currentRoutes) {
    const before = baselineRoutes.get(key);
    if (!before || route.error || before.error) continue;
    routes.push({ route: key, slug: route.slug, changes: diff(ROUTE_METRICS, before, route) });
  }
  const endpoints = [];
  for (const [key, endpoint] of currentEndpoints) {
    const before = baselineEndpoints.get(key);
    if (!before) continue;
    endpoints.push({ endpoint: key, changes: diff(ENDPOINT_METRICS, before, endpoint) });
  }

  const all = [...routes, ...endpoints].flatMap((entry) => entry.changes);
  return {
    baseline: { path: baselinePath, target: baseline.target, startedAt: baseline.startedAt },
    routes,
    endpoints,
    newRoutes: [...currentRoutes.keys()].filter((key) => !baselineRoutes.has(key)),
    missingRoutes: [...baselineRoutes.keys()].filter((key) => !currentRoutes.has(key)),
    newEndpoints: [...currentEndpoints.keys()].filter((key) => !baselineEndpoints.has(key)),
    missingEndpoints: [...baselineEndpoints.keys()].filter((key) => !currentEndpoints.has(key)),
    counts: {
      regressions: all.filter((change) => change.verdict === 'regression').length,
      improvements: all.filter((change) => change.verdict === 'improvement').length,
    },
  };
}

/**
 * Turns regressions into findings so they rank with everything else and count toward
 * `--fail-on`.
 *
 * @param {Comparison} comparison
 * @returns {import('./bottlenecks.js').Finding[]}
 */
export function regressionFindings(comparison) {
  /** @type {import('./bottlenecks.js').Finding[]} */
  const findings = [];
  const since = `baseline from ${comparison.baseline.startedAt}`;
  for (const { route, slug, changes } of comparison.routes) {
    for (const change of changes.filter((c) => c.verdict === 'regression')) {
      findings.push(toFinding(change, `${change.label} on ${route}`, { route: slug }, since));
    }
  }
  for (const { endpoint, changes } of comparison.endpoints) {
    for (const change of changes.filter((c) => c.verdict === 'regression')) {
      findings.push(toFinding(change, `${endpoint} ${change.label}`, { endpoint }, since));
    }
  }
  return findings;
}

/**
 * @param {MetricChange} change
 * @param {string} subjectLabel
 * @param {{ route?: string, endpoint?: string }} subject
 * @param {string} since
 * @returns {import('./bottlenecks.js').Finding}
 */
function toFinding(change, subjectLabel, subject, since) {
  const floor = floorFor(change.metric);
  const critical =
    (change.relative ?? Infinity) >= CRITICAL_RELATIVE &&
    change.delta >= floor * CRITICAL_FLOOR_MULTIPLIER;
  const percent = change.relative === null ? 'new' : `+${Math.round(change.relative * 100)}%`;
  return {
    id: `regression:${subjectLabel}`,
    rule: 'regression',
    severity: critical ? 'critical' : 'warning',
    category: 'regression',
    title: `${subjectLabel} regressed ${percent}: ${format(change.unit, change.before)} → ${format(change.unit, change.after)}`,
    detail: `Compared with the ${since}. Changes count once they exceed ${Math.round(RELATIVE_THRESHOLD * 100)}% and ${format(change.unit, floor)}.`,
    recommendation:
      'Look at what changed since the baseline (deploys, dependencies, data volume) for this route or endpoint.',
    subject,
    evidence: { before: change.before, after: change.after, delta: change.delta },
    impact: change.unit === 'bytes' ? change.delta / 1024 : change.delta,
  };
}

/**
 * @param {typeof ROUTE_METRICS | typeof ENDPOINT_METRICS} metrics
 * @param {any} before
 * @param {any} after
 * @returns {MetricChange[]}
 */
function diff(metrics, before, after) {
  /** @type {MetricChange[]} */
  const changes = [];
  for (const metric of metrics) {
    const previous = metric.pick(before);
    const next = metric.pick(after);
    if (previous === undefined || next === undefined) continue;
    const delta = round(next - previous);
    const relative = previous === 0 ? null : round(delta / previous, 4);
    const significant =
      Math.abs(delta) >= metric.floor &&
      (relative === null || Math.abs(relative) >= RELATIVE_THRESHOLD);
    changes.push({
      metric: metric.key,
      label: metric.label,
      unit: metric.unit,
      before: previous,
      after: next,
      delta,
      relative,
      verdict: !significant ? 'unchanged' : delta > 0 ? 'regression' : 'improvement',
    });
  }
  return changes;
}

/** @param {string} metric */
function floorFor(metric) {
  return [...ROUTE_METRICS, ...ENDPOINT_METRICS].find((m) => m.key === metric)?.floor ?? 0;
}

/**
 * @param {Unit} unit
 * @param {number} value
 * @returns {string}
 */
export function format(unit, value) {
  if (unit === 'ms') return formatDuration(value);
  if (unit === 'bytes') return formatBytes(value);
  if (unit === 'score') return value.toFixed(3);
  return String(Math.round(value));
}

/** @param {string} url */
function routeKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** @param {any} endpoint */
function endpointKey(endpoint) {
  const origin = endpoint.thirdParty ? endpoint.origin : '';
  const operation = endpoint.graphqlOperation ? ` ${endpoint.graphqlOperation}` : '';
  return `${endpoint.method} ${origin}${endpoint.pathTemplate}${operation}`;
}

/**
 * @param {number} value
 * @param {number} [digits]
 */
function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
