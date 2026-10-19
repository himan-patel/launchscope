import { formatBytes, formatDuration } from '../../../core/duration.js';
import { endpointLabel, routeLabel } from './charts.js';
import { format as formatMetric } from '../analyze/compare.js';
import { toCsv } from './escape.js';

/**
 * CSV exports (for spreadsheets) and the Markdown summary (for PRs, tickets, and chat).
 */

/**
 * @param {import('../analyze/routes.js').RouteSummary[]} routes
 * @returns {string}
 */
export function routesCsv(routes) {
  return toCsv(
    [
      'route',
      'url',
      'status',
      'cold_runs',
      'failed_runs',
      'ttfb_p50_ms',
      'fcp_p50_ms',
      'lcp_p50_ms',
      'lcp_p95_ms',
      'cls_p50',
      'tbt_p50_ms',
      'load_p50_ms',
      'requests_p50',
      'transfer_bytes_p50',
      'decoded_bytes_p50',
      'third_party_bytes_p50',
      'api_calls_p50',
      'error',
    ],
    routes.map((route) => {
      const m = route.metrics;
      return [
        routeLabel(route.url),
        route.url,
        route.status,
        route.runs.cold,
        route.runs.failed,
        m.ttfbMs?.p50,
        m.fcpMs?.p50,
        m.lcpMs?.p50,
        m.lcpMs?.p95,
        m.cls?.p50,
        m.tbtMs?.p50,
        m.loadMs?.p50,
        m.requestCount?.p50,
        m.transferBytes?.p50,
        m.bodyBytes?.p50,
        m.thirdPartyBytes?.p50,
        m.apiCalls?.p50,
        route.error,
      ];
    }),
  );
}

/**
 * @param {import('../analyze/endpoints.js').EndpointSummary[]} endpoints
 * @returns {string}
 */
export function endpointsCsv(endpoints) {
  return toCsv(
    [
      'endpoint',
      'method',
      'origin',
      'path_template',
      'type',
      'third_party',
      'calls',
      'routes',
      'max_identical_calls_per_load',
      'p50_ms',
      'p95_ms',
      'p99_ms',
      'server_wait_p50_ms',
      'download_p50_ms',
      'transfer_bytes_p50',
      'decoded_bytes_p50',
      'compressed',
      'failures',
      'largest_json_array',
      'graphql_operation',
      'graphql_type',
      'discovered_by',
      'status_counts',
      'server_timing',
    ],
    endpoints.map((endpoint) => [
      endpoint.key,
      endpoint.method,
      endpoint.origin,
      endpoint.pathTemplate,
      endpoint.resourceType,
      endpoint.thirdParty,
      endpoint.calls,
      endpoint.routes.join(' '),
      endpoint.maxIdenticalCallsPerLoad,
      endpoint.durationMs?.p50,
      endpoint.durationMs?.p95,
      endpoint.durationMs?.p99,
      endpoint.waitMs?.p50,
      endpoint.downloadMs?.p50,
      endpoint.transferBytes?.p50,
      endpoint.bodyBytes?.p50,
      endpoint.compressed,
      endpoint.failures,
      endpoint.largestJsonArray,
      endpoint.graphqlOperation,
      endpoint.graphqlType,
      (endpoint.discoveredBy ?? ['page']).join(' '),
      Object.entries(endpoint.statusCounts)
        .map(([status, count]) => `${status}:${count}`)
        .join(' '),
      endpoint.serverTiming.map((metric) => `${metric.name}:${metric.meanMs}`).join(' '),
    ]),
  );
}

/**
 * @param {import('../stress/runner.js').StressResult} stress
 * @returns {{ stages: string, hops: string }}
 */
export function stressCsv(stress) {
  const stages = toCsv(
    [
      'mode',
      'load',
      'concurrency',
      'target_rate',
      'achieved_rate',
      'dropped',
      'duration_ms',
      'requests',
      'iterations',
      'errors',
      'error_rate',
      'requests_per_second',
      'p50_ms',
      'p95_ms',
      'p99_ms',
      'max_ms',
      'iteration_p50_ms',
      'bytes_received',
      'aborted',
    ],
    stress.stages.map((stage) => [
      stage.mode,
      stage.load,
      stage.concurrency,
      stage.targetRate,
      stage.achievedRate,
      stage.dropped,
      stage.durationMs,
      stage.requests,
      stage.iterations,
      stage.errors,
      stage.errorRate,
      stage.requestsPerSecond,
      stage.latencyMs?.p50,
      stage.latencyMs?.p95,
      stage.latencyMs?.p99,
      stage.latencyMs?.max,
      stage.iterationMs?.p50,
      stage.bytesReceived,
      stage.aborted,
    ]),
  );
  const hops = toCsv(
    ['load', 'hop', 'kind', 'requests', 'errors', 'p50_ms', 'p95_ms', 'p99_ms'],
    stress.stages.flatMap((stage) =>
      stage.hops.map((hop) => [
        stage.load,
        hop.label,
        hop.kind,
        hop.requests,
        hop.errors,
        hop.latencyMs?.p50,
        hop.latencyMs?.p95,
        hop.latencyMs?.p99,
      ]),
    ),
  );
  return { stages, hops };
}

const SEVERITY_ICON = /** @type {const} */ ({ critical: '🔴', warning: '🟠', info: '⚪' });

/**
 * @param {any} summary
 * @returns {string}
 */
export function summaryMarkdown(summary) {
  /** @type {import('../analyze/routes.js').RouteSummary[]} */
  const routes = summary.routes;
  /** @type {import('../analyze/endpoints.js').EndpointSummary[]} */
  const endpoints = summary.endpoints;
  /** @type {import('../analyze/bottlenecks.js').Finding[]} */
  const findings = summary.bottlenecks;
  const counts = summary.totals.findings;
  const lines = [
    `# LaunchScope performance report: ${new URL(summary.target).host}`,
    '',
    `- **Target:** ${summary.target}`,
    `- **Started:** ${summary.startedAt}`,
    `- **Measured:** ${summary.totals.routes} route(s), ${summary.totals.pageLoads} page load(s), ${summary.totals.endpoints} endpoint(s)`,
    `- **Bottlenecks:** ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info`,
    '',
    '## Bottlenecks',
    '',
  ];
  if (findings.length === 0) lines.push('No bottlenecks found within the configured budgets.', '');
  for (const finding of findings) {
    lines.push(
      `- ${SEVERITY_ICON[finding.severity]} **${finding.severity}**: ${md(finding.title)}  `,
      `  ${md(finding.detail)}  `,
      `  _Recommendation:_ ${md(finding.recommendation)}`,
    );
  }
  lines.push(
    '',
    '## Routes',
    '',
    '| Route | Status | TTFB | FCP | LCP | CLS | TBT | Requests | Transferred |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...routes.map((route) => {
      const m = route.metrics;
      return `| ${md(routeLabel(route.url))} | ${route.error ? 'failed' : (route.status ?? '–')} | ${dur(m.ttfbMs?.p50)} | ${dur(m.fcpMs?.p50)} | ${dur(m.lcpMs?.p50)} | ${m.cls ? m.cls.p50.toFixed(3) : '–'} | ${dur(m.tbtMs?.p50)} | ${m.requestCount ? Math.round(m.requestCount.p50) : '–'} | ${size(m.transferBytes?.p50)} |`;
    }),
    '',
    '## Slowest endpoints',
    '',
    '| Endpoint | Calls | p50 | p95 | Server wait | Size |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...endpoints
      .filter((endpoint) => endpoint.durationMs)
      .slice(0, 15)
      .map(
        (endpoint) =>
          `| \`${md(endpointLabel(endpoint))}\` | ${endpoint.calls} | ${dur(endpoint.durationMs?.p50)} | ${dur(endpoint.durationMs?.p95)} | ${dur(endpoint.waitMs?.p50)} | ${size(endpoint.bodyBytes?.p50)} |`,
      ),
  );
  if (summary.navigations && summary.navigations.length > 0) {
    /** @type {import('../navigation-phase.js').NavigationSummary[]} */
    const navigations = summary.navigations;
    lines.push(
      '',
      '## Client-side navigations',
      '',
      '| Navigation | Kind | Duration | Requests | Transferred |',
      '| --- | --- | ---: | ---: | ---: |',
      ...navigations.map(
        (navigation) =>
          `| ${md(routeLabel(navigation.from))} → ${md(routeLabel(navigation.to))} | ${navigation.kind === 'soft' ? 'client-side' : navigation.kind === 'full' ? 'full page load' : 'failed'} | ${dur(navigation.durationMs?.p50)} | ${navigation.requestCount ? Math.round(navigation.requestCount.p50) : '–'} | ${size(navigation.transferBytes?.p50)} |`,
      ),
    );
  }
  if (summary.browsers && summary.browsers.length > 0) {
    /** @type {import('../cross-browser-phase.js').BrowserResult[]} */
    const browsers = summary.browsers;
    const names = browsers.map((entry) => (entry.browser === 'firefox' ? 'Firefox' : 'WebKit'));
    lines.push(
      '',
      '## Cross-browser',
      '',
      `| Route | Chromium load | ${names.map((name) => `${name} load`).join(' | ')} |`,
      `| --- | ---: | ${names.map(() => '---:').join(' | ')} |`,
      ...routes.map((route) => {
        const cells = browsers.map((entry) => {
          const match = entry.routes.find((candidate) => candidate.slug === route.slug);
          return match?.error ? 'failed' : dur(match?.metrics.loadMs?.p50);
        });
        return `| ${md(routeLabel(route.url))} | ${dur(route.metrics.loadMs?.p50)} | ${cells.join(' | ')} |`;
      }),
    );
  }
  if (summary.comparison) {
    /** @type {import('../analyze/compare.js').Comparison} */
    const comparison = summary.comparison;
    const rows = [
      ...comparison.routes.map((entry) => ({ name: entry.route, changes: entry.changes })),
      ...comparison.endpoints.map((entry) => ({
        name: `\`${md(entry.endpoint)}\``,
        changes: entry.changes,
      })),
    ].flatMap((entry) =>
      entry.changes
        .filter((change) => change.verdict !== 'unchanged')
        .map(
          (change) =>
            `| ${entry.name} | ${change.label} | ${formatMetric(change.unit, change.before)} | ${formatMetric(change.unit, change.after)} | ${change.relative === null ? '–' : `${change.relative > 0 ? '+' : ''}${Math.round(change.relative * 100)}%`} | ${change.verdict === 'regression' ? '🔺 regression' : '🔻 improvement'} |`,
        ),
    );
    lines.push(
      '',
      '## Compared with baseline',
      '',
      `Baseline from ${comparison.baseline.startedAt}: ${comparison.counts.regressions} regression(s), ${comparison.counts.improvements} improvement(s).`,
      '',
    );
    if (rows.length > 0) {
      lines.push(
        '| Route / endpoint | Metric | Before | After | Change | |',
        '| --- | --- | ---: | ---: | ---: | --- |',
        ...rows,
      );
    } else {
      lines.push('No significant changes.');
    }
  }
  if (summary.stress) {
    /** @type {import('../stress/runner.js').StageResult[]} */
    const stages = summary.stress.stages;
    lines.push(
      '',
      '## Stress test',
      '',
      `| ${summary.stress.mode === 'open' ? 'Replays/s' : 'Users'} | Req/s | p50 | p95 | p99 | Errors |`,
      '| ---: | ---: | ---: | ---: | ---: | ---: |',
      ...stages.map(
        (stage) =>
          `| ${stage.load} | ${stage.requestsPerSecond.toFixed(1)} | ${dur(stage.latencyMs?.p50)} | ${dur(stage.latencyMs?.p95)} | ${dur(stage.latencyMs?.p99)} | ${(stage.errorRate * 100).toFixed(1)}% |`,
      ),
    );
    if (summary.stress.stoppedReason) lines.push('', `> ${md(summary.stress.stoppedReason)}`);
  }
  lines.push('', `_Open \`index.html\` in this folder for charts, waterfalls, and hop trees._`, '');
  return lines.join('\n');
}

/** @param {number | null | undefined} value */
const dur = (value) => (value === null || value === undefined ? '–' : formatDuration(value));
/** @param {number | null | undefined} value */
const size = (value) => (value === null || value === undefined ? '–' : formatBytes(value));

/**
 * Escapes characters with meaning in Markdown tables and inline formatting.
 *
 * @param {string} text
 * @returns {string}
 */
function md(text) {
  return String(text)
    .replace(/[\\|`*_[\]<>]/g, (char) => `\\${char}`)
    .replace(/\r?\n/g, ' ');
}
