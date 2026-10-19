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
 */

/**
 * @typedef {object} LoadInput
 * @property {string} routeSlug
 * @property {string} pageOrigin
 * @property {RequestRecord[]} requests
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
 * @param {LoadInput[]} loads Cold loads only, so warm-cache hits do not skew the numbers.
 * @returns {EndpointSummary[]} Sorted by p95 duration, slowest first.
 */
export function aggregateEndpoints(loads) {
  /** @type {Map<string, { meta: Omit<EndpointSummary, 'durationMs' | 'waitMs' | 'downloadMs' | 'transferBytes' | 'bodyBytes' | 'serverTiming' | 'routes'>, routes: Set<string>, durations: number[], waits: number[], downloads: number[], transfers: number[], bodies: number[], timings: Map<string, number[]> }>} */
  const groups = new Map();

  for (const load of loads) {
    /** @type {Map<string, number>} */
    const perLoad = new Map();
    /** @type {Map<string, number>} */
    const identical = new Map();

    for (const request of load.requests) {
      if (!ENDPOINT_TYPES.has(request.resourceType)) continue;
      const url = safeUrl(request.url);
      if (!url) continue;
      const pathTemplate = templatePath(url.pathname);
      const key = `${request.method} ${url.origin}${pathTemplate}`;

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
          },
          routes: new Set(),
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
      group.routes.add(load.routeSlug);
      perLoad.set(key, (perLoad.get(key) ?? 0) + 1);
      const identicalKey = `${request.method} ${request.url}`;
      identical.set(identicalKey, (identical.get(identicalKey) ?? 0) + 1);

      if (request.status !== null) {
        meta.statusCounts[request.status] = (meta.statusCounts[request.status] ?? 0) + 1;
      }
      if (request.failure || (request.status !== null && request.status >= 400)) meta.failures += 1;
      if (request.redirects.length > 0) meta.redirects += 1;
      if (request.headers['content-encoding']) meta.compressed = true;
      meta.contentType ??= request.headers['content-type'] ?? request.mimeType ?? null;
      meta.cacheControl ??= request.headers['cache-control'] ?? null;
      if (request.jsonShape) {
        meta.largestJsonArray = Math.max(
          meta.largestJsonArray ?? 0,
          request.jsonShape.largestArrayLength,
        );
      }

      if (!request.failure && !request.pending) {
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
    for (const [identicalKey, count] of identical) {
      const [method, ...rest] = identicalKey.split(' ');
      const url = safeUrl(rest.join(' '));
      if (!url) continue;
      const group = groups.get(`${method} ${url.origin}${templatePath(url.pathname)}`);
      if (group) {
        group.meta.maxIdenticalCallsPerLoad = Math.max(group.meta.maxIdenticalCallsPerLoad, count);
      }
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group.meta,
      routes: [...group.routes],
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
