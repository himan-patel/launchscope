import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { percentile, summarize } from './stats.js';

describe('percentile', () => {
  it('interpolates between closest ranks', () => {
    const sorted = [10, 20, 30, 40];
    assert.equal(percentile(sorted, 0), 10);
    assert.equal(percentile(sorted, 50), 25);
    assert.equal(percentile(sorted, 100), 40);
    assert.equal(percentile(sorted, 95), 38.5);
  });

  it('handles single values and empty input', () => {
    assert.equal(percentile([7], 95), 7);
    assert.ok(Number.isNaN(percentile([], 50)));
  });
});

describe('summarize', () => {
  it('computes a distribution over unsorted samples', () => {
    const distribution = summarize([40, 10, 30, 20]);
    assert.deepEqual(distribution, {
      count: 4,
      min: 10,
      max: 40,
      mean: 25,
      p50: 25,
      p75: 32.5,
      p90: 37,
      p95: 38.5,
      p99: 39.7,
      stdev: 11.18,
    });
  });

  it('ignores missing and non-finite samples', () => {
    assert.equal(summarize([null, 5, undefined, Number.NaN, Infinity])?.count, 1);
  });

  it('returns null when nothing is measurable', () => {
    assert.equal(summarize([null, undefined]), null);
  });
});
