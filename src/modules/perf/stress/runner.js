import { BRAND } from '../../../core/brand.js';
import { summarize } from '../analyze/stats.js';

/**
 * Closed-loop load generator: each virtual user repeatedly replays a route scenario (document,
 * then its API calls level by level) as fast as responses come back. Stages raise the number of
 * concurrent virtual users. Latency is measured client-side from request start to the last body
 * byte, so it includes the network and the server under load.
 */

const MIN_REQUESTS_BEFORE_ABORT = 20;
const MAX_SAMPLES_PER_STAGE = 200_000;
const MAX_ERROR_SAMPLES = 5;
const COOL_DOWN_MS = 500;

/**
 * @typedef {object} HopStats
 * @property {string} label
 * @property {'document' | 'api' | 'asset'} kind
 * @property {number} requests
 * @property {number} errors
 * @property {import('../analyze/stats.js').Distribution | null} latencyMs
 */

/**
 * @typedef {object} TimelinePoint
 * @property {number} second Seconds since the stage started.
 * @property {number} requests
 * @property {number} errors
 * @property {number | null} p95Ms
 */

/**
 * @typedef {object} StageResult
 * @property {number} concurrency
 * @property {number} durationMs Actual duration.
 * @property {number} iterations Completed route replays.
 * @property {number} requests
 * @property {number} errors
 * @property {number} errorRate
 * @property {number} requestsPerSecond
 * @property {number} iterationsPerSecond
 * @property {number} bytesReceived
 * @property {import('../analyze/stats.js').Distribution | null} latencyMs Per request.
 * @property {import('../analyze/stats.js').Distribution | null} iterationMs Per route replay.
 * @property {Record<string, number>} statusCounts
 * @property {string[]} errorSamples
 * @property {HopStats[]} hops
 * @property {TimelinePoint[]} timeline
 * @property {boolean} aborted
 */

/**
 * @typedef {object} StressResult
 * @property {string} startedAt
 * @property {number[]} plannedStages
 * @property {StageResult[]} stages
 * @property {string | null} stoppedReason Why the run ended before the last stage.
 * @property {Array<{ slug: string, url: string, requestsPerIteration: number }>} scenarios
 */

/**
 * @param {object} options
 * @param {import('./scenario.js').Scenario[]} options.scenarios
 * @param {import('../settings.js').StressSettings} options.settings
 * @param {Record<string, string>} options.headers Target-origin headers from settings.
 * @param {(url: string) => string | undefined} options.cookieFor
 * @param {(stage: StageResult) => void} [options.onStage]
 * @param {AbortSignal} [options.signal] Stops the run early (e.g. Ctrl+C).
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<StressResult>}
 */
export async function runStress({
  scenarios,
  settings,
  headers,
  cookieFor,
  onStage,
  signal,
  fetchImpl = fetch,
}) {
  /** @type {StageResult[]} */
  const stages = [];
  /** @type {string | null} */
  let stoppedReason = null;
  const startedAt = new Date().toISOString();
  const userAgent = `${BRAND.command}/${BRAND.version} (stress test; +${BRAND.repositoryUrl})`;

  for (const concurrency of settings.stages) {
    if (signal?.aborted) {
      stoppedReason = 'Stopped by user.';
      break;
    }
    const stage = await runStage({
      scenarios,
      concurrency,
      settings,
      baseHeaders: { ...headers, 'user-agent': userAgent },
      cookieFor,
      signal,
      fetchImpl,
    });
    stages.push(stage);
    onStage?.(stage);
    if (stage.aborted) {
      stoppedReason = signal?.aborted
        ? 'Stopped by user.'
        : `Error rate reached ${(stage.errorRate * 100).toFixed(1)}% at ${concurrency} concurrent users (limit ${(settings.maxErrorRate * 100).toFixed(0)}%).`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, COOL_DOWN_MS));
  }

  return {
    startedAt,
    plannedStages: [...settings.stages],
    stages,
    stoppedReason,
    scenarios: scenarios.map((scenario) => ({
      slug: scenario.slug,
      url: scenario.url,
      requestsPerIteration: scenario.levels.reduce((sum, level) => sum + level.length, 0),
    })),
  };
}

/**
 * @param {object} options
 * @param {import('./scenario.js').Scenario[]} options.scenarios
 * @param {number} options.concurrency
 * @param {import('../settings.js').StressSettings} options.settings
 * @param {Record<string, string>} options.baseHeaders
 * @param {(url: string) => string | undefined} options.cookieFor
 * @param {AbortSignal | undefined} options.signal
 * @param {typeof fetch} options.fetchImpl
 * @returns {Promise<StageResult>}
 */
async function runStage({
  scenarios,
  concurrency,
  settings,
  baseHeaders,
  cookieFor,
  signal,
  fetchImpl,
}) {
  const started = performance.now();
  const deadline = started + settings.stageDurationMs;
  /** @type {number[]} */
  const latencies = [];
  /** @type {number[]} */
  const iterationTimes = [];
  /** @type {Map<string, { kind: HopStats['kind'], requests: number, errors: number, latencies: number[] }>} */
  const hops = new Map();
  /** @type {Map<number, { requests: number, errors: number, latencies: number[] }>} */
  const timeline = new Map();
  /** @type {Record<string, number>} */
  const statusCounts = {};
  /** @type {string[]} */
  const errorSamples = [];
  let requests = 0;
  let errors = 0;
  let bytesReceived = 0;
  let iterations = 0;
  let aborted = false;
  let nextScenario = 0;

  /** @param {import('./scenario.js').ScenarioRequest} request */
  const timedRequest = async (request) => {
    const begin = performance.now();
    const requestHeaders = { ...baseHeaders };
    const cookie = cookieFor(request.url);
    if (cookie) requestHeaders.cookie = cookie;

    /** @type {string | null} */
    let error = null;
    try {
      const response = await fetchImpl(request.url, {
        method: 'GET',
        headers: requestHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(settings.requestTimeoutMs),
      });
      const body = await response.arrayBuffer();
      bytesReceived += body.byteLength;
      statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
      if (response.status >= 400) error = `HTTP ${response.status} from ${request.label}`;
    } catch (failure) {
      error = describeFailure(failure, request.label, settings.requestTimeoutMs);
      statusCounts.error = (statusCounts.error ?? 0) + 1;
    }

    const elapsed = performance.now() - begin;
    requests += 1;
    const second = Math.floor((performance.now() - started) / 1000);
    const point = timeline.get(second) ?? { requests: 0, errors: 0, latencies: [] };
    point.requests += 1;
    const hop = hops.get(request.label) ?? {
      kind: request.kind,
      requests: 0,
      errors: 0,
      latencies: [],
    };
    hop.requests += 1;

    if (error) {
      errors += 1;
      point.errors += 1;
      hop.errors += 1;
      if (errorSamples.length < MAX_ERROR_SAMPLES && !errorSamples.includes(error)) {
        errorSamples.push(error);
      }
    } else if (latencies.length < MAX_SAMPLES_PER_STAGE) {
      latencies.push(elapsed);
      point.latencies.push(elapsed);
      hop.latencies.push(elapsed);
    }
    timeline.set(second, point);
    hops.set(request.label, hop);

    if (requests >= MIN_REQUESTS_BEFORE_ABORT && errors / requests > settings.maxErrorRate) {
      aborted = true;
    }
  };

  const virtualUser = async () => {
    while (!aborted && !signal?.aborted && performance.now() < deadline) {
      const scenario = scenarios[nextScenario % scenarios.length];
      nextScenario += 1;
      const begin = performance.now();
      for (const level of scenario.levels) {
        await Promise.all(level.map((request) => timedRequest(request)));
        if (aborted || signal?.aborted) return;
      }
      iterations += 1;
      if (iterationTimes.length < MAX_SAMPLES_PER_STAGE) {
        iterationTimes.push(performance.now() - begin);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => virtualUser()));
  if (signal?.aborted) aborted = true;

  const durationMs = performance.now() - started;
  const seconds = durationMs / 1000;
  return {
    concurrency,
    durationMs: Math.round(durationMs),
    iterations,
    requests,
    errors,
    errorRate: requests > 0 ? round(errors / requests, 4) : 0,
    requestsPerSecond: round(requests / seconds, 2),
    iterationsPerSecond: round(iterations / seconds, 2),
    bytesReceived,
    latencyMs: summarize(latencies),
    iterationMs: summarize(iterationTimes),
    statusCounts,
    errorSamples,
    hops: [...hops].map(([label, hop]) => ({
      label,
      kind: hop.kind,
      requests: hop.requests,
      errors: hop.errors,
      latencyMs: summarize(hop.latencies),
    })),
    timeline: [...timeline]
      .sort(([a], [b]) => a - b)
      .map(([second, point]) => ({
        second,
        requests: point.requests,
        errors: point.errors,
        p95Ms: summarize(point.latencies)?.p95 ?? null,
      })),
    aborted,
  };
}

/**
 * @param {unknown} failure
 * @param {string} label
 * @param {number} timeoutMs
 * @returns {string}
 */
function describeFailure(failure, label, timeoutMs) {
  if (failure instanceof Error) {
    if (failure.name === 'TimeoutError') return `Timed out after ${timeoutMs} ms: ${label}`;
    const code = /** @type {{ code?: string }} */ (failure.cause ?? {}).code;
    return `${code ?? failure.message}: ${label}`;
  }
  return `${String(failure)}: ${label}`;
}

/**
 * @param {number} value
 * @param {number} digits
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
