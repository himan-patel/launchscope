import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectBottlenecks, sortFindings } from './bottlenecks.js';
import { resolveBudgets } from './budgets.js';
import { summarize } from './stats.js';

const budgets = resolveBudgets(undefined);

/**
 * @param {Partial<import('./routes.js').RouteSummary>} overrides
 * @returns {import('./routes.js').RouteSummary}
 */
function route(overrides = {}) {
  const empty = {
    ttfbMs: null,
    fcpMs: null,
    lcpMs: null,
    cls: null,
    tbtMs: null,
    domContentLoadedMs: null,
    loadMs: null,
    wallTimeMs: null,
    requestCount: null,
    transferBytes: null,
    bodyBytes: null,
    thirdPartyBytes: null,
    apiCalls: null,
  };
  return {
    url: 'https://app.test/pricing',
    slug: 'pricing',
    depth: 0,
    source: 'seed',
    title: 'Pricing',
    status: 200,
    finalUrl: 'https://app.test/pricing',
    runs: { cold: 3, warm: 0, failed: 0 },
    error: null,
    metrics: empty,
    warmMetrics: null,
    resourceTypes: [],
    thirdParty: { requests: 0, transferBytes: 0, origins: [] },
    consoleErrors: [],
    pageErrors: [],
    representativeRun: 1,
    ...overrides,
  };
}

/**
 * @param {Partial<import('./endpoints.js').EndpointSummary>} overrides
 * @returns {import('./endpoints.js').EndpointSummary}
 */
function endpoint(overrides = {}) {
  return {
    key: 'GET https://app.test/api/x',
    method: 'GET',
    origin: 'https://app.test',
    pathTemplate: '/api/x',
    resourceType: 'Fetch',
    thirdParty: false,
    sampleUrl: 'https://app.test/api/x',
    routes: ['pricing'],
    calls: 5,
    maxCallsPerLoad: 1,
    maxIdenticalCallsPerLoad: 1,
    durationMs: summarize([50, 55, 60, 52, 58]),
    waitMs: summarize([40, 40, 40, 40, 40]),
    downloadMs: summarize([5, 5, 5, 5, 5]),
    transferBytes: summarize([500]),
    bodyBytes: summarize([800]),
    statusCounts: { 200: 5 },
    failures: 0,
    redirects: 0,
    compressed: true,
    contentType: 'application/json',
    cacheControl: null,
    serverTiming: [],
    largestJsonArray: null,
    graphqlOperation: null,
    graphqlType: null,
    ...overrides,
  };
}

/**
 * @param {{ routes?: import('./routes.js').RouteSummary[], endpoints?: import('./endpoints.js').EndpointSummary[] }} input
 */
const detect = ({ routes = [], endpoints = [] }) =>
  detectBottlenecks({ routes, traces: new Map(), endpoints, budgets });

describe('detectBottlenecks', () => {
  it('reports nothing for a healthy route and endpoint', () => {
    assert.deepEqual(detect({ routes: [route()], endpoints: [endpoint()] }), []);
  });

  it('reports a route that failed every run as critical and skips other route rules', () => {
    const findings = detect({ routes: [route({ error: 'net::ERR_CONNECTION_REFUSED' })] });
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.severity]),
      [['route-failed', 'critical']],
    );
  });

  it('flags HTTP error pages and suggests a session for 401s', () => {
    const [finding] = detect({ routes: [route({ status: 401 })] });
    assert.equal(finding.rule, 'route-status');
    assert.equal(finding.severity, 'warning');
    assert.match(finding.recommendation, /--storage-state/);
    assert.equal(detect({ routes: [route({ status: 503 })] })[0].severity, 'critical');
  });

  it('applies Web Vitals budgets to medians', () => {
    const findings = detect({
      routes: [
        route({
          metrics: {
            ...route().metrics,
            lcpMs: summarize([4200, 4100, 4300]),
            cls: summarize([0.12, 0.15, 0.11]),
            tbtMs: summarize([10, 20, 15]),
          },
        }),
      ],
    });
    const byRule = Object.fromEntries(findings.map((finding) => [finding.rule, finding.severity]));
    assert.deepEqual(byRule, { 'vitals-lcpMs': 'critical', 'vitals-cls': 'warning' });
  });

  it('notes heavy third-party weight and JavaScript errors', () => {
    const findings = detect({
      routes: [
        route({
          metrics: {
            ...route().metrics,
            transferBytes: summarize([1000]),
            thirdPartyBytes: summarize([700]),
          },
          thirdParty: { requests: 4, transferBytes: 700, origins: ['https://ads.test'] },
          pageErrors: ['TypeError: x is undefined'],
        }),
      ],
    });
    assert.deepEqual(findings.map((finding) => finding.rule).sort(), ['js-errors', 'third-party']);
  });

  it('flags failing endpoints, critical when the server errors', () => {
    const [finding] = detect({
      endpoints: [endpoint({ failures: 2, statusCounts: { 200: 3, 502: 2 } })],
    });
    assert.equal(finding.rule, 'failing-endpoint');
    assert.equal(finding.severity, 'critical');
    assert.match(finding.detail, /502×2/);
  });

  it('flags unstable latency when p95 is far above p50', () => {
    const findings = detect({
      endpoints: [endpoint({ durationMs: summarize([40, 45, 50, 42, 48, 41, 400, 44, 46, 600]) })],
    });
    assert.ok(findings.some((finding) => finding.rule === 'unstable-endpoint'));
  });

  it('does not flag compression for small or already-compressed responses', () => {
    const findings = detect({
      endpoints: [
        endpoint({ compressed: false, bodyBytes: summarize([900]) }),
        endpoint({ key: 'b', compressed: true, bodyBytes: summarize([90_000]) }),
      ],
    });
    assert.ok(!findings.some((finding) => finding.rule === 'uncompressed'));
  });
});

describe('sortFindings', () => {
  it('orders by severity, then impact', () => {
    /** @param {'critical' | 'warning' | 'info'} severity @param {number} impact */
    const finding = (severity, impact) => ({
      id: `${severity}-${impact}`,
      rule: 'x',
      severity,
      category: 'x',
      title: 'x',
      detail: 'x',
      recommendation: 'x',
      subject: {},
      evidence: {},
      impact,
    });
    const sorted = sortFindings([
      finding('info', 999),
      finding('warning', 1),
      finding('critical', 5),
      finding('warning', 50),
    ]);
    assert.deepEqual(
      sorted.map((item) => item.id),
      ['critical-5', 'warning-50', 'warning-1', 'info-999'],
    );
  });
});
