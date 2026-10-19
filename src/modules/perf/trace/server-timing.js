/**
 * @typedef {object} ServerTimingMetric
 * @property {string} name
 * @property {number | null} durationMs
 * @property {string | null} description
 */

const MAX_METRICS = 20;

/**
 * Parses a `Server-Timing` header (W3C Server Timing), e.g.
 * `db;dur=53;desc="primary", cache;desc="miss", app;dur=12.5`.
 *
 * Servers that emit this header reveal what happened behind the response: database time,
 * cache hits, upstream calls. That is the only way to see backend hops from the outside.
 *
 * @param {string | undefined} header
 * @returns {ServerTimingMetric[]}
 */
export function parseServerTiming(header) {
  if (!header) return [];
  /** @type {ServerTimingMetric[]} */
  const metrics = [];
  for (const entry of splitOutsideQuotes(header, ',')) {
    const [rawName, ...params] = splitOutsideQuotes(entry, ';');
    const name = rawName.trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;

    /** @type {ServerTimingMetric} */
    const metric = { name, durationMs: null, description: null };
    for (const param of params) {
      const separator = param.indexOf('=');
      if (separator === -1) continue;
      const key = param.slice(0, separator).trim().toLowerCase();
      const value = unquote(param.slice(separator + 1).trim());
      if (key === 'dur' && metric.durationMs === null) {
        const duration = Number(value);
        if (Number.isFinite(duration) && duration >= 0) metric.durationMs = duration;
      } else if (key === 'desc' && metric.description === null) {
        metric.description = value.slice(0, 200);
      }
    }
    metrics.push(metric);
    if (metrics.length >= MAX_METRICS) break;
  }
  return metrics;
}

/**
 * @param {string} text
 * @param {string} separator
 * @returns {string[]}
 */
function splitOutsideQuotes(text, separator) {
  /** @type {string[]} */
  const parts = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && quoted && index + 1 < text.length) {
      current += char + text[index + 1];
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === separator && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.filter((part) => part.trim() !== '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}
