import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, DEFAULT_BUDGETS, resolveBudgets } from './budgets.js';

describe('resolveBudgets', () => {
  it('returns a copy of the defaults when nothing is configured', () => {
    const budgets = resolveBudgets(undefined);
    assert.deepEqual(budgets, DEFAULT_BUDGETS);
    assert.notEqual(budgets.lcpMs, DEFAULT_BUDGETS.lcpMs, 'thresholds are copies');
    assert.ok(!Object.isFrozen(budgets.lcpMs));
  });

  it('accepts full thresholds and bare numbers', () => {
    const budgets = resolveBudgets({ lcpMs: { warning: 2000, critical: 3000 }, apiP95Ms: 300 });
    assert.deepEqual(budgets.lcpMs, { warning: 2000, critical: 3000 });
    assert.deepEqual(budgets.apiP95Ms, { warning: 300, critical: 1500 });
  });

  it('raises the critical level when a bare number exceeds it', () => {
    assert.deepEqual(resolveBudgets({ chainLength: 8 }).chainLength, { warning: 8, critical: 8 });
  });

  it('rejects unknown budgets, bad values, and inverted thresholds', () => {
    assert.throws(() => resolveBudgets({ lpc: 1 }), /Unknown budget "lpc"/);
    assert.throws(() => resolveBudgets({ lcpMs: -1 }), /non-negative/);
    assert.throws(() => resolveBudgets({ lcpMs: { warn: 1 } }), /unknown field\(s\): warn/);
    assert.throws(() => resolveBudgets({ lcpMs: { warning: 5000, critical: 4000 } }), /above/);
    assert.throws(() => resolveBudgets([]), /must be an object/);
  });
});

describe('classify', () => {
  const threshold = { warning: 100, critical: 200 };
  it('classifies at and above each level', () => {
    assert.equal(classify(threshold, 99), null);
    assert.equal(classify(threshold, 100), 'warning');
    assert.equal(classify(threshold, 200), 'critical');
  });

  it('ignores missing values', () => {
    assert.equal(classify(threshold, null), null);
    assert.equal(classify(threshold, undefined), null);
    assert.equal(classify(threshold, Number.NaN), null);
  });
});
