import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveBudgets } from './analyze/budgets.js';
import { lighthouseFindings } from './lighthouse-phase.js';

/** @param {number | null} score @param {string | null} [error] */
const result = (score, error = null) => ({
  url: 'https://app.test/p',
  slug: 'p',
  score,
  metrics: { lcpMs: 3000, tbtMs: 400, cls: 0.05 },
  report: 'routes/p/lighthouse.html',
  error,
});

describe('lighthouseFindings', () => {
  it('treats lower scores as worse', () => {
    const budgets = resolveBudgets(undefined);
    assert.deepEqual(
      lighthouseFindings(
        [result(0.95), result(0.7), result(0.3), result(null, 'boom')],
        budgets,
      ).map((finding) => [finding.severity, finding.title]),
      [
        ['warning', 'Lighthouse performance score for /p is 70'],
        ['critical', 'Lighthouse performance score for /p is 30'],
      ],
    );
  });

  it('accepts custom minimum scores and rejects inverted ones', () => {
    assert.deepEqual(resolveBudgets({ lighthouseScore: 0.8 }).lighthouseScore, {
      warning: 0.8,
      critical: 0.5,
    });
    assert.deepEqual(resolveBudgets({ lighthouseScore: 0.4 }).lighthouseScore, {
      warning: 0.4,
      critical: 0.4,
    });
    assert.throws(
      () => resolveBudgets({ lighthouseScore: { warning: 0.5, critical: 0.9 } }),
      /lower scores are worse/,
    );
  });
});
