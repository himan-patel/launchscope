import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseServerTiming } from './server-timing.js';

describe('parseServerTiming', () => {
  it('parses names, durations, and descriptions', () => {
    assert.deepEqual(parseServerTiming('db;dur=230;desc="query", app;dur=15'), [
      { name: 'db', durationMs: 230, description: 'query' },
      { name: 'app', durationMs: 15, description: null },
    ]);
  });

  it('keeps metrics without a duration', () => {
    assert.deepEqual(parseServerTiming('cache;desc=miss'), [
      { name: 'cache', durationMs: null, description: 'miss' },
    ]);
  });

  it('does not split on separators inside quotes', () => {
    assert.deepEqual(parseServerTiming('edge;desc="a, b; c";dur=1.5'), [
      { name: 'edge', durationMs: 1.5, description: 'a, b; c' },
    ]);
  });

  it('ignores invalid names and invalid durations', () => {
    assert.deepEqual(parseServerTiming('bad name;dur=1, ok;dur=-3, x;dur=abc'), [
      { name: 'ok', durationMs: null, description: null },
      { name: 'x', durationMs: null, description: null },
    ]);
  });

  it('uses the first dur and desc when repeated', () => {
    assert.deepEqual(parseServerTiming('db;dur=1;dur=2;desc=a;desc=b'), [
      { name: 'db', durationMs: 1, description: 'a' },
    ]);
  });

  it('returns an empty list for missing headers', () => {
    assert.deepEqual(parseServerTiming(undefined), []);
    assert.deepEqual(parseServerTiming(''), []);
  });
});
