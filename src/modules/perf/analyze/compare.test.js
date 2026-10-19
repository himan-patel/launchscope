import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { UsageError } from '../../../core/errors.js';
import { summarize } from './stats.js';
import { compareRuns, loadBaseline, regressionFindings } from './compare.js';

/**
 * @param {string} url
 * @param {Record<string, number>} medians
 */
const route = (url, medians) => ({
  url,
  slug: new URL(url).pathname.replace(/\W+/g, '') || 'home',
  error: null,
  metrics: Object.fromEntries(
    Object.entries(medians).map(([key, value]) => [key, summarize([value])]),
  ),
});

/**
 * @param {string} path
 * @param {number[]} durations
 * @param {Partial<{ thirdParty: boolean, origin: string, graphqlOperation: string | null, body: number }>} [extra]
 */
const endpoint = (path, durations, extra = {}) => ({
  method: 'GET',
  pathTemplate: path,
  origin: extra.origin ?? 'https://app.test',
  thirdParty: extra.thirdParty ?? false,
  graphqlOperation: extra.graphqlOperation ?? null,
  durationMs: summarize(durations),
  bodyBytes: summarize([extra.body ?? 1000]),
});

const baselineSummary = {
  schemaVersion: 1,
  target: 'https://staging.app.test/',
  startedAt: '2026-10-18T10:00:00.000Z',
  routes: [
    route('https://staging.app.test/', {
      lcpMs: 1000,
      ttfbMs: 100,
      transferBytes: 500_000,
      requestCount: 40,
    }),
    route('https://staging.app.test/old', { lcpMs: 900 }),
  ],
  endpoints: [
    endpoint('/api/items/:id', [100, 110, 120]),
    endpoint('/api/fast', [20, 22]),
    endpoint('/api/gone', [50]),
  ],
};

describe('compareRuns', () => {
  const current = {
    routes: [
      route('http://localhost:3000/', {
        lcpMs: 1800,
        ttfbMs: 104,
        transferBytes: 300_000,
        requestCount: 42,
      }),
      route('http://localhost:3000/new', { lcpMs: 500 }),
    ],
    endpoints: [
      endpoint('/api/items/:id', [400, 450, 500]),
      endpoint('/api/fast', [30, 33]),
      endpoint('/api/new', [10]),
    ],
  };
  const comparison = compareRuns({
    current,
    baseline: baselineSummary,
    baselinePath: '/runs/a/summary.json',
  });

  it('matches routes by path across hosts and classifies each change', () => {
    const [home] = comparison.routes;
    assert.equal(home.route, '/');
    const verdicts = Object.fromEntries(
      home.changes.map((change) => [change.label, change.verdict]),
    );
    assert.deepEqual(verdicts, {
      TTFB: 'unchanged', // +4 ms is below the 50 ms floor
      LCP: 'regression', // +800 ms, +80%
      Transferred: 'improvement', // -200 KB
      Requests: 'unchanged', // +2 is below the 5-request floor
    });
  });

  it('ignores small absolute changes even when the percentage is large', () => {
    const fast = comparison.endpoints.find((entry) => entry.endpoint === 'GET /api/fast');
    assert.ok(
      fast?.changes.every((change) => change.verdict === 'unchanged'),
      '+10 ms is noise',
    );
  });

  it('lists new and missing routes and endpoints', () => {
    assert.deepEqual(comparison.newRoutes, ['/new']);
    assert.deepEqual(comparison.missingRoutes, ['/old']);
    assert.deepEqual(comparison.newEndpoints, ['GET /api/new']);
    assert.deepEqual(comparison.missingEndpoints, ['GET /api/gone']);
    assert.deepEqual(comparison.counts, { regressions: 3, improvements: 1 });
  });

  it('turns regressions into findings, critical when large', () => {
    const findings = regressionFindings(comparison);
    assert.deepEqual(
      findings.map((finding) => [finding.title.split(' regressed')[0], finding.severity]),
      [
        ['LCP on /', 'critical'],
        ['GET /api/items/:id p50', 'critical'],
        ['GET /api/items/:id p95', 'critical'],
      ],
    );
    assert.match(findings[0].title, /regressed \+80%: 1\.00 s → 1\.80 s/);
  });
});

describe('loadBaseline', () => {
  /** @type {string} */
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'launchscope-baseline-'));
    for (const [name, summary] of [
      ['app.test_2026-10-17_10-00-00Z', { ...baselineSummary, startedAt: 'oldest' }],
      ['app.test_2026-10-18_10-00-00Z', { ...baselineSummary, startedAt: 'newest' }],
      [
        'app.test_2026-10-18_11-00-00Z',
        { ...baselineSummary, startedAt: 'interrupted', interrupted: true },
      ],
      ['other.test_2026-10-19_10-00-00Z', { ...baselineSummary, startedAt: 'other host' }],
    ]) {
      await mkdir(join(dir, String(name), 'perf'), { recursive: true });
      await writeFile(join(dir, String(name), 'perf', 'summary.json'), JSON.stringify(summary));
    }
    await mkdir(join(dir, 'bad'), { recursive: true });
    await writeFile(join(dir, 'bad', 'summary.json'), JSON.stringify({ hello: 'world' }));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds the newest completed earlier run for the same host', async () => {
    const found = await loadBaseline({
      reference: 'latest',
      outputDirectory: dir,
      currentRunDirectory: join(dir, 'app.test_2026-10-19_09-00-00Z'),
    });
    assert.equal(found?.summary.startedAt, 'newest');
  });

  it('returns null when there is no earlier run', async () => {
    const found = await loadBaseline({
      reference: 'latest',
      outputDirectory: dir,
      currentRunDirectory: join(dir, 'new.test_2026-10-19_09-00-00Z'),
    });
    assert.equal(found, null);
  });

  it('accepts a summary file, a perf directory, or a run directory', async () => {
    for (const reference of [
      join(dir, 'app.test_2026-10-17_10-00-00Z', 'perf', 'summary.json'),
      join(dir, 'app.test_2026-10-17_10-00-00Z', 'perf'),
      join(dir, 'app.test_2026-10-17_10-00-00Z'),
    ]) {
      const found = await loadBaseline({
        reference,
        outputDirectory: dir,
        currentRunDirectory: dir,
      });
      assert.equal(found?.summary.startedAt, 'oldest', reference);
    }
  });

  it('rejects missing paths and files that are not perf summaries', async () => {
    await assert.rejects(
      loadBaseline({
        reference: join(dir, 'nope'),
        outputDirectory: dir,
        currentRunDirectory: dir,
      }),
      (error) => error instanceof UsageError && /No LaunchScope summary found/.test(error.message),
    );
    await assert.rejects(
      loadBaseline({ reference: join(dir, 'bad'), outputDirectory: dir, currentRunDirectory: dir }),
      /is not a LaunchScope perf summary/,
    );
  });
});
