/**
 * @typedef {object} Distribution
 * @property {number} count
 * @property {number} min
 * @property {number} max
 * @property {number} mean
 * @property {number} p50
 * @property {number} p75
 * @property {number} p90
 * @property {number} p95
 * @property {number} p99
 * @property {number} stdev Population standard deviation.
 */

/**
 * Percentile with linear interpolation between closest ranks (the common "type 7" method used
 * by spreadsheets and NumPy), on an already sorted array.
 *
 * @param {number[]} sorted Ascending values.
 * @param {number} p Percentile from 0 to 100.
 * @returns {number}
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

/**
 * Summarizes samples, ignoring null, undefined, and non-finite values.
 *
 * @param {Array<number | null | undefined>} samples
 * @returns {Distribution | null} Null when there are no usable samples.
 */
export function summarize(samples) {
  const values = /** @type {number[]} */ (
    samples.filter((value) => typeof value === 'number' && Number.isFinite(value))
  ).sort((a, b) => a - b);
  if (values.length === 0) return null;

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    min: round(values[0]),
    max: round(values[values.length - 1]),
    mean: round(mean),
    p50: round(percentile(values, 50)),
    p75: round(percentile(values, 75)),
    p90: round(percentile(values, 90)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    stdev: round(Math.sqrt(variance)),
  };
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
