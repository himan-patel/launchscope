import { BRAND } from '../../core/brand.js';
import { describeJsonShape } from './capture/network-recorder.js';
import { createConnectionAgent, timedRequest } from './http-request.js';

/**
 * Measures API operations directly over HTTP (no browser), for endpoints that are listed, found
 * in an OpenAPI document, or found in the repository. Each run calls every operation twice in a
 * row on its own connection: first on a new connection (DNS, TCP, and TLS included), then on the
 * same, reused connection (writes only make the first call, so they are sent once per run). The
 * two calls land in separate synthetic loads, so endpoint statistics
 * can compare them and duplicate-call rules do not see the pair as a duplicate. Requests carry the
 * target-origin headers and session cookies the browser measurements use.
 */

/** @typedef {import('./capture/network-recorder.js').RequestRecord} RequestRecord */
/** @typedef {{ run: number, connection: 'new' | 'reused', requests: RequestRecord[] }} ApiLoad */

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
 * @param {string} options.origin Target origin; redirects elsewhere are not followed.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<ApiLoad[]>} Two synthetic loads per run: new connections, then reused ones.
 */
export async function measureApiOperations({
  operations,
  runs,
  timeoutMs,
  headers,
  cookieFor,
  origin,
  signal,
}) {
  const userAgent = `${BRAND.command}/${BRAND.version} (+${BRAND.repositoryUrl})`;
  /** @type {ApiLoad[]} */
  const loads = [];
  for (let run = 1; run <= runs && !signal?.aborted; run += 1) {
    /** @type {ApiLoad} */
    const cold = { run, connection: 'new', requests: [] };
    /** @type {ApiLoad} */
    const warm = { run, connection: 'reused', requests: [] };
    for (const operation of operations) {
      if (signal?.aborted) break;
      const agent = createConnectionAgent(operation.url);
      try {
        const options = { timeoutMs, headers, cookieFor, userAgent, agent, origin, signal };
        cold.requests.push(await measureOnce(operation, run, 'new', options));
        // A listed write is sent once per run, as many times as the user asked for.
        if (signal?.aborted || operation.method) continue;
        warm.requests.push(await measureOnce(operation, run, 'reused', options));
      } finally {
        agent.destroy();
      }
    }
    loads.push(cold, warm);
  }
  return loads;
}

/**
 * @param {import('./discover/openapi.js').ApiOperation} operation
 * @param {number} run
 * @param {'new' | 'reused'} connection Which call of the pair this is (for the record id).
 * @param {{ timeoutMs: number, headers: Record<string, string>, cookieFor: (url: string) => string | undefined, userAgent: string, agent: import('node:http').Agent, origin: string, signal?: AbortSignal }} options
 * @returns {Promise<RequestRecord>}
 */
async function measureOnce(
  operation,
  run,
  connection,
  { timeoutMs, headers, cookieFor, userAgent, agent, origin, signal },
) {
  const method = operation.method ?? 'GET';
  /** @type {Record<string, string>} */
  const requestHeaders = { ...headers, accept: 'application/json', 'user-agent': userAgent };
  const cookie = cookieFor(operation.url);
  if (cookie) requestHeaders.cookie = cookie;
  if (operation.contentType) requestHeaders['content-type'] = operation.contentType;

  /** @type {import('./http-request.js').TimedResponse | null} */
  let response = null;
  /** @type {string | null} */
  let failure = null;
  try {
    response = await timedRequest({
      url: operation.url,
      method,
      headers: requestHeaders,
      body: operation.body ?? null,
      timeoutMs,
      agent,
      allowedOrigin: origin,
      signal,
    });
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error ?? {}).code;
    failure =
      error instanceof Error && error.name === 'TimeoutError'
        ? `Timed out after ${timeoutMs} ms`
        : (code ?? (error instanceof Error ? error.message : String(error)));
  }

  /** @type {Record<string, string>} */
  const kept = {};
  for (const name of KEPT_HEADERS) {
    const value = response?.headers[name];
    if (value) kept[name] = value.slice(0, 500);
  }

  let jsonShape = null;
  const body = response?.body ?? null;
  if (body && /json/i.test(kept['content-type'] ?? '') && body.length <= MAX_JSON_INSPECT_BYTES) {
    try {
      jsonShape = describeJsonShape(JSON.parse(body.toString('utf8')));
    } catch {
      // Not valid JSON despite the content type.
    }
  }

  const durationMs = response?.durationMs ?? 0;
  return {
    id: `api-${run}-${connection}-${method}-${operation.url}`,
    url: response?.url ?? operation.url,
    method,
    resourceType: 'Fetch',
    isNavigation: false,
    initiator: { type: 'openapi', url: null, stackUrls: [], requestId: null },
    startMs: 0,
    endMs: durationMs,
    durationMs,
    responseStartMs: response?.responseStartMs ?? null,
    phases: response ? { queueMs: 0, ...response.phases } : null,
    status: response?.status ?? null,
    mimeType: kept['content-type']?.split(';')[0] ?? null,
    protocol: response ? 'http/1.1' : null,
    fromCache: false,
    fromServiceWorker: false,
    connectionReused: response?.reused ?? false,
    transferBytes: response?.transferBytes ?? 0,
    bodyBytes: body?.length ?? 0,
    headers: kept,
    redirects: response?.redirects ?? [],
    failure: failure ? { errorText: failure, canceled: false } : null,
    pending: false,
    jsonShape,
    graphql: null,
    causedBy: null,
    frameId: null,
    isMainFrame: true,
    streaming: false,
  };
}
