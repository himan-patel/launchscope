import { detectBottlenecks } from './bottlenecks.js';
import { EndpointAccumulator } from './endpoints.js';
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
 * @typedef {object} RunTotals
 * @property {number} routes
 * @property {number} failedRoutes
 * @property {number} pageLoads
 * @property {number} requests
 * @property {number} endpoints
 * @property {{ critical: number, warning: number, info: number }} findings
 */

/**
 * @typedef {object} RunAnalysis
 * @property {import('./routes.js').RouteSummary[]} routes
 * @property {import('./endpoints.js').EndpointSummary[]} endpoints
 * @property {import('./bottlenecks.js').Finding[]} bottlenecks
 * @property {RunTotals} totals
 */

/**
 * Builds the run analysis incrementally: each route is summarized and folded into the endpoint
 * statistics as soon as it has been measured, after which its raw page loads can be released.
 * Memory then grows with the number of endpoints and samples, not with every request ever seen.
 */
export class RunAccumulator {
  /** @type {import('./routes.js').RouteSummary[]} */
  #routes = [];
  /** @type {Map<string, import('../trace/hop-tree.js').Trace>} */
  #traces = new Map();
  #endpoints = new EndpointAccumulator();
  #pageLoads = 0;
  #requests = 0;

  /**
   * @param {RouteInput} input
   * @returns {import('./routes.js').RouteSummary}
   */
  addRoute(input) {
    const summary = summarizeRoute(input);
    this.#routes.push(summary);
    if (input.trace) this.#traces.set(input.slug, input.trace);
    for (const load of input.loads) {
      this.#pageLoads += 1;
      this.#requests += load.requests.length;
      if (load.cache !== 'cold' || load.error !== null) continue;
      this.#endpoints.add({
        routeSlug: input.slug,
        pageOrigin: new URL(load.finalUrl ?? input.url).origin,
        requests: load.requests,
      });
    }
    return summary;
  }

  /**
   * Folds in API operations measured directly (listed, from an OpenAPI document, or from the repository).
   *
   * @param {Array<{ requests: import('../capture/network-recorder.js').RequestRecord[] }>} loads
   * @param {string} origin
   * @param {'listed' | 'openapi' | 'repo'} [source]
   */
  addApiLoads(loads, origin, source = 'openapi') {
    for (const load of loads) {
      this.#requests += load.requests.length;
      this.#endpoints.add({
        routeSlug: `(${source})`,
        pageOrigin: origin,
        requests: load.requests,
        source,
      });
    }
  }

  /**
   * @param {import('./budgets.js').Budgets} budgets
   * @returns {RunAnalysis}
   */
  finish(budgets) {
    const routes = this.#routes;
    const endpoints = this.#endpoints.result();
    const bottlenecks = detectBottlenecks({ routes, traces: this.#traces, endpoints, budgets });
    return {
      routes,
      endpoints,
      bottlenecks,
      totals: {
        routes: routes.length,
        failedRoutes: routes.filter((route) => route.error !== null).length,
        pageLoads: this.#pageLoads,
        requests: this.#requests,
        endpoints: endpoints.length,
        findings: countBySeverity(bottlenecks),
      },
    };
  }
}

/**
 * Aggregates all measured routes at once (convenience wrapper over `RunAccumulator`).
 *
 * @param {RouteInput[]} inputs
 * @param {import('./budgets.js').Budgets} budgets
 * @returns {RunAnalysis}
 */
export function analyzeRun(inputs, budgets) {
  const accumulator = new RunAccumulator();
  for (const input of inputs) accumulator.addRoute(input);
  return accumulator.finish(budgets);
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
