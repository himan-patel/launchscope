import { randomBytes } from 'node:crypto';

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) for measured page loads.
 *
 * Each page load gets its own trace ID; every same-origin request it makes carries a
 * `traceparent` header with that trace ID and a fresh span ID, marked as sampled. A server
 * instrumented with OpenTelemetry (or any W3C-compatible tracer) then records its database
 * queries, cache lookups, and service calls as children of that trace, so the report can link a
 * slow page load straight to its backend trace. Headers are never added to other origins.
 */

/**
 * @returns {string} 32 lowercase hex characters, never all zeros.
 */
export function newTraceId() {
  let id;
  do id = randomBytes(16).toString('hex');
  while (/^0+$/.test(id));
  return id;
}

/**
 * @returns {string} 16 lowercase hex characters, never all zeros.
 */
export function newSpanId() {
  let id;
  do id = randomBytes(8).toString('hex');
  while (/^0+$/.test(id));
  return id;
}

/**
 * @param {string} traceId
 * @returns {string} A sampled `traceparent` header value with a fresh parent span ID.
 */
export function traceparentFor(traceId) {
  return `00-${traceId}-${newSpanId()}-01`;
}

/**
 * Remembers which trace ID belongs to which page, so a request can be tagged with the trace of
 * the page that made it (warm runs reuse one browser context for several page loads).
 */
export class TraceRegistry {
  /** @type {WeakMap<object, string>} */
  #byPage = new WeakMap();

  /**
   * @param {object} page
   * @returns {string} The new trace ID for this page load.
   */
  startTrace(page) {
    const traceId = newTraceId();
    this.#byPage.set(page, traceId);
    return traceId;
  }

  /**
   * @param {object | null | undefined} page
   * @returns {string | null}
   */
  traceIdFor(page) {
    return page ? (this.#byPage.get(page) ?? null) : null;
  }
}

/**
 * Builds a link to a trace from a template such as
 * `https://ui.honeycomb.io/team/environments/prod/trace?trace_id={traceId}`.
 *
 * @param {string | undefined} template
 * @param {string} traceId
 * @returns {string | null}
 */
export function traceUrl(template, traceId) {
  return template ? template.replaceAll('{traceId}', traceId) : null;
}
