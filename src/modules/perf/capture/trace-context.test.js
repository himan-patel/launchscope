import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newSpanId, newTraceId, TraceRegistry, traceparentFor, traceUrl } from './trace-context.js';

describe('trace context', () => {
  it('creates W3C-shaped trace and span IDs', () => {
    assert.match(newTraceId(), /^[0-9a-f]{32}$/);
    assert.match(newSpanId(), /^[0-9a-f]{16}$/);
    assert.notEqual(newTraceId(), newTraceId());
  });

  it('formats a sampled traceparent with a fresh span per request', () => {
    const traceId = newTraceId();
    const first = traceparentFor(traceId);
    const second = traceparentFor(traceId);
    assert.match(first, new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    assert.notEqual(first, second, 'each request gets its own parent span ID');
  });

  it('keeps one trace per page', () => {
    const registry = new TraceRegistry();
    const pageA = {};
    const pageB = {};
    const a = registry.startTrace(pageA);
    const b = registry.startTrace(pageB);
    assert.notEqual(a, b);
    assert.equal(registry.traceIdFor(pageA), a);
    assert.equal(registry.traceIdFor({}), null);
    assert.equal(registry.traceIdFor(null), null);
  });

  it('fills trace URL templates', () => {
    assert.equal(
      traceUrl('https://t.test/trace/{traceId}?x={traceId}', 'abc'),
      'https://t.test/trace/abc?x=abc',
    );
    assert.equal(traceUrl(undefined, 'abc'), null);
  });
});
