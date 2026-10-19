import { performance } from 'node:perf_hooks';
import { BRAND } from '../../core/brand.js';
import { describeJsonShape } from './capture/network-recorder.js';

/**
 * Measures API operations directly over HTTP (no browser), for endpoints found in an OpenAPI
 * document. Each operation is called `runs` times, sequentially, with the target-origin headers
 * and session cookies the browser measurements use. Timing comes from Node's Resource Timing
 * entries for `fetch`; Node reports DNS, connect, and TLS as one interval, so they are recorded
 * together as `connectMs`.
 */

const KEPT_HEADERS = [
  'content-type',
  'content-encoding',
  'content-length',
  'cache-control',
  'server-timing',
  'age',
  'x-cache',
  'cf-cache-status',
];
const MAX_JSON_INSPECT_BYTES = 5 * 1024 * 1024;

/**
 * @param {object} options
 * @param {import('./discover/openapi.js').ApiOperation[]} options.operations
 * @param {number} options.runs
 * @param {number} options.timeoutMs
 * @param {Record<string, string>} options.headers
 * @param {(url: string) => string | undefined} options.cookieFor
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<Array<{ run: number, requests: import('./capture/network-recorder.js').RequestRecord[] }>>}
 *   One synthetic "load" per run, so the results flow into endpoint statistics.
 */
export async function measureApiOperations({
  operations,
  runs,
  timeoutMs,
  headers,
  cookieFor,
  signal,
  fetchImpl = fetch,
}) {
  const userAgent = `${BRAND.command}/${BRAND.version} (+${BRAND.repositoryUrl})`;
  /** @type {Array<{ run: number, requests: import('./capture/network-recorder.js').RequestRecord[] }>} */
  const loads = [];
  for (let run = 1; run <= runs && !signal?.aborted; run += 1) {
    /** @type {import('./capture/network-recorder.js').RequestRecord[]} */
    const requests = [];
    for (const operation of operations) {
      if (signal?.aborted) break;
      requests.push(
        await measureOnce(operation, run, { timeoutMs, headers, cookieFor, userAgent, fetchImpl }),
      );
    }
    loads.push({ run, requests });
  }
  return loads;
}

/**
 * @param {import('./discover/openapi.js').ApiOperation} operation
 * @param {number} run
 * @param {{ timeoutMs: number, headers: Record<string, string>, cookieFor: (url: string) => string | undefined, userAgent: string, fetchImpl: typeof fetch }} options
 * @returns {Promise<import('./capture/network-recorder.js').RequestRecord>}
 */
async function measureOnce(
  operation,
  run,
  { timeoutMs, headers, cookieFor, userAgent, fetchImpl },
) {
  /** @type {Record<string, string>} */
  const requestHeaders = { ...headers, accept: 'application/json', 'user-agent': userAgent };
  const cookie = cookieFor(operation.url);
  if (cookie) requestHeaders.cookie = cookie;

  const started = performance.now();
  /** @type {Response | null} */
  let response = null;
  /** @type {Buffer | null} */
  let body = null;
  /** @type {string | null} */
  let failure = null;
  try {
    response = await fetchImpl(operation.url, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const cause = /** @type {{ code?: string }} */ (
      error instanceof Error ? (error.cause ?? {}) : {}
    );
    failure =
      error instanceof Error && error.name === 'TimeoutError'
        ? `Timed out after ${timeoutMs} ms`
        : (cause.code ?? (error instanceof Error ? error.message : String(error)));
  }
  const ended = performance.now();
  await new Promise((resolve) => setImmediate(resolve));
  const timing = latestResourceTiming(operation.url, started);
  performance.clearResourceTimings();

  /** @type {Record<string, string>} */
  const kept = {};
  for (const name of KEPT_HEADERS) {
    const value = response?.headers.get(name);
    if (value) kept[name] = value.slice(0, 500);
  }

  let jsonShape = null;
  if (body && /json/i.test(kept['content-type'] ?? '') && body.length <= MAX_JSON_INSPECT_BYTES) {
    try {
      jsonShape = describeJsonShape(JSON.parse(body.toString('utf8')));
    } catch {
      // Not valid JSON despite the content type.
    }
  }

  const durationMs = round(timing ? timing.responseEnd - timing.startTime : ended - started);
  return {
    id: `openapi-${run}-${operation.url}`,
    url: response?.url || operation.url,
    method: 'GET',
    resourceType: 'Fetch',
    isNavigation: false,
    initiator: { type: 'openapi', url: null, stackUrls: [], requestId: null },
    startMs: 0,
    endMs: durationMs,
    durationMs,
    responseStartMs: timing ? round(timing.responseStart - timing.startTime) : null,
    phases: timing
      ? {
          queueMs: 0,
          dnsMs: 0,
          connectMs: round(Math.max(0, timing.requestStart - timing.startTime)),
          tlsMs: 0,
          sendMs: 0,
          waitMs: round(Math.max(0, timing.responseStart - timing.requestStart)),
          downloadMs: round(Math.max(0, timing.responseEnd - timing.responseStart)),
        }
      : null,
    status: response?.status ?? null,
    mimeType: kept['content-type']?.split(';')[0] ?? null,
    protocol: null,
    fromCache: false,
    fromServiceWorker: false,
    connectionReused: false,
    transferBytes: timing?.transferSize || body?.length || 0,
    bodyBytes: body?.length ?? 0,
    headers: kept,
    redirects: response?.redirected
      ? [{ url: operation.url, status: 0, startMs: 0, endMs: 0 }]
      : [],
    failure: failure ? { errorText: failure, canceled: false } : null,
    pending: false,
    jsonShape,
    graphql: null,
    frameId: null,
    isMainFrame: true,
    streaming: false,
  };
}

/**
 * @param {string} url
 * @param {number} notBefore
 * @returns {PerformanceResourceTiming | null}
 */
function latestResourceTiming(url, notBefore) {
  const entries = /** @type {PerformanceResourceTiming[]} */ (
    performance.getEntriesByType('resource')
  );
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.name === url && entry.startTime >= notBefore - 1) return entry;
  }
  return null;
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
