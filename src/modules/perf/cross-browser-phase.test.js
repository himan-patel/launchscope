import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarize } from './analyze/stats.js';
import { crossBrowserFindings } from './cross-browser-phase.js';
import { resolvePerfSettings } from './settings.js';

describe('--browsers setting', () => {
  const resolveWith = (/** @type {Record<string, unknown>} */ cli) =>
    resolvePerfSettings({ target: 'http://localhost:3000', cli, config: undefined, cwd: '/' });

  it('always keeps Chromium first and de-duplicates', () => {
    assert.deepEqual(resolveWith({}).browsers, ['chromium']);
    assert.deepEqual(resolveWith({ browsers: 'webkit, FIREFOX, webkit' }).browsers, [
      'chromium',
      'firefox',
      'webkit',
    ]);
  });

  it('rejects unknown browsers', () => {
    assert.throws(() => resolveWith({ browsers: 'safari' }), /Unknown browser "safari"/);
  });
});

describe('crossBrowserFindings', () => {
  /** @param {Partial<{ error: string | null, loadMs: number, pageErrors: string[] }>} fields */
  const chromiumRoute = (fields = {}) =>
    /** @type {import('./analyze/routes.js').RouteSummary} */ (
      /** @type {unknown} */ ({
        url: 'https://app.test/p',
        slug: 'p',
        error: fields.error ?? null,
        metrics: { loadMs: summarize([fields.loadMs ?? 800]) },
        pageErrors: fields.pageErrors ?? [],
      })
    );
  /** @param {Partial<{ error: string | null, loadMs: number, pageErrors: string[], failedRequests: number }>} fields */
  const otherRoute = (fields = {}) => ({
    url: 'https://app.test/p',
    slug: 'p',
    status: 200,
    error: fields.error ?? null,
    metrics: /** @type {any} */ ({ loadMs: summarize([fields.loadMs ?? 850]) }),
    failedRequests: fields.failedRequests ?? 0,
    consoleErrors: [],
    pageErrors: fields.pageErrors ?? [],
  });

  it('flags failures, new errors, and much slower loads relative to Chromium', () => {
    const findings = crossBrowserFindings(
      [
        {
          browser: 'firefox',
          version: '1',
          routes: [otherRoute({ pageErrors: ['TypeError: x'], loadMs: 2000 })],
        },
        { browser: 'webkit', version: '1', routes: [otherRoute({ error: 'net::ERR' })] },
      ],
      [chromiumRoute({ pageErrors: [] })],
    );
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.title]),
      [
        ['browser-errors', '/p has errors in Firefox that Chromium does not'],
        ['browser-slower', '/p loads 2.5× slower in Firefox'],
        ['browser-failed', '/p fails to load in WebKit'],
      ],
    );
  });

  it('ignores errors Chromium also has and small differences', () => {
    const findings = crossBrowserFindings(
      [
        {
          browser: 'firefox',
          version: '1',
          routes: [otherRoute({ pageErrors: ['same'], loadMs: 1000 })],
        },
      ],
      [chromiumRoute({ pageErrors: ['same'], loadMs: 800 })],
    );
    assert.deepEqual(findings, []);
  });
});
