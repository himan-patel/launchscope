import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveBudgets } from './analyze/budgets.js';
import { summarize } from './analyze/stats.js';
import { choosePairs, navigationFindings, summarizeNavigation } from './navigation-phase.js';

/** @param {string} url @param {string[]} links @param {boolean} [ok] */
const route = (url, links, ok = true) =>
  /** @type {import('./measure-routes.js').RouteRecord} */ ({
    url,
    slug: url,
    depth: 0,
    source: 'seed',
    trace: ok ? { rootId: 'x', nodes: [], chains: [], criticalPath: null } : null,
    representativeLoad: null,
    hasScreenshot: false,
    links,
  });

describe('choosePairs', () => {
  it('pairs pages with links to other measured, successfully loaded routes', () => {
    const routes = [
      route('https://a.test/', [
        'https://a.test/x#top',
        'https://a.test/y',
        'https://a.test/',
        'https://other.test/',
      ]),
      route('https://a.test/x', ['https://a.test/']),
      route('https://a.test/y', [], false),
    ];
    assert.deepEqual(choosePairs(routes, 10), [
      { from: 'https://a.test/', to: 'https://a.test/x' },
      { from: 'https://a.test/x', to: 'https://a.test/' },
    ]);
    assert.equal(choosePairs(routes, 1).length, 1);
  });
});

describe('summarizeNavigation and navigationFindings', () => {
  /** @param {number} durationMs @param {'soft' | 'full' | 'failed'} [kind] */
  const sample = (durationMs, kind = 'soft') => ({
    from: 'https://a.test/',
    to: 'https://a.test/b',
    kind,
    error: kind === 'failed' ? 'No link' : null,
    durationMs,
    networkMs: durationMs,
    renderMs: durationMs - 5,
    urlAfter: 'https://a.test/b',
    requests: [],
  });

  it('summarizes successful runs and keeps failed ones out of the numbers', () => {
    const summary = summarizeNavigation('https://a.test/', 'https://a.test/b', [
      /** @type {any} */ (sample(300)),
      /** @type {any} */ (sample(500)),
      /** @type {any} */ (sample(0, 'failed')),
    ]);
    assert.equal(summary.kind, 'soft');
    assert.equal(summary.runs, 3);
    assert.equal(summary.failedRuns, 1);
    assert.deepEqual(summary.durationMs, summarize([300, 500]));
  });

  it('flags slow, failed, and full-reload navigations', () => {
    const budgets = resolveBudgets({ navigationMs: { warning: 400, critical: 900 } });
    const soft = summarizeNavigation('https://a.test/', 'https://a.test/b', [
      /** @type {any} */ (sample(600)),
    ]);
    const full = summarizeNavigation('https://a.test/', 'https://a.test/c', [
      /** @type {any} */ (sample(100, 'full')),
    ]);
    const failed = summarizeNavigation('https://a.test/', 'https://a.test/d', [
      /** @type {any} */ (sample(0, 'failed')),
    ]);
    const findings = navigationFindings([soft, full, failed], budgets);
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.severity]),
      [
        ['slow-navigation', 'warning'],
        ['full-reload-navigation', 'info'],
        ['navigation-failed', 'warning'],
      ],
    );
  });

  it('does not report full reloads in apps without client-side routing', () => {
    const full = summarizeNavigation('https://a.test/', 'https://a.test/c', [
      /** @type {any} */ (sample(100, 'full')),
    ]);
    assert.deepEqual(navigationFindings([full], resolveBudgets(undefined)), []);
  });
});
