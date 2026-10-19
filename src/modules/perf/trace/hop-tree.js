import { parseServerTiming } from './server-timing.js';

/**
 * Builds the hop tree of one page load: which request caused which, which API calls waited on
 * other API calls, and which chain of requests determined when the page finished loading.
 *
 * Two kinds of edges are derived from real measurements:
 * - **parent** ("triggered by"): from the CDP initiator. A parser-initiated request belongs to the
 *   document or stylesheet that referenced it; a script-initiated request belongs to the
 *   innermost script on its call stack that the page actually downloaded.
 * - **dependsOn** ("waited for"): an API call (fetch/XHR) that started within
 *   `CHAIN_GAP_MS` after another API call from the same script finished. This is how
 *   `await fetch(a); await fetch(b)` waterfalls show up; it is an inference from timing and
 *   call stacks, so it is labeled as such in reports.
 */

/** Maximum gap between one API call finishing and the next starting to count as a chain. */
export const CHAIN_GAP_MS = 100;

const API_TYPES = new Set(['Fetch', 'XHR']);
const NON_BLOCKING_TYPES = new Set(['Ping', 'EventSource', 'WebSocket', 'CSPViolationReport']);
const MAX_CHAINS = 5;

/**
 * @typedef {import('../capture/network-recorder.js').RequestRecord} RequestRecord
 * @typedef {import('./server-timing.js').ServerTimingMetric} ServerTimingMetric
 */

/**
 * @typedef {object} TraceNode
 * @property {string} id
 * @property {string | null} parentId Request that triggered this one.
 * @property {string | null} dependsOnId API call this one waited for (inferred).
 * @property {string[]} childIds
 * @property {number} depth Depth in the parent tree (document = 0).
 * @property {string} url
 * @property {string} method
 * @property {string} resourceType
 * @property {number | null} status
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} durationMs
 * @property {number} transferBytes
 * @property {number} bodyBytes
 * @property {boolean} thirdParty Not on the page's origin.
 * @property {boolean} failed
 * @property {number} redirectCount
 * @property {string | null} cacheControl Response Cache-Control header, if any.
 * @property {string | null} redirectedFrom First URL requested, when the request was redirected.
 * @property {string | null} graphqlOperation GraphQL operation name, for GraphQL calls.
 * @property {boolean} streaming Long-lived stream (server-sent events).
 * @property {boolean} isMainFrame False for requests made by iframes.
 * @property {ServerTimingMetric[]} serverTiming
 */

/**
 * @typedef {object} RequestChain
 * @property {string[]} ids First to last.
 * @property {number} totalMs From the first request's start to the last request's end.
 * @property {number} networkMs Sum of the chained requests' own durations.
 * @property {number} idleMs Time between links (client-side processing before the next call).
 */

/**
 * @typedef {object} CriticalPathSegment
 * @property {string} id
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} gapMs Time between the previous segment ending and this one starting.
 * @property {'parent' | 'dependsOn' | 'root'} via
 */

/**
 * @typedef {object} CriticalPath
 * @property {CriticalPathSegment[]} segments Document first.
 * @property {number} totalMs End of the last segment.
 */

/**
 * @typedef {object} Trace
 * @property {string | null} rootId The main document request.
 * @property {TraceNode[]} nodes Sorted by start time.
 * @property {RequestChain[]} chains Longest sequential API chains (length ≥ 2), longest first.
 * @property {CriticalPath | null} criticalPath
 */

/**
 * @param {RequestRecord[]} requests
 * @param {string} pageUrl URL the page was loaded from (used to decide third-party requests).
 * @returns {Trace}
 */
export function buildTrace(requests, pageUrl) {
  const pageOrigin = new URL(pageUrl).origin;
  const sorted = [...requests].sort((a, b) => a.startMs - b.startMs);
  const root = sorted.find((request) => request.isNavigation) ?? sorted[0] ?? null;

  /** @type {Map<string, RequestRecord[]>} */
  const byUrl = new Map();
  for (const request of sorted) {
    const list = byUrl.get(request.url) ?? [];
    list.push(request);
    byUrl.set(request.url, list);
    for (const hop of request.redirects) {
      const hopList = byUrl.get(hop.url) ?? [];
      hopList.push(request);
      byUrl.set(hop.url, hopList);
    }
  }

  /** @type {Map<string, TraceNode>} */
  const nodes = new Map();
  for (const request of sorted) {
    nodes.set(request.id, {
      id: request.id,
      parentId: null,
      dependsOnId: null,
      childIds: [],
      depth: 0,
      url: request.url,
      method: request.method,
      resourceType: request.resourceType,
      status: request.status,
      startMs: request.startMs,
      endMs: request.endMs,
      durationMs: request.durationMs,
      transferBytes: request.transferBytes,
      bodyBytes: request.bodyBytes,
      thirdParty: safeOrigin(request.url) !== pageOrigin,
      failed: request.failure !== null || (request.status !== null && request.status >= 400),
      redirectCount: request.redirects.length,
      cacheControl: request.headers['cache-control'] ?? null,
      redirectedFrom: request.redirects[0]?.url ?? null,
      graphqlOperation: request.graphql?.name ?? null,
      streaming: request.streaming,
      isMainFrame: request.isMainFrame,
      serverTiming: parseServerTiming(request.headers['server-timing']),
    });
  }

  for (const request of sorted) {
    if (request === root) continue;
    const node = /** @type {TraceNode} */ (nodes.get(request.id));
    node.parentId = findParent(request, byUrl, root)?.id ?? root?.id ?? null;
    node.dependsOnId = findDependency(request, sorted)?.id ?? null;
  }

  for (const node of nodes.values()) {
    if (node.parentId) nodes.get(node.parentId)?.childIds.push(node.id);
  }
  assignDepths(root ? nodes.get(root.id) : undefined, nodes);

  const nodeList = [...nodes.values()];
  return {
    rootId: root?.id ?? null,
    nodes: nodeList,
    chains: findChains(nodeList, nodes),
    criticalPath: findCriticalPath(nodeList, nodes),
  };
}

/**
 * @param {RequestRecord} request
 * @param {Map<string, RequestRecord[]>} byUrl
 * @param {RequestRecord | null} root
 * @returns {RequestRecord | null}
 */
function findParent(request, byUrl, root) {
  if (request.initiator.requestId) {
    for (const candidates of byUrl.values()) {
      const match = candidates.find((candidate) => candidate.id === request.initiator.requestId);
      if (match && match !== request) return match;
    }
  }
  const urls =
    request.initiator.type === 'script'
      ? request.initiator.stackUrls
      : request.initiator.url
        ? [request.initiator.url]
        : [];
  for (const url of urls) {
    const candidates = byUrl.get(url) ?? [];
    const match = latestStartedBefore(candidates, request);
    if (match) return match;
  }
  return root;
}

/**
 * @param {RequestRecord[]} candidates
 * @param {RequestRecord} request
 * @returns {RequestRecord | null}
 */
function latestStartedBefore(candidates, request) {
  let best = null;
  for (const candidate of candidates) {
    if (candidate === request || candidate.startMs > request.startMs) continue;
    if (!best || candidate.startMs >= best.startMs) best = candidate;
  }
  return best;
}

/**
 * @param {RequestRecord} request
 * @param {RequestRecord[]} sorted
 * @returns {RequestRecord | null}
 */
function findDependency(request, sorted) {
  if (!API_TYPES.has(request.resourceType)) return null;
  const scripts = new Set(request.initiator.stackUrls);
  if (scripts.size === 0) return null;

  let best = null;
  for (const candidate of sorted) {
    if (candidate === request || !API_TYPES.has(candidate.resourceType)) continue;
    if (candidate.failure || candidate.pending) continue;
    const gap = request.startMs - candidate.endMs;
    if (gap < 0 || gap > CHAIN_GAP_MS) continue;
    if (!candidate.initiator.stackUrls.some((url) => scripts.has(url))) continue;
    if (!best || candidate.endMs > best.endMs) best = candidate;
  }
  return best;
}

/**
 * @param {TraceNode | undefined} root
 * @param {Map<string, TraceNode>} nodes
 */
function assignDepths(root, nodes) {
  if (!root) return;
  /** @type {Array<[TraceNode, number]>} */
  const queue = [[root, 0]];
  const seen = new Set();
  while (queue.length > 0) {
    const [node, depth] = /** @type {[TraceNode, number]} */ (queue.shift());
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    node.depth = depth;
    for (const childId of node.childIds) {
      const child = nodes.get(childId);
      if (child) queue.push([child, depth + 1]);
    }
  }
}

/**
 * @param {TraceNode[]} nodeList
 * @param {Map<string, TraceNode>} nodes
 * @returns {RequestChain[]}
 */
function findChains(nodeList, nodes) {
  const dependedOn = new Set(nodeList.map((node) => node.dependsOnId).filter(Boolean));
  /** @type {RequestChain[]} */
  const chains = [];
  for (const leaf of nodeList) {
    if (!leaf.dependsOnId || dependedOn.has(leaf.id)) continue;
    const path = walkBack(leaf, nodes, (node) => node.dependsOnId);
    if (path.length < 2) continue;
    const first = path[0];
    const last = path[path.length - 1];
    const networkMs = path.reduce((sum, node) => sum + node.durationMs, 0);
    const totalMs = last.endMs - first.startMs;
    chains.push({
      ids: path.map((node) => node.id),
      totalMs: round(totalMs),
      networkMs: round(networkMs),
      idleMs: round(Math.max(0, totalMs - networkMs)),
    });
  }
  return chains.sort((a, b) => b.totalMs - a.totalMs).slice(0, MAX_CHAINS);
}

/**
 * @param {TraceNode[]} nodeList
 * @param {Map<string, TraceNode>} nodes
 * @returns {CriticalPath | null}
 */
function findCriticalPath(nodeList, nodes) {
  const finishers = nodeList.filter(
    (node) => !NON_BLOCKING_TYPES.has(node.resourceType) && !node.failed && !node.streaming,
  );
  if (finishers.length === 0) return null;
  const last = finishers.reduce((latest, node) => (node.endMs > latest.endMs ? node : latest));
  const path = walkBack(last, nodes, (node) => node.dependsOnId ?? node.parentId);

  /** @type {CriticalPathSegment[]} */
  const segments = path.map((node, index) => {
    const previous = index > 0 ? path[index - 1] : null;
    return {
      id: node.id,
      startMs: node.startMs,
      endMs: node.endMs,
      gapMs: previous ? round(Math.max(0, node.startMs - previous.endMs)) : 0,
      via: !previous ? 'root' : node.dependsOnId === previous.id ? 'dependsOn' : 'parent',
    };
  });
  return { segments, totalMs: round(last.endMs) };
}

/**
 * Follows an edge back to its origin and returns the path in forward order.
 *
 * @param {TraceNode} start
 * @param {Map<string, TraceNode>} nodes
 * @param {(node: TraceNode) => string | null} edge
 * @returns {TraceNode[]}
 */
function walkBack(start, nodes, edge) {
  /** @type {TraceNode[]} */
  const path = [];
  const seen = new Set();
  /** @type {TraceNode | undefined} */
  let current = start;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    const nextId = edge(current);
    current = nextId ? nodes.get(nextId) : undefined;
  }
  return path;
}

/**
 * Picks the cold load closest to the median wall time, so reports show a typical load rather
 * than the fastest or slowest outlier.
 *
 * @template {{ cache: string, error: string | null, wallTimeMs: number }} T
 * @param {T[]} loads
 * @returns {T | null}
 */
export function pickRepresentativeLoad(loads) {
  const usable = loads
    .filter((load) => load.cache === 'cold' && load.error === null)
    .sort((a, b) => a.wallTimeMs - b.wallTimeMs);
  if (usable.length === 0) return null;
  return usable[Math.floor((usable.length - 1) / 2)];
}

/**
 * Renders the parent tree as indented text, for terminals and Markdown.
 *
 * @param {Trace} trace
 * @param {{ maxNodes?: number }} [options]
 * @returns {string[]}
 */
export function renderTraceTree(trace, { maxNodes = 60 } = {}) {
  const nodes = new Map(trace.nodes.map((node) => [node.id, node]));
  const criticalIds = new Set(trace.criticalPath?.segments.map((segment) => segment.id) ?? []);
  /** @type {string[]} */
  const lines = [];
  const root = trace.rootId ? nodes.get(trace.rootId) : undefined;
  if (!root) return lines;

  /**
   * @param {TraceNode} node
   * @param {string} prefix
   * @param {boolean} isLast
   * @param {boolean} isRoot
   */
  const visit = (node, prefix, isLast, isRoot) => {
    if (lines.length >= maxNodes) return;
    const connector = isRoot ? '' : isLast ? '└─ ' : '├─ ';
    const marker = criticalIds.has(node.id) ? ' ◆' : '';
    const waited = node.dependsOnId ? ' (after previous API call)' : '';
    lines.push(
      `${prefix}${connector}${describeNode(node)} ${Math.round(node.durationMs)} ms${waited}${marker}`,
    );
    const children = node.childIds
      .map((id) => nodes.get(id))
      .filter((child) => child !== undefined)
      .sort((a, b) => a.startMs - b.startMs);
    children.forEach((child, index) => {
      visit(
        child,
        isRoot ? '' : `${prefix}${isLast ? '   ' : '│  '}`,
        index === children.length - 1,
        false,
      );
    });
  };
  visit(root, '', true, true);
  if (lines.length >= maxNodes && trace.nodes.length > maxNodes) {
    lines.push(`… ${trace.nodes.length - maxNodes} more requests`);
  }
  return lines;
}

/**
 * @param {TraceNode} node
 * @returns {string}
 */
export function describeNode(node) {
  let label;
  try {
    const url = new URL(node.url);
    const search = node.graphqlOperation ? '' : url.search;
    label = node.thirdParty ? `${url.host}${url.pathname}` : `${url.pathname}${search}`;
  } catch {
    label = node.url;
  }
  if (node.graphqlOperation) label = `${label} (${node.graphqlOperation})`;
  if (label.length > 80) label = `${label.slice(0, 77)}…`;
  return `${node.method === 'GET' ? '' : `${node.method} `}${label} [${node.resourceType}${node.status ? ` ${node.status}` : ''}]`;
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

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
