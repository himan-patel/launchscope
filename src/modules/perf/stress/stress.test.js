import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveBudgets } from '../analyze/budgets.js';
import { summarize } from '../analyze/stats.js';
import { buildTrace } from '../trace/hop-tree.js';
import { analyzeStress } from './analyze.js';
import { runStress } from './runner.js';
import { assertStressAllowed } from './safety.js';
import { buildScenarios, loadCookieJar } from './scenario.js';

/** @param {string[]} addresses */
const fakeLookup = (addresses) => async () =>
  addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('assertStressAllowed', () => {
  it('allows loopback and private targets', async () => {
    assert.deepEqual(
      await assertStressAllowed({
        targetUrl: new URL('http://localhost:3000'),
        allowRemote: false,
        lookup: fakeLookup(['127.0.0.1', '::1']),
      }),
      { addresses: ['127.0.0.1', '::1'], remote: false },
    );
    assert.equal(
      (await assertStressAllowed({ targetUrl: new URL('http://10.1.2.3'), allowRemote: false }))
        .remote,
      false,
    );
  });

  it('refuses names that resolve to any public address, unless --allow-remote', async () => {
    await assert.rejects(
      assertStressAllowed({
        targetUrl: new URL('https://staging.example.com'),
        allowRemote: false,
        lookup: fakeLookup(['10.0.0.5', '93.184.215.14']),
      }),
      /Refusing to stress test staging\.example\.com: it resolves to a public address \(93\.184\.215\.14\)/,
    );
    const allowed = await assertStressAllowed({
      targetUrl: new URL('https://staging.example.com'),
      allowRemote: true,
      lookup: fakeLookup(['93.184.215.14']),
    });
    assert.equal(allowed.remote, true);
  });

  it('refuses public IP literals without a DNS lookup', async () => {
    await assert.rejects(
      assertStressAllowed({ targetUrl: new URL('http://8.8.8.8'), allowRemote: false }),
      /public address/,
    );
  });

  it('reports DNS failures as usage errors', async () => {
    await assert.rejects(
      assertStressAllowed({
        targetUrl: new URL('http://nope.invalid'),
        allowRemote: false,
        lookup: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
      /Could not resolve nope\.invalid/,
    );
  });
});

/**
 * Minimal request record factory for building traces.
 *
 * @param {{ id: string, url: string, startMs: number, endMs: number } & Record<string, any>} fields
 * @returns {import('../capture/network-recorder.js').RequestRecord}
 */
function record(fields) {
  return /** @type {import('../capture/network-recorder.js').RequestRecord} */ ({
    method: 'GET',
    resourceType: 'Fetch',
    isNavigation: false,
    initiator: {
      type: 'script',
      url: null,
      stackUrls: ['https://app.test/app.js'],
      requestId: null,
    },
    durationMs: fields.endMs - fields.startMs,
    responseStartMs: null,
    phases: null,
    status: 200,
    mimeType: 'application/json',
    protocol: 'h2',
    fromCache: false,
    fromServiceWorker: false,
    connectionReused: true,
    transferBytes: 100,
    bodyBytes: 100,
    headers: {},
    redirects: [],
    failure: null,
    pending: false,
    jsonShape: null,
    graphql: null,
    causedBy: null,
    frameId: null,
    isMainFrame: true,
    streaming: false,
    ...fields,
  });
}

describe('buildScenarios', () => {
  const trace = buildTrace(
    [
      record({
        id: 'doc',
        url: 'https://app.test/dash',
        resourceType: 'Document',
        isNavigation: true,
        startMs: 0,
        endMs: 20,
        initiator: { type: 'other', url: null, stackUrls: [], requestId: null },
      }),
      record({
        id: 'js',
        url: 'https://app.test/app.js',
        resourceType: 'Script',
        startMs: 15,
        endMs: 30,
        initiator: { type: 'parser', url: 'https://app.test/dash', stackUrls: [], requestId: null },
      }),
      record({ id: 'me', url: 'https://app.test/api/me', startMs: 40, endMs: 60 }),
      record({
        id: 'list',
        url: 'https://app.test/api/items/7',
        startMs: 65,
        endMs: 90,
        causedBy: 'me',
      }),
      record({
        id: 'side',
        url: 'https://app.test/api/flags',
        startMs: 41,
        endMs: 50,
        initiator: {
          type: 'script',
          url: null,
          stackUrls: ['https://other.test/x.js'],
          requestId: null,
        },
      }),
      record({
        id: 'post',
        url: 'https://app.test/api/track',
        method: 'POST',
        startMs: 42,
        endMs: 45,
      }),
      record({ id: 'third', url: 'https://cdn.test/api/x', startMs: 43, endMs: 46 }),
    ],
    'https://app.test/dash',
  );

  it('replays the document, then same-origin GET API calls in dependency levels', () => {
    const [scenario] = buildScenarios([{ slug: 'dash', url: 'https://app.test/dash', trace }], {
      targetOrigin: 'https://app.test',
      includeAssets: false,
    });
    assert.deepEqual(
      scenario.levels.map((level) => level.map((request) => request.label)),
      [['GET /dash'], ['GET /api/me', 'GET /api/flags'], ['GET /api/items/:id']],
    );
  });

  it('adds same-origin assets only when asked', () => {
    const [scenario] = buildScenarios([{ slug: 'dash', url: 'https://app.test/dash', trace }], {
      targetOrigin: 'https://app.test',
      includeAssets: true,
    });
    assert.ok(
      scenario.levels[1].some(
        (request) => request.kind === 'asset' && request.label === 'GET /app.js',
      ),
    );
  });

  it('skips routes without a usable trace', () => {
    assert.deepEqual(
      buildScenarios([{ slug: 'x', url: 'https://app.test/x', trace: null }], {
        targetOrigin: 'https://app.test',
        includeAssets: false,
      }),
      [],
    );
  });
});

describe('loadCookieJar', () => {
  it('matches cookies by domain, path, expiry, and secure flag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launchscope-jar-'));
    try {
      const path = join(dir, 'state.json');
      const future = Date.now() / 1000 + 3600;
      await writeFile(
        path,
        JSON.stringify({
          cookies: [
            {
              name: 'session',
              value: 'abc',
              domain: '.app.test',
              path: '/',
              expires: -1,
              secure: true,
            },
            {
              name: 'admin',
              value: 'x',
              domain: 'app.test',
              path: '/admin',
              expires: future,
              secure: false,
            },
            { name: 'old', value: 'y', domain: 'app.test', path: '/', expires: 1, secure: false },
            {
              name: 'other',
              value: 'z',
              domain: 'other.test',
              path: '/',
              expires: -1,
              secure: false,
            },
          ],
          origins: [],
        }),
      );
      const cookieFor = await loadCookieJar(path);
      assert.equal(cookieFor('https://api.app.test/v1'), 'session=abc');
      assert.equal(cookieFor('https://app.test/admin/users'), 'session=abc; admin=x');
      assert.equal(cookieFor('http://app.test/'), undefined, 'secure cookie not sent over http');
      assert.equal((await loadCookieJar(undefined))('https://app.test/'), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runStress', () => {
  /**
   * Simulates a server whose /api/slow handles 2 requests at a time (100 ms each), so latency
   * grows with concurrency, and which fails /api/flaky when `failFlaky` is set.
   */
  const simulatedServer = ({ failFlaky = false } = {}) => {
    let active = 0;
    /** @type {Array<() => void>} */
    const queue = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.method, 'GET');
      if (url.pathname === '/api/slow') {
        await new Promise((resolve) => {
          if (active < 2) {
            active += 1;
            resolve(undefined);
          } else {
            queue.push(() => {
              active += 1;
              resolve(undefined);
            });
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        active -= 1;
        queue.shift()?.();
      }
      if (url.pathname === '/api/flaky' && failFlaky) return new Response('nope', { status: 503 });
      return new Response('{"ok":true}', { status: 200 });
    };
    return fetchImpl;
  };

  /** @type {import('./scenario.js').Scenario[]} */
  const scenarios = [
    {
      slug: 'dash',
      url: 'https://app.test/dash',
      levels: [
        [{ url: 'https://app.test/dash', label: 'GET /dash', kind: 'document' }],
        [
          { url: 'https://app.test/api/slow', label: 'GET /api/slow', kind: 'api' },
          { url: 'https://app.test/api/fast', label: 'GET /api/fast', kind: 'api' },
        ],
      ],
    },
  ];
  /** @type {import('../settings.js').StressSettings} */
  const settings = {
    enabled: true,
    stages: [1, 8],
    stageDurationMs: 600,
    requestTimeoutMs: 2000,
    includeAssets: false,
    allowRemote: false,
    maxErrorRate: 0.5,
    mode: 'closed',
    rates: [1],
    maxInFlight: 1000,
    replay: [],
  };

  it('runs every stage and records per-stage and per-hop latency that grows with load', async () => {
    /** @type {Array<Record<string, string>>} */
    const seenHeaders = [];
    const base = simulatedServer();
    /** @type {typeof fetch} */
    const fetchImpl = async (input, init) => {
      seenHeaders.push(/** @type {Record<string, string>} */ (init?.headers));
      return base(input, init);
    };
    const result = await runStress({
      scenarios,
      settings,
      headers: { authorization: 'Bearer t' },
      cookieFor: () => 'session=abc',
      fetchImpl,
    });
    assert.equal(result.stoppedReason, null);
    assert.deepEqual(
      result.stages.map((stage) => stage.concurrency),
      [1, 8],
    );
    const [one, eight] = result.stages;
    assert.ok(one.iterations > 0 && eight.iterations > 0);
    assert.equal(one.errors, 0);
    const slowP95 = (/** @type {typeof one} */ stage) =>
      stage.hops.find((hop) => hop.label === 'GET /api/slow')?.latencyMs?.p95 ?? 0;
    assert.ok(
      slowP95(eight) > slowP95(one) * 2,
      `slow hop p95 ${slowP95(one)} → ${slowP95(eight)}`,
    );
    assert.equal(result.scenarios[0].requestsPerIteration, 3);
    assert.match(
      seenHeaders[0]['user-agent'],
      /^launchscope\/.+ \(stress test; \+https:\/\/github\.com\/himan-patel\/launchscope\)$/,
    );
    assert.equal(seenHeaders[0].authorization, 'Bearer t');
    assert.equal(seenHeaders[0].cookie, 'session=abc');
  });

  it('stops early when the error rate passes the limit', async () => {
    const result = await runStress({
      scenarios: [
        {
          slug: 'flaky',
          url: 'https://app.test/flaky',
          levels: [[{ url: 'https://app.test/api/flaky', label: 'GET /api/flaky', kind: 'api' }]],
        },
      ],
      settings: { ...settings, stages: [2, 4, 8] },
      headers: {},
      cookieFor: () => undefined,
      fetchImpl: simulatedServer({ failFlaky: true }),
    });
    assert.equal(result.stages.length, 1);
    assert.equal(result.stages[0].aborted, true);
    assert.match(result.stoppedReason ?? '', /Error rate reached 100\.0% at 2 concurrent users/);
    assert.deepEqual(result.stages[0].errorSamples, ['HTTP 503 from GET /api/flaky']);
  });

  it('stops when aborted by the user', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runStress({
      scenarios,
      settings,
      headers: {},
      cookieFor: () => undefined,
      signal: controller.signal,
      fetchImpl: simulatedServer(),
    });
    assert.equal(result.stages.length, 0);
    assert.equal(result.stoppedReason, 'Stopped by user.');
  });
});

describe('runStress in open (arrival-rate) mode', () => {
  /** Server that handles 2 requests at a time, 100 ms each: capacity ~20 requests per second. */
  const bottleneck = () => {
    let active = 0;
    /** @type {Array<() => void>} */
    const queue = [];
    /** @type {typeof fetch} */
    const fetchImpl = async () => {
      await new Promise((resolve) => {
        if (active < 2) {
          active += 1;
          resolve(undefined);
        } else {
          queue.push(() => {
            active += 1;
            resolve(undefined);
          });
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      active -= 1;
      queue.shift()?.();
      return new Response('ok');
    };
    return fetchImpl;
  };
  /** @type {import('./scenario.js').Scenario[]} */
  const scenarios = [
    {
      slug: 'x',
      url: 'https://app.test/x',
      levels: [[{ url: 'https://app.test/x', label: 'GET /x', kind: 'api' }]],
    },
  ];

  it('starts replays on schedule, tracks peak in-flight work, and drops beyond the cap', async () => {
    const result = await runStress({
      scenarios,
      settings: {
        enabled: true,
        stages: [1],
        stageDurationMs: 1000,
        requestTimeoutMs: 5000,
        includeAssets: false,
        allowRemote: false,
        maxErrorRate: 0.5,
        mode: 'open',
        rates: [5, 60],
        maxInFlight: 8,
        replay: [],
      },
      headers: {},
      cookieFor: () => undefined,
      fetchImpl: bottleneck(),
    });
    assert.equal(result.mode, 'open');
    assert.deepEqual(result.plannedStages, [5, 60]);
    const [slow, fast] = result.stages;
    assert.equal(slow.targetRate, 5);
    assert.ok(Math.abs(slow.achievedRate - 5) <= 1, `achieved ${slow.achievedRate}`);
    assert.equal(slow.dropped, 0);
    assert.ok(slow.concurrency <= 2, `peak in flight ${slow.concurrency}`);
    assert.equal(fast.concurrency, 8, 'work piles up to the in-flight cap');
    assert.ok(fast.dropped > 10, `dropped ${fast.dropped}`);

    const { insights, findings } = analyzeStress(result, resolveBudgets(undefined));
    assert.deepEqual(insights.saturation?.concurrency, 60);
    assert.match(
      findings.find((finding) => finding.rule === 'stress-saturation')?.title ?? '',
      /falls behind at 60 replays\/s/,
    );
  });
});

describe('analyzeStress', () => {
  const budgets = resolveBudgets(undefined);

  /**
   * @param {number} concurrency
   * @param {number} rps
   * @param {number[]} latencies
   * @param {{ errors?: number, hopLatencies?: Record<string, number[]> }} [extra]
   * @returns {import('./runner.js').StageResult}
   */
  const stage = (concurrency, rps, latencies, { errors = 0, hopLatencies = {} } = {}) => ({
    mode: /** @type {const} */ ('closed'),
    load: concurrency,
    targetRate: null,
    achievedRate: rps / 2,
    dropped: 0,
    concurrency,
    durationMs: 10_000,
    iterations: rps * 5,
    requests: rps * 10,
    errors,
    errorRate: errors / (rps * 10),
    requestsPerSecond: rps,
    iterationsPerSecond: rps / 2,
    bytesReceived: 0,
    latencyMs: summarize(latencies),
    iterationMs: summarize(latencies),
    statusCounts: {},
    errorSamples: errors ? ['HTTP 503 from GET /api/slow'] : [],
    hops: Object.entries(hopLatencies).map(([label, values]) => ({
      label,
      kind: 'api',
      requests: values.length,
      errors: 0,
      latencyMs: summarize(values),
    })),
    timeline: [],
    aborted: false,
  });

  /** @param {import('./runner.js').StageResult[]} stages @param {string | null} [stoppedReason] */
  const result = (stages, stoppedReason = null) => ({
    startedAt: '2026-10-19T00:00:00.000Z',
    mode: /** @type {const} */ ('closed'),
    plannedStages: stages.map((s) => s.concurrency),
    stages,
    stoppedReason,
    scenarios: [],
  });

  it('finds the knee, the hop that degrades most, saturation, and the peak', () => {
    const { insights, findings } = analyzeStress(
      result([
        stage(1, 20, [40, 45, 50], {
          hopLatencies: { 'GET /api/slow': [40, 50], 'GET /api/me': [5, 6] },
        }),
        stage(5, 90, [45, 50, 60], {
          hopLatencies: { 'GET /api/slow': [45, 60], 'GET /api/me': [5, 7] },
        }),
        stage(10, 95, [150, 180, 220], {
          hopLatencies: { 'GET /api/slow': [150, 230], 'GET /api/me': [6, 9] },
        }),
      ]),
      budgets,
    );
    assert.equal(insights.peakRequestsPerSecond, 95);
    assert.equal(insights.knee?.concurrency, 10);
    assert.equal(insights.knee?.hop?.label, 'GET /api/slow');
    assert.deepEqual(insights.saturation, { concurrency: 5, requestsPerSecond: 90 });
    assert.equal(insights.breakingPoint, null);
    const rules = findings.map((finding) => finding.rule);
    assert.deepEqual(rules.sort(), ['stress-knee', 'stress-saturation']);
    const knee = findings.find((finding) => finding.rule === 'stress-knee');
    assert.match(knee?.title ?? '', /GET \/api\/slow degrades most/);
  });

  it('reports errors as critical when the run was stopped by the error limit', () => {
    const { insights, findings } = analyzeStress(
      result(
        [stage(1, 10, [50]), stage(5, 10, [80], { errors: 60 })],
        'Error rate reached 60.0% …',
      ),
      budgets,
    );
    assert.deepEqual(insights.breakingPoint, { concurrency: 5, errorRate: 0.6 });
    const errors = findings.find((finding) => finding.rule === 'stress-errors');
    assert.equal(errors?.severity, 'critical');
  });

  it('flags high p95 at the last stage against the stress budget', () => {
    const { findings } = analyzeStress(
      result([stage(1, 5, [900, 1000]), stage(2, 6, [3200, 3500])]),
      budgets,
    );
    assert.equal(
      findings.find((finding) => finding.rule === 'stress-latency')?.severity,
      'critical',
    );
  });

  it('handles a run without stages', () => {
    assert.deepEqual(analyzeStress(result([]), budgets).findings, []);
  });
});
