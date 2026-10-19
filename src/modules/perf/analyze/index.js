import { detectBottlenecks } from './bottlenecks.js';
import { aggregateEndpoints } from './endpoints.js';
import { summarizeRoute } from './routes.js';

/**
 * @typedef {object} RouteInput
 * @property {string} url
 * @property {string} slug
 * @property {number} depth
 * @property {string} source
 * @property {import('../capture/page-capture.js').PageLoad[]} loads
 * @property {import('../trace/hop-tree.js').Trace | null} trace
 * @property {number | null} representativeRun
 */

/**
 * @typedef {object} RunAnalysis
 * @property {import('./routes.js').RouteSummary[]} routes
 * @property {import('./endpoints.js').EndpointSummary[]} endpoints
 * @property {import('./bottlenecks.js').Finding[]} bottlenecks
 * @property {{ routes: number, failedRoutes: number, pageLoads: number, requests: number, endpoints: number, findings: { critical: number, warning: number, info: number } }} totals
 */

/**
 * Aggregates all measured routes into route summaries, endpoint statistics, and findings.
 *
 * @param {RouteInput[]} inputs
 * @param {import('./budgets.js').Budgets} budgets
 * @returns {RunAnalysis}
 */
export function analyzeRun(inputs, budgets) {
  const routes = inputs.map((input) => summarizeRoute(input));
  const coldLoads = inputs.flatMap((input) =>
    input.loads
      .filter((load) => load.cache === 'cold' && load.error === null)
      .map((load) => ({
        routeSlug: input.slug,
        pageOrigin: new URL(load.finalUrl ?? input.url).origin,
        requests: load.requests,
      })),
  );
  const endpoints = aggregateEndpoints(coldLoads);
  /** @type {Map<string, import('../trace/hop-tree.js').Trace>} */
  const traces = new Map();
  for (const input of inputs) if (input.trace) traces.set(input.slug, input.trace);
  const bottlenecks = detectBottlenecks({ routes, traces, endpoints, budgets });

  return {
    routes,
    endpoints,
    bottlenecks,
    totals: {
      routes: routes.length,
      failedRoutes: routes.filter((route) => route.error !== null).length,
      pageLoads: inputs.reduce((sum, input) => sum + input.loads.length, 0),
      requests: inputs.reduce(
        (sum, input) => sum + input.loads.reduce((total, load) => total + load.requests.length, 0),
        0,
      ),
      endpoints: endpoints.length,
      findings: countBySeverity(bottlenecks),
    },
  };
}

/**
 * @param {import('./bottlenecks.js').Finding[]} findings
 * @returns {{ critical: number, warning: number, info: number }}
 */
export function countBySeverity(findings) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
