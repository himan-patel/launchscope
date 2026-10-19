import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveBudgets } from './budgets.js';
import { analyzeRun, RunAccumulator } from './index.js';

/**
 * @param {string} url
 * @param {{ cache?: 'cold' | 'warm', error?: string | null, run?: number }} [options]
 * @returns {import('../capture/page-capture.js').PageLoad}
 */
function load(url, { cache = 'cold', error = null, run = 1 } = {}) {
  return {
    url,
    finalUrl: error ? null : url,
    cache,
    run,
    status: error ? null : 200,
    title: 'Page',
    startedAt: '2026-10-19T00:00:00.000Z',
    wallTimeMs: 100,
    networkIdle: true,
    vitals: null,
    requests: error
      ? []
      : [
          /** @type {any} */ ({
            id: `${url}-${run}`,
            url: `${new URL(url).origin}/api/items/${run}`,
            method: 'GET',
            resourceType: 'Fetch',
            status: 200,
            durationMs: 50,
            transferBytes: 10,
            bodyBytes: 10,
            headers: {},
            redirects: [],
            failure: null,
            pending: false,
            streaming: false,
            phases: null,
            jsonShape: null,
            graphql: null,
            isMainFrame: true,
          }),
        ],
    consoleErrors: [],
    pageErrors: [],
    links: [],
    sockets: [],
    error,
    traceId: null,
  };
}

describe('RunAccumulator', () => {
  const inputs = [
    {
      url: 'https://app.test/a',
      slug: 'a',
      depth: 0,
      source: 'seed',
      loads: [
        load('https://app.test/a'),
        load('https://app.test/a', { run: 2 }),
        load('https://app.test/a', { cache: 'warm' }),
      ],
      trace: null,
      representativeRun: 1,
    },
    {
      url: 'https://app.test/b',
      slug: 'b',
      depth: 1,
      source: 'link',
      loads: [load('https://app.test/b', { error: 'net::ERR_FAILED' })],
      trace: null,
      representativeRun: null,
    },
  ];

  it('folds routes in one at a time and returns the summary of each', () => {
    const accumulator = new RunAccumulator();
    const first = accumulator.addRoute(inputs[0]);
    assert.equal(first.slug, 'a');
    assert.equal(first.runs.cold, 2);
    accumulator.addRoute(inputs[1]);

    const analysis = accumulator.finish(resolveBudgets(undefined));
    assert.deepEqual(
      { ...analysis.totals, findings: undefined },
      { routes: 2, failedRoutes: 1, pageLoads: 4, requests: 3, endpoints: 1, findings: undefined },
    );
    const [items] = analysis.endpoints;
    assert.equal(items.key, 'GET https://app.test/api/items/:id');
    assert.equal(items.calls, 2, 'only successful cold loads feed endpoint statistics');
    assert.ok(analysis.bottlenecks.some((finding) => finding.rule === 'route-failed'));
  });

  it('matches the all-at-once analyzeRun wrapper', () => {
    const budgets = resolveBudgets(undefined);
    const accumulator = new RunAccumulator();
    for (const input of inputs) accumulator.addRoute(input);
    assert.deepEqual(accumulator.finish(budgets), analyzeRun(inputs, budgets));
  });
});
