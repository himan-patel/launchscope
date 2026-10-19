import { readFile } from 'node:fs/promises';
import { UsageError } from '../../../core/errors.js';
import { templatePath } from '../analyze/endpoints.js';

/**
 * A stress scenario replays one route the way a browser loaded it: the document first, then
 * its same-origin API calls level by level. Calls that waited on another call in the real load
 * (`dependsOn` in the trace) wait in the replay too; independent calls run in parallel. Only
 * GET requests to the target origin are replayed, so the stress test never writes data or
 * sends load to third parties.
 */

const API_TYPES = new Set(['Fetch', 'XHR']);
const ASSET_TYPES = new Set(['Script', 'Stylesheet', 'Image', 'Font']);

/**
 * @typedef {object} ScenarioRequest
 * @property {string} url
 * @property {string} label Endpoint label used in per-hop statistics, e.g. `GET /api/me`.
 * @property {'document' | 'api' | 'asset'} kind
 */

/**
 * @typedef {object} Scenario
 * @property {string} slug
 * @property {string} url
 * @property {ScenarioRequest[][]} levels Requests in each level run in parallel; levels run in order.
 */

/**
 * @param {Array<{ slug: string, url: string, trace: import('../trace/hop-tree.js').Trace | null }>} routes
 * @param {{ targetOrigin: string, includeAssets: boolean }} options
 * @returns {Scenario[]}
 */
export function buildScenarios(routes, { targetOrigin, includeAssets }) {
  /** @type {Scenario[]} */
  const scenarios = [];
  for (const route of routes) {
    const trace = route.trace;
    if (!trace?.rootId) continue;
    const nodes = new Map(trace.nodes.map((node) => [node.id, node]));
    const root = nodes.get(trace.rootId);
    if (!root || root.failed || originOf(root.url) !== targetOrigin) continue;

    /** @type {Map<string, number>} */
    const levels = new Map();
    /** @param {import('../trace/hop-tree.js').TraceNode} node @returns {number} */
    const levelOf = (node) => {
      const known = levels.get(node.id);
      if (known !== undefined) return known;
      levels.set(node.id, 1); // guards against cycles
      const dependency = node.dependsOnId ? nodes.get(node.dependsOnId) : undefined;
      const level =
        dependency && isReplayable(dependency, targetOrigin, includeAssets)
          ? levelOf(dependency) + 1
          : 1;
      levels.set(node.id, level);
      return level;
    };

    /** @type {ScenarioRequest[][]} */
    const grouped = [
      [{ url: root.redirectedFrom ?? root.url, label: label(root), kind: 'document' }],
    ];
    for (const node of trace.nodes) {
      if (node.id === root.id || !isReplayable(node, targetOrigin, includeAssets)) continue;
      const level = levelOf(node);
      grouped[level] ??= [];
      grouped[level].push({
        url: node.url,
        label: label(node),
        kind: API_TYPES.has(node.resourceType) ? 'api' : 'asset',
      });
    }
    scenarios.push({ slug: route.slug, url: route.url, levels: grouped.filter(Boolean) });
  }
  return scenarios;
}

/**
 * A scenario that calls every measured OpenAPI operation in parallel, so endpoints no page calls
 * are also tested under load.
 *
 * @param {import('../discover/openapi.js').ApiOperation[]} operations
 * @returns {Scenario}
 */
export function apiScenario(operations) {
  return {
    slug: '(openapi)',
    url: operations[0]?.url ?? '',
    levels: [
      operations.map((operation) => ({
        url: operation.url,
        label: `GET ${templatePath(new URL(operation.url).pathname)}`,
        kind: /** @type {const} */ ('api'),
      })),
    ],
  };
}

/**
 * Builds the Cookie header for a URL from a Playwright storage-state file, so the stress test
 * runs with the same session as the browser measurements. Cookie values stay in memory.
 *
 * @param {string | undefined} storageStatePath
 * @returns {Promise<(url: string) => string | undefined>}
 */
export async function loadCookieJar(storageStatePath) {
  if (!storageStatePath) return () => undefined;
  /** @type {Array<{ name: string, value: string, domain: string, path: string, expires: number, secure: boolean }>} */
  let cookies;
  try {
    cookies = JSON.parse(await readFile(storageStatePath, 'utf8')).cookies ?? [];
  } catch (error) {
    throw new UsageError(`Could not read cookies from ${storageStatePath}.`, { cause: error });
  }
  const nowSeconds = Date.now() / 1000;
  return (url) => {
    const target = new URL(url);
    const matching = cookies.filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, '');
      const domainMatches = target.hostname === domain || target.hostname.endsWith(`.${domain}`);
      const pathMatches = target.pathname.startsWith(cookie.path || '/');
      const fresh = cookie.expires === -1 || cookie.expires > nowSeconds;
      const secureOk =
        !cookie.secure ||
        target.protocol === 'https:' ||
        target.hostname === 'localhost' ||
        target.hostname === '127.0.0.1';
      return domainMatches && pathMatches && fresh && secureOk;
    });
    return matching.length > 0
      ? matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
      : undefined;
  };
}

/**
 * @param {import('../trace/hop-tree.js').TraceNode} node
 * @param {string} targetOrigin
 * @param {boolean} includeAssets
 */
function isReplayable(node, targetOrigin, includeAssets) {
  if (
    node.method !== 'GET' ||
    node.failed ||
    node.streaming ||
    originOf(node.url) !== targetOrigin
  ) {
    return false;
  }
  return API_TYPES.has(node.resourceType) || (includeAssets && ASSET_TYPES.has(node.resourceType));
}

/** @param {import('../trace/hop-tree.js').TraceNode} node */
function label(node) {
  const url = new URL(node.redirectedFrom ?? node.url);
  const path = templatePath(url.pathname);
  return `${node.method} ${path}${node.graphqlOperation ? ` (${node.graphqlOperation})` : ''}`;
}

/** @param {string} url */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
