/**
 * Time to Interactive and Total Blocking Time, following the definitions Lighthouse implements
 * (https://web.dev/articles/tti, https://web.dev/articles/tbt; Lighthouse 13
 * `core/computed/metrics/interactive.js` and Lantern `TBTUtils`):
 *
 * - CPU quiet periods are the gaps between long tasks; network quiet periods are the times when
 *   at most two GET requests (finished, not failed, status below 400) were in flight.
 * - Both kinds of period only count if they last at least 5 s and end more than 5 s after FCP.
 *   The first CPU and network periods that overlap for 5 s form the quiet window.
 * - TTI is the latest of: the start of that CPU quiet period (the end of the last long task
 *   before the window), FCP, and DOMContentLoaded.
 * - TBT sums, over long tasks clipped to [FCP, TTI], the part of each beyond 50 ms.
 *
 * Inputs are observations on the page's clock: long tasks from the page's PerformanceObserver,
 * request intervals from the Chrome DevTools Protocol. While measuring, a request still in
 * flight counts as in flight until now, so a window is never declared early. At the end
 * (`final`), requests that never finished are left out, as Lighthouse does. If no quiet window
 * was observed, TTI is unknown, TBT is the blocking time up to now (a lower bound), and
 * `complete` is false.
 */

export const QUIET_WINDOW_MS = 5000;
export const MAX_QUIET_REQUESTS = 2;
const BLOCKING_THRESHOLD_MS = 50;

/**
 * @typedef {object} InteractiveInput
 * @property {number | null} fcpMs
 * @property {number | null} domContentLoadedMs
 * @property {Array<[number, number]>} longTasks `[startMs, durationMs]` pairs.
 * @property {Array<{ startMs: number, endMs: number | null }>} requests Countable GET requests;
 *   `endMs` is null while in flight.
 * @property {number} nowMs Latest observed time; quiet periods are only known up to here.
 * @property {boolean} [final] Leave out requests that never finished (Lighthouse's rule).
 */

/**
 * @typedef {object} InteractiveResult
 * @property {number | null} ttiMs
 * @property {number} tbtMs
 * @property {boolean} complete Whether a quiet window was observed (TTI is known).
 */

/**
 * @param {InteractiveInput} input
 * @returns {InteractiveResult | null} Null when there is no FCP to start from.
 */
export function measureInteractive({
  fcpMs,
  domContentLoadedMs,
  longTasks,
  requests,
  nowMs,
  final = false,
}) {
  if (fcpMs === null) return null;
  const tasks = longTasks
    .map(([startMs, durationMs]) => ({ startMs, endMs: startMs + durationMs }))
    .sort((a, b) => a.startMs - b.startMs);
  /** @param {[number, number]} period */
  const longEnough = ([start, end]) =>
    end > fcpMs + QUIET_WINDOW_MS && end - start >= QUIET_WINDOW_MS;
  const cpuQueue = cpuQuietPeriods(tasks, nowMs).filter(longEnough);
  const networkQueue = networkQuietPeriods(
    final ? requests.filter((request) => request.endMs !== null) : requests,
    nowMs,
  ).filter(longEnough);

  let cpu = cpuQueue.shift();
  let network = networkQueue.shift();
  while (cpu && network) {
    const found =
      cpu[0] >= network[0]
        ? network[1] >= cpu[0] + QUIET_WINDOW_MS
        : cpu[1] >= network[0] + QUIET_WINDOW_MS;
    if (found) {
      const ttiMs = Math.max(cpu[0], fcpMs, domContentLoadedMs ?? 0);
      return { ttiMs: round(ttiMs), tbtMs: blockingTime(tasks, fcpMs, ttiMs), complete: true };
    }
    if (cpu[0] >= network[0]) network = networkQueue.shift();
    else cpu = cpuQueue.shift();
  }
  return { ttiMs: null, tbtMs: blockingTime(tasks, fcpMs, nowMs), complete: false };
}

/**
 * @param {Array<{ startMs: number, endMs: number }>} tasks Sorted by start.
 * @param {number} nowMs
 * @returns {Array<[number, number]>}
 */
function cpuQuietPeriods(tasks, nowMs) {
  /** @type {Array<[number, number]>} */
  const periods = [];
  let start = 0;
  for (const task of tasks) {
    periods.push([start, task.startMs]);
    start = Math.max(start, task.endMs);
  }
  periods.push([start, nowMs]);
  return periods.filter(([from, to]) => to > from);
}

/**
 * Periods (up to `nowMs`) during which at most MAX_QUIET_REQUESTS requests were in flight.
 *
 * @param {Array<{ startMs: number, endMs: number | null }>} requests
 * @param {number} nowMs
 * @returns {Array<[number, number]>}
 */
export function networkQuietPeriods(requests, nowMs) {
  /** @type {Array<[number, number]>} */
  const boundaries = [];
  for (const { startMs, endMs } of requests) {
    if (startMs > nowMs) continue;
    boundaries.push([startMs, 1]);
    if (endMs !== null && endMs <= nowMs) boundaries.push([endMs, -1]);
  }
  boundaries.sort((a, b) => a[0] - b[0]);
  /** @type {Array<[number, number]>} */
  const periods = [];
  let inFlight = 0;
  let quietStart = 0;
  for (const [time, delta] of boundaries) {
    if (delta === 1) {
      if (inFlight === MAX_QUIET_REQUESTS) periods.push([quietStart, time]);
      inFlight += 1;
    } else {
      inFlight -= 1;
      if (inFlight === MAX_QUIET_REQUESTS) quietStart = time;
    }
  }
  if (inFlight <= MAX_QUIET_REQUESTS) periods.push([quietStart, nowMs]);
  return periods.filter(([from, to]) => to !== from);
}

/**
 * @param {Array<{ startMs: number, endMs: number }>} tasks
 * @param {number} fromMs
 * @param {number} toMs
 */
function blockingTime(tasks, fromMs, toMs) {
  let total = 0;
  for (const task of tasks) {
    const duration = Math.min(task.endMs, toMs) - Math.max(task.startMs, fromMs);
    if (duration > BLOCKING_THRESHOLD_MS) total += duration - BLOCKING_THRESHOLD_MS;
  }
  return round(total);
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 10) / 10;
}
