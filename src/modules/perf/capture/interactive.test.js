import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { measureInteractive, networkQuietPeriods } from './interactive.js';

/** @param {Partial<import('./interactive.js').InteractiveInput>} input */
const measure = (input) =>
  measureInteractive({
    fcpMs: 1000,
    domContentLoadedMs: 800,
    longTasks: [],
    requests: [],
    nowMs: 10_000,
    ...input,
  });

describe('measureInteractive', () => {
  it('is FCP (or DOMContentLoaded, if later) with zero TBT when nothing blocks', () => {
    assert.deepEqual(measure({}), { ttiMs: 1000, tbtMs: 0, complete: true });
    assert.deepEqual(measure({ domContentLoadedMs: 1500 }), {
      ttiMs: 1500,
      tbtMs: 0,
      complete: true,
    });
  });

  it('is unknown until 5 s of quiet after FCP have actually been observed', () => {
    assert.deepEqual(measure({ nowMs: 5999 }), { ttiMs: null, tbtMs: 0, complete: false });
    assert.equal(measure({ nowMs: 6001 })?.complete, true);
  });

  it('ends at the last long task before the quiet window and sums blocking time to it', () => {
    const result = measure({
      longTasks: [
        [1200, 100],
        [2000, 300],
      ],
    });
    assert.deepEqual(result, { ttiMs: 2300, tbtMs: 300, complete: true });
  });

  it('counts only the part of a task after FCP', () => {
    // [900, 1100] clipped to [1000, 1100]: 100 ms, so 50 ms blocking.
    assert.deepEqual(measure({ longTasks: [[900, 200]] }), {
      ttiMs: 1100,
      tbtMs: 50,
      complete: true,
    });
  });

  it('waits for the network to have at most two GET requests in flight', () => {
    const busy = [
      { startMs: 1000, endMs: 4000 },
      { startMs: 1000, endMs: 4000 },
      { startMs: 1000, endMs: 4000 },
    ];
    assert.equal(measure({ requests: busy, nowMs: 8900 })?.complete, false);
    assert.deepEqual(measure({ requests: busy, nowMs: 9100, fcpMs: 500 }), {
      ttiMs: 800,
      tbtMs: 0,
      complete: true,
    });
  });

  it('treats unfinished requests as in flight until the final pass, which leaves them out', () => {
    const requests = [
      { startMs: 1000, endMs: null },
      { startMs: 1000, endMs: null },
      { startMs: 1000, endMs: null },
    ];
    assert.equal(measure({ requests })?.complete, false);
    assert.equal(measure({ requests, final: true })?.complete, true);
  });

  it('reports blocking time so far as a lower bound when TTI is not reached', () => {
    assert.deepEqual(measure({ longTasks: [[3000, 250]], nowMs: 6000 }), {
      ttiMs: null,
      tbtMs: 200,
      complete: false,
    });
  });

  it('returns null without FCP', () => {
    assert.equal(measure({ fcpMs: null }), null);
  });
});

describe('networkQuietPeriods', () => {
  it('splits time at the third concurrent request', () => {
    assert.deepEqual(
      networkQuietPeriods(
        [
          { startMs: 0, endMs: 100 },
          { startMs: 10, endMs: 100 },
          { startMs: 20, endMs: 50 },
        ],
        200,
      ),
      [
        [0, 20],
        [50, 200],
      ],
    );
  });
});

describe('parity with Lighthouse', async () => {
  // Lighthouse is a dev dependency (an optional peer for users), so this runs in CI.
  const { Interactive } = await import('lighthouse/core/computed/metrics/interactive.js');
  const lantern = await import('lighthouse/core/lib/lantern/lantern.js');
  const { calculateSumOfBlockingTime } = lantern.Metrics.TBTUtils;

  let seed = 42;
  const random = (/** @type {number} */ max) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed % max;
  };

  it('matches Lighthouse TTI and TBT on 500 random loads', () => {
    for (let sample = 0; sample < 500; sample += 1) {
      const fcpMs = 200 + random(3000);
      const domContentLoadedMs = 100 + random(4000);
      const nowMs = fcpMs + 2000 + random(20_000);
      /** @type {Array<[number, number]>} */
      const longTasks = [];
      for (let at = random(2000); longTasks.length < random(8); at += 200 + random(4000)) {
        const duration = 51 + random(600);
        longTasks.push([at, duration]);
        at += duration;
      }
      const requests = Array.from({ length: random(12) }, () => {
        const startMs = random(nowMs);
        return { startMs, endMs: Math.min(nowMs, startMs + 1 + random(6000)) };
      });

      const ours = measureInteractive({
        fcpMs,
        domContentLoadedMs,
        longTasks,
        requests,
        nowMs,
        final: true,
      });

      const tasks = longTasks.map(([start, duration]) => ({
        start,
        end: start + duration,
        duration,
      }));
      const navigation = {
        timestamps: { timeOrigin: 0, traceEnd: nowMs * 1000, firstContentfulPaint: fcpMs * 1000 },
      };
      const records = requests.map((request) => ({
        finished: true,
        failed: false,
        requestMethod: 'GET',
        statusCode: 200,
        protocol: 'http/1.1',
        networkRequestTime: request.startMs,
        networkEndTime: request.endMs,
      }));
      /** @type {number | null} */
      let ttiMs = null;
      try {
        const { cpuQuietPeriod } = Interactive.findOverlappingQuietPeriods(
          tasks,
          /** @type {any} */ (records),
          /** @type {any} */ (navigation),
        );
        ttiMs = Math.max(cpuQuietPeriod.start, fcpMs, domContentLoadedMs);
      } catch {
        // No quiet window: Lighthouse reports an error, we report TTI as unknown.
      }
      const context = JSON.stringify({ fcpMs, domContentLoadedMs, nowMs, longTasks, requests });
      assert.equal(ours?.ttiMs ?? null, ttiMs, context);
      assert.equal(ours?.complete, ttiMs !== null, context);
      if (ttiMs !== null) {
        assert.equal(ours?.tbtMs, calculateSumOfBlockingTime(tasks, fcpMs, ttiMs), context);
      }
    }
  });
});
