import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBytes, formatDuration, parseDuration } from './duration.js';
import { UsageError } from './errors.js';

describe('parseDuration', () => {
  it('parses milliseconds, seconds, and minutes', () => {
    assert.equal(parseDuration('250ms', '--x'), 250);
    assert.equal(parseDuration('10s', '--x'), 10_000);
    assert.equal(parseDuration('1.5m', '--x'), 90_000);
    assert.equal(parseDuration(' 2 S ', '--x'), 2000);
  });

  it('treats a bare number as milliseconds', () => {
    assert.equal(parseDuration('750', '--x'), 750);
    assert.equal(parseDuration(1200, '--x'), 1200);
  });

  it('rejects zero, negatives, and garbage with the option name', () => {
    assert.throws(() => parseDuration('0s', '--timeout'), /--timeout must be greater than zero/);
    assert.throws(() => parseDuration(-5, '--timeout'), UsageError);
    assert.throws(() => parseDuration('-5s', '--timeout'), /--timeout must be a duration/);
    assert.throws(() => parseDuration('soon', '--timeout'), /got "soon"/);
  });
});

describe('formatDuration', () => {
  it('picks a readable unit', () => {
    assert.equal(formatDuration(849.6), '850 ms');
    assert.equal(formatDuration(1240), '1.24 s');
    assert.equal(formatDuration(125_000), '2m 05s');
    assert.equal(formatDuration(Number.NaN), '–');
  });
});

describe('formatBytes', () => {
  it('uses binary units', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(14_540), '14.2 KB');
    assert.equal(formatBytes(3_250_586), '3.10 MB');
    assert.equal(formatBytes(Number.POSITIVE_INFINITY), '–');
  });
});
