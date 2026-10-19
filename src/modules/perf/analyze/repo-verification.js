import { normalizeRoute } from '../discover/routes.js';
import { templatePath } from './endpoints.js';

/**
 * Checks every route found in the repository against what the live app actually returned, so the
 * report states which source routes exist, which do not (404/410), which fail, and which were
 * not measured (route limit, exclusions, interruption). Nothing here is inferred: each result is
 * the HTTP outcome of a measured load or request.
 *
 * Note for single-page apps: a server that answers every path with `index.html` returns 200 even
 * for routes the client then renders as "not found"; the result reflects the HTTP response.
 */

/** @typedef {'ok' | 'not-found' | 'error' | 'not-measured'} VerificationResult */

/**
 * @typedef {object} VerifiedRoute
 * @property {string} route Path as found in the repository (with routeParams filled in).
 * @property {VerificationResult} result
 * @property {number | null} status HTTP status (pages: main document after redirects; APIs:
 *   the most frequent status across runs).
 * @property {string | null} redirectedTo Final path when a page redirected elsewhere.
 * @property {string | null} reason Why a route errored or was not measured.
 */

/**
 * @typedef {object} RepoVerification
 * @property {VerifiedRoute[]} pages
 * @property {VerifiedRoute[]} apis
 * @property {Record<VerificationResult, number>} counts Pages and APIs together.
 */

/**
 * @param {object} input
 * @param {{ pages: string[], apis: string[] }} input.repo
 * @param {import('./routes.js').RouteSummary[]} input.routes
 * @param {import('./endpoints.js').EndpointSummary[]} input.endpoints
 * @param {URL} input.targetUrl
 * @param {RegExp[]} input.exclude
 * @returns {RepoVerification}
 */
export function verifyRepoRoutes({ repo, routes, endpoints, targetUrl, exclude }) {
  const routesByUrl = new Map(routes.map((route) => [route.url, route]));
  const pages = repo.pages.map((path) => {
    const normalized = normalizeRoute(path, targetUrl, exclude);
    if ('skip' in normalized) return notMeasured(path, `skipped as ${normalized.skip}`);
    const route = routesByUrl.get(normalized.url);
    if (!route) return notMeasured(path, 'not measured (route limit or interrupted run)');
    if (route.error) {
      return {
        route: path,
        result: /** @type {VerificationResult} */ ('error'),
        status: route.status,
        redirectedTo: null,
        reason: route.error,
      };
    }
    const finalPath = route.finalUrl ? safePath(route.finalUrl) : null;
    return {
      route: path,
      result: classify(route.status),
      status: route.status,
      redirectedTo: finalPath && finalPath !== safePath(normalized.url) ? finalPath : null,
      reason: null,
    };
  });

  const endpointsByKey = new Map(endpoints.map((endpoint) => [endpoint.key, endpoint]));
  const apis = repo.apis.map((path) => {
    const url = new URL(path, targetUrl.origin);
    const endpoint = endpointsByKey.get(`GET ${url.origin}${templatePath(url.pathname)}`);
    if (!endpoint || !endpoint.discoveredBy.includes('repo')) {
      return notMeasured(path, 'not measured (operation limit or interrupted run)');
    }
    const status = mostFrequentStatus(endpoint.statusCounts);
    return {
      route: path,
      result: status === null ? /** @type {VerificationResult} */ ('error') : classify(status),
      status,
      redirectedTo: null,
      reason: status === null ? 'request failed without a response' : null,
    };
  });

  /** @type {Record<VerificationResult, number>} */
  const counts = { ok: 0, 'not-found': 0, error: 0, 'not-measured': 0 };
  for (const entry of [...pages, ...apis]) counts[entry.result] += 1;
  return { pages, apis, counts };
}

/**
 * One finding per repository route the live app answers with 404 or 410.
 *
 * @param {RepoVerification} verification
 * @returns {import('./bottlenecks.js').Finding[]}
 */
export function repoVerificationFindings(verification) {
  return [
    ...verification.pages.map((entry) => ({ entry, kind: 'page' })),
    ...verification.apis.map((entry) => ({ entry, kind: 'API route' })),
  ]
    .filter(({ entry }) => entry.result === 'not-found')
    .map(({ entry, kind }) => ({
      id: `repo-route-not-found:${entry.route}`,
      rule: 'repo-route-not-found',
      severity: /** @type {const} */ ('warning'),
      category: 'errors',
      title: `${entry.route} is a ${kind} in the repository but returns ${entry.status}`,
      detail: `The repository defines ${entry.route}, and the live app answered ${entry.status}.`,
      recommendation:
        'Deploy the route, remove dead route definitions, or check that routeParams point to records that exist.',
      subject: {},
      evidence: { route: entry.route, status: entry.status ?? 0 },
      impact: 100,
    }));
}

/**
 * @param {number | null} status
 * @returns {VerificationResult}
 */
function classify(status) {
  if (status === 404 || status === 410) return 'not-found';
  if (status === null || status >= 400) return 'error';
  return 'ok';
}

/**
 * @param {Record<string, number>} counts
 * @returns {number | null}
 */
function mostFrequentStatus(counts) {
  let best = null;
  let bestCount = 0;
  for (const [status, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = Number(status);
      bestCount = count;
    }
  }
  return best;
}

/**
 * @param {string} route
 * @param {string} reason
 * @returns {VerifiedRoute}
 */
function notMeasured(route, reason) {
  return { route, result: 'not-measured', status: null, redirectedTo: null, reason };
}

/** @param {string} url */
function safePath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname.replace(/(.)\/$/, '$1')}${parsed.search}`;
  } catch {
    return null;
  }
}
