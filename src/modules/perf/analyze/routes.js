import { summarize } from './stats.js';

/**
 * @typedef {import('./stats.js').Distribution} Distribution
 * @typedef {import('../capture/page-capture.js').PageLoad} PageLoad
 * @typedef {import('../trace/hop-tree.js').Trace} Trace
 */

/**
 * @typedef {object} ResourceTypeSummary
 * @property {string} type
 * @property {number} requests
 * @property {number} transferBytes
 * @property {number} bodyBytes
 */

/**
 * @typedef {object} RouteMetrics
 * @property {Distribution | null} ttfbMs
 * @property {Distribution | null} fcpMs
 * @property {Distribution | null} lcpMs
 * @property {Distribution | null} cls
 * @property {Distribution | null} tbtMs
 * @property {Distribution | null} domContentLoadedMs
 * @property {Distribution | null} loadMs
 * @property {Distribution | null} wallTimeMs
 * @property {Distribution | null} requestCount
 * @property {Distribution | null} transferBytes
 * @property {Distribution | null} bodyBytes
 * @property {Distribution | null} thirdPartyBytes
 * @property {Distribution | null} apiCalls
 */

/**
 * @typedef {object} RouteSummary
 * @property {string} url
 * @property {string} slug
 * @property {number} depth
 * @property {string} source
 * @property {string | null} title
 * @property {number | null} status Main document status of the representative load.
 * @property {string | null} finalUrl
 * @property {{ cold: number, warm: number, failed: number }} runs
 * @property {string | null} error Set when every cold run failed.
 * @property {RouteMetrics} metrics Cold-cache distributions.
 * @property {RouteMetrics | null} warmMetrics
 * @property {ResourceTypeSummary[]} resourceTypes From the representative load.
 * @property {{ requests: number, transferBytes: number, origins: string[] }} thirdParty
 * @property {string[]} consoleErrors Unique messages across runs.
 * @property {string[]} pageErrors Unique uncaught exceptions across runs.
 * @property {number | null} representativeRun
 * @property {RealtimeSummary} realtime WebSockets, event streams, and iframes (representative load).
 * @property {Array<{ run: number, cache: 'cold' | 'warm', traceId: string }>} traces Trace IDs per load (with --trace-context).
 */

const API_TYPES = new Set(['Fetch', 'XHR']);

/**
 * @param {object} input
 * @param {string} input.url
 * @param {string} input.slug
 * @param {number} input.depth
 * @param {string} input.source
 * @param {PageLoad[]} input.loads
 * @param {number | null} input.representativeRun
 * @returns {RouteSummary}
 */
export function summarizeRoute({ url, slug, depth, source, loads, representativeRun }) {
  const cold = loads.filter((load) => load.cache === 'cold');
  const warm = loads.filter((load) => load.cache === 'warm');
  const coldOk = cold.filter((load) => load.error === null);
  const representative = coldOk.find((load) => load.run === representativeRun) ?? coldOk[0] ?? null;
  const pageOrigin = new URL(representative?.finalUrl ?? url).origin;

  /** @type {Map<string, ResourceTypeSummary>} */
  const types = new Map();
  const thirdPartyOrigins = new Set();
  let thirdPartyRequests = 0;
  let thirdPartyTransfer = 0;
  for (const request of representative?.requests ?? []) {
    const entry = types.get(request.resourceType) ?? {
      type: request.resourceType,
      requests: 0,
      transferBytes: 0,
      bodyBytes: 0,
    };
    entry.requests += 1;
    entry.transferBytes += request.transferBytes;
    entry.bodyBytes += request.bodyBytes;
    types.set(request.resourceType, entry);
    const origin = safeOrigin(request.url);
    if (origin && origin !== pageOrigin) {
      thirdPartyOrigins.add(origin);
      thirdPartyRequests += 1;
      thirdPartyTransfer += request.transferBytes;
    }
  }

  return {
    url,
    slug,
    depth,
    source,
    title: representative?.title ?? null,
    status: representative?.status ?? cold.find((load) => load.status !== null)?.status ?? null,
    finalUrl: representative?.finalUrl ?? null,
    runs: { cold: cold.length, warm: warm.length, failed: cold.length - coldOk.length },
    error: coldOk.length === 0 ? (cold[0]?.error ?? 'No successful runs') : null,
    metrics: computeMetrics(coldOk, pageOrigin),
    warmMetrics: warm.length > 0 ? computeMetrics(warm, pageOrigin) : null,
    resourceTypes: [...types.values()].sort((a, b) => b.transferBytes - a.transferBytes),
    thirdParty: {
      requests: thirdPartyRequests,
      transferBytes: thirdPartyTransfer,
      origins: [...thirdPartyOrigins].sort(),
    },
    consoleErrors: unique(loads.flatMap((load) => load.consoleErrors)),
    pageErrors: unique(loads.flatMap((load) => load.pageErrors)),
    representativeRun: representative?.run ?? null,
    realtime: summarizeRealtime(representative),
    traces: loads.flatMap((load) =>
      load.traceId ? [{ run: load.run, cache: load.cache, traceId: load.traceId }] : [],
    ),
  };
}

/**
 * @param {PageLoad[]} loads
 * @param {string} pageOrigin
 * @returns {RouteMetrics}
 */
function computeMetrics(loads, pageOrigin) {
  const pick = (/** @type {(load: PageLoad) => number | null | undefined} */ fn) =>
    summarize(loads.map(fn));
  const sum = (
    /** @type {PageLoad} */ load,
    /** @type {(request: PageLoad['requests'][number]) => number} */ fn,
  ) => load.requests.reduce((total, request) => total + fn(request), 0);

  return {
    ttfbMs: pick((load) => load.vitals?.ttfbMs),
    fcpMs: pick((load) => load.vitals?.fcpMs),
    lcpMs: pick((load) => load.vitals?.lcpMs),
    cls: pick((load) => load.vitals?.cls),
    tbtMs: pick((load) => load.vitals?.tbtMs),
    domContentLoadedMs: pick((load) => load.vitals?.domContentLoadedMs),
    loadMs: pick((load) => load.vitals?.loadMs),
    wallTimeMs: pick((load) => load.wallTimeMs),
    requestCount: pick((load) => load.requests.length),
    transferBytes: pick((load) => sum(load, (request) => request.transferBytes)),
    bodyBytes: pick((load) => sum(load, (request) => request.bodyBytes)),
    thirdPartyBytes: pick((load) =>
      sum(load, (request) => (safeOrigin(request.url) !== pageOrigin ? request.transferBytes : 0)),
    ),
    apiCalls: pick((load) => sum(load, (request) => (API_TYPES.has(request.resourceType) ? 1 : 0))),
  };
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values)].slice(0, 20);
}

/**
 * @param {string} url
 * @returns {string | null}
 */
function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} RealtimeSummary
 * @property {import('../capture/network-recorder.js').SocketRecord[]} websockets
 * @property {Array<{ url: string, bytes: number }>} eventStreams
 * @property {{ count: number, requests: number, transferBytes: number, origins: string[] }} iframes
 */

/**
 * @param {PageLoad | null} load
 * @returns {RealtimeSummary}
 */
function summarizeRealtime(load) {
  const requests = load?.requests ?? [];
  const framed = requests.filter((request) => !request.isMainFrame);
  const frameDocuments = framed.filter((request) => request.resourceType === 'Document');
  return {
    websockets: load?.sockets ?? [],
    eventStreams: requests
      .filter((request) => request.streaming)
      .map((request) => ({ url: request.url, bytes: request.bodyBytes })),
    iframes: {
      count: frameDocuments.length,
      requests: framed.length,
      transferBytes: framed.reduce((sum, request) => sum + request.transferBytes, 0),
      origins: [
        ...new Set(
          frameDocuments.map((request) => safeOrigin(request.url)).filter((o) => o !== null),
        ),
      ].sort(),
    },
  };
}
