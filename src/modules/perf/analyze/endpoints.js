import { parseServerTiming } from '../trace/server-timing.js';
import { summarize } from './stats.js';

/**
 * Groups every request made across all measured loads into endpoints, so `/api/items/41` and
 * `/api/items/42` are analyzed together as `GET /api/items/:id`.
 */

/** Resource types treated as endpoints (pages and API calls). Assets are summarized per route. */
export const ENDPOINT_TYPES = new Set(['Document', 'Fetch', 'XHR', 'EventSource']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const NUMERIC = /^\d+$/;
const TOKEN = /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9_-]{24,}$/;

/**
 * @typedef {import('../capture/network-recorder.js').RequestRecord} RequestRecord
 * @typedef {import('./stats.js').Distribution} Distribution
 */

/**
 * @typedef {object} ServerTimingSummary
 * @property {string} name
 * @property {number} samples
 * @property {number} meanMs
 * @property {number} maxMs
 */

/**
 * @typedef {object} EndpointSummary
 * @property {string} key `METHOD origin/path/template`
 * @property {string} method
 * @property {string} origin
 * @property {string} pathTemplate
 * @property {string} resourceType
 * @property {boolean} thirdParty
 * @property {string} sampleUrl One concrete URL (query string removed).
 * @property {string[]} routes Slugs of routes whose loads called this endpoint.
 * @property {number} calls Total calls across all cold loads.
 * @property {number} maxCallsPerLoad
 * @property {number} maxIdenticalCallsPerLoad Same full URL requested repeatedly in one load.
 * @property {Distribution | null} durationMs
 * @property {Distribution | null} waitMs Server wait (TTFB after sending).
 * @property {Distribution | null} downloadMs
 * @property {Distribution | null} transferBytes
 * @property {Distribution | null} bodyBytes
 * @property {Record<string, number>} statusCounts
 * @property {number} failures Network failures plus 4xx/5xx responses.
 * @property {number} redirects Calls that went through at least one redirect.
 * @property {boolean} compressed Any response carried a content-encoding.
 * @property {string | null} contentType
 * @property {string | null} cacheControl
 * @property {ServerTimingSummary[]} serverTiming
 * @property {number | null} largestJsonArray
 * @property {string | null} graphqlOperation GraphQL operation name; endpoints are split by it.
 * @property {import('../capture/graphql.js').OperationType | null} graphqlType
 * @property {boolean} streaming A server-sent event stream; excluded from timing statistics.
 * @property {Array<'page' | 'listed' | 'openapi' | 'repo'>} discoveredBy Called by measured pages, listed with --endpoint, found in the OpenAPI spec, and/or found in the repository.
 */

/**
 * @typedef {object} LoadInput
 * @property {string} routeSlug
 * @property {string} pageOrigin
 * @property {RequestRecord[]} requests
 * @property {'page' | 'listed' | 'openapi' | 'repo'} [source] How the requests were made (default: page loads).
 */

/**
 * Normalizes a URL path into a template by replacing identifiers with placeholders.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function templatePath(pathname) {
  return pathname
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      const decoded = safeDecode(segment);
      if (NUMERIC.test(decoded)) return ':id';
      if (UUID.test(decoded)) return ':uuid';
      if (LONG_HEX.test(decoded)) return ':hash';
      if (TOKEN.test(decoded)) return ':token';
      return segment;
    })
    .join('/');
}

/**
 * Aggregates endpoint statistics incrementally, one page load at a time, so a run with many
 * routes never has to keep every request of every load in memory at once.
 */
export class EndpointAccumulator {
  /** @type {Map<string, { meta: Omit<EndpointSummary, 'durationMs' | 'waitMs' | 'downloadMs' | 'transferBytes' | 'bodyBytes' | 'serverTiming' | 'routes' | 'discoveredBy'>, routes: Set<string>, sources: Set<'page' | 'listed' | 'openapi' | 'repo'>, durations: number[], waits: number[], downloads: number[], transfers: number[], bodies: number[], timings: Map<string, number[]> }>} */
  #groups = new Map();

  /**
   * @param {LoadInput} load A cold load (warm-cache hits would skew the numbers).
   */
  add(load) {
    const groups = this.#groups;
    /** @type {Map<string, number>} */
    const perLoad = new Map();
    /** @type {Map<string, { key: string, count: number }>} */
    const identical = new Map();

    for (const request of load.requests) {
      if (!ENDPOINT_TYPES.has(request.resourceType)) continue;
      const url = safeUrl(request.url);
      if (!url) continue;
      const pathTemplate = templatePath(url.pathname);
      const operation = request.graphql;
      const key = `${request.method} ${url.origin}${pathTemplate}${operation ? ` ${operation.name}` : ''}`;

      let group = groups.get(key);
      if (!group) {
        group = {
          meta: {
            key,
            method: request.method,
            origin: url.origin,
            pathTemplate,
            resourceType: request.resourceType,
            thirdParty: url.origin !== load.pageOrigin,
            sampleUrl: `${url.origin}${url.pathname}`,
            calls: 0,
            maxCallsPerLoad: 0,
            maxIdenticalCallsPerLoad: 0,
            statusCounts: {},
            failures: 0,
            redirects: 0,
            compressed: false,
            contentType: null,
            cacheControl: null,
            largestJsonArray: null,
            graphqlOperation: operation?.name ?? null,
            graphqlType: operation?.type ?? null,
            streaming: false,
          },
          routes: new Set(),
          sources: new Set(),
          durations: [],
          waits: [],
          downloads: [],
          transfers: [],
          bodies: [],
          timings: new Map(),
        };
        groups.set(key, group);
      }

      const { meta } = group;
      meta.calls += 1;
      const source = load.source ?? 'page';
      group.sources.add(source);
      if (source === 'page') group.routes.add(load.routeSlug);
      perLoad.set(key, (perLoad.get(key) ?? 0) + 1);
      // Same method + URL (+ same GraphQL body) is an identical call; differing variables are not.
      const identicalKey = `${request.method} ${request.url} ${operation?.bodyHash ?? ''}`;
      const seen = identical.get(identicalKey) ?? { key, count: 0 };
      seen.count += 1;
      identical.set(identicalKey, seen);

      if (request.status !== null) {
        meta.statusCounts[request.status] = (meta.statusCounts[request.status] ?? 0) + 1;
      }
      if (request.failure || (request.status !== null && request.status >= 400)) meta.failures += 1;
      if (request.redirects.length > 0) meta.redirects += 1;
      if (request.headers['content-encoding']) meta.compressed = true;
      if (request.streaming) meta.streaming = true;
      meta.contentType ??= request.headers['content-type'] ?? request.mimeType ?? null;
      meta.cacheControl ??= request.headers['cache-control'] ?? null;
      if (request.jsonShape) {
        meta.largestJsonArray = Math.max(
          meta.largestJsonArray ?? 0,
          request.jsonShape.largestArrayLength,
        );
      }

      if (!request.failure && !request.pending && !request.streaming) {
        group.durations.push(request.durationMs);
        group.transfers.push(request.transferBytes);
        group.bodies.push(request.bodyBytes);
        if (request.phases) {
          group.waits.push(request.phases.waitMs);
          group.downloads.push(request.phases.downloadMs);
        }
      }
      for (const metric of parseServerTiming(request.headers['server-timing'])) {
        if (metric.durationMs === null) continue;
        const samples = group.timings.get(metric.name) ?? [];
        samples.push(metric.durationMs);
        group.timings.set(metric.name, samples);
      }
    }

    for (const [key, count] of perLoad) {
      const group = /** @type {NonNullable<ReturnType<typeof groups.get>>} */ (groups.get(key));
      group.meta.maxCallsPerLoad = Math.max(group.meta.maxCallsPerLoad, count);
    }
    for (const { key, count } of identical.values()) {
      const group = /** @type {NonNullable<ReturnType<typeof groups.get>>} */ (groups.get(key));
      group.meta.maxIdenticalCallsPerLoad = Math.max(group.meta.maxIdenticalCallsPerLoad, count);
    }
  }

  /**
   * @returns {EndpointSummary[]} Sorted by p95 duration, slowest first.
   */
  result() {
    const groups = this.#groups;
    return [...groups.values()]
      .map((group) => ({
        ...group.meta,
        routes: [...group.routes],
        discoveredBy: [...group.sources].sort(),
        durationMs: summarize(group.durations),
        waitMs: summarize(group.waits),
        downloadMs: summarize(group.downloads),
        transferBytes: summarize(group.transfers),
        bodyBytes: summarize(group.bodies),
        serverTiming: [...group.timings].map(([name, samples]) => ({
          name,
          samples: samples.length,
          meanMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
          maxMs: Math.max(...samples),
        })),
      }))
      .sort((a, b) => (b.durationMs?.p95 ?? -1) - (a.durationMs?.p95 ?? -1));
  }
}

/**
 * @param {LoadInput[]} loads Cold loads only, so warm-cache hits do not skew the numbers.
 * @returns {EndpointSummary[]} Sorted by p95 duration, slowest first.
 */
export function aggregateEndpoints(loads) {
  const accumulator = new EndpointAccumulator();
  for (const load of loads) accumulator.add(load);
  return accumulator.result();
}

/**
 * @param {string} value
 * @returns {URL | null}
 */
function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** @param {string} segment */
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
