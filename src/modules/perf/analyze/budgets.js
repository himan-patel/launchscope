import { UsageError } from '../../../core/errors.js';

/**
 * Thresholds that turn measurements into findings. Each budget has a `warning` and a
 * `critical` level. Web Vitals defaults follow Google's published "good / poor" boundaries;
 * the rest are pragmatic defaults that teams can tune in `perf.budgets`.
 *
 * @typedef {{ warning: number, critical: number }} Threshold
 */

export const DEFAULT_BUDGETS = Object.freeze({
  /** Largest Contentful Paint, median of cold runs. */
  lcpMs: Object.freeze({ warning: 2500, critical: 4000 }),
  /** First Contentful Paint, median of cold runs. */
  fcpMs: Object.freeze({ warning: 1800, critical: 3000 }),
  /** Document time to first byte, median of cold runs. */
  ttfbMs: Object.freeze({ warning: 800, critical: 1800 }),
  /** Cumulative Layout Shift, median of cold runs. */
  cls: Object.freeze({ warning: 0.1, critical: 0.25 }),
  /** Total Blocking Time (lab), median of cold runs. */
  tbtMs: Object.freeze({ warning: 200, critical: 600 }),
  /** API call duration, p95 across all calls. */
  apiP95Ms: Object.freeze({ warning: 500, critical: 1500 }),
  /** Server wait (TTFB after the request was sent), median across calls. */
  serverWaitMs: Object.freeze({ warning: 300, critical: 1000 }),
  /** Extra time a call spends on a new connection versus a reused one, median. */
  connectionSetupMs: Object.freeze({ warning: 200, critical: 600 }),
  /** Decoded API response size, median. */
  apiPayloadBytes: Object.freeze({ warning: 500 * 1024, critical: 2 * 1024 * 1024 }),
  /** Longest array in a JSON response. */
  jsonArrayItems: Object.freeze({ warning: 200, critical: 1000 }),
  /** Calls in the longest sequential API chain. */
  chainLength: Object.freeze({ warning: 3, critical: 5 }),
  /** Transferred bytes per page load, median. */
  pageWeightBytes: Object.freeze({ warning: 2 * 1024 * 1024, critical: 5 * 1024 * 1024 }),
  /** Requests per page load, median. */
  requestCount: Object.freeze({ warning: 100, critical: 200 }),
  /** Identical requests (same method and URL) within one load. */
  duplicateCalls: Object.freeze({ warning: 2, critical: 4 }),
  /** Client-side navigation (with --spa): click until network and DOM settle, median. */
  navigationMs: Object.freeze({ warning: 1000, critical: 2500 }),
  /** Lighthouse performance score (0–1); LOWER is worse, so these are minimums. */
  lighthouseScore: Object.freeze({ warning: 0.9, critical: 0.5 }),
  /** Stress test: p95 latency at the highest stage that completed. */
  stressP95Ms: Object.freeze({ warning: 1000, critical: 3000 }),
  /** Stress test: error ratio at any stage. */
  stressErrorRate: Object.freeze({ warning: 0.01, critical: 0.05 }),
});

/** @typedef {{ [K in keyof typeof DEFAULT_BUDGETS]: Threshold }} Budgets */

/**
 * Merges user budgets over the defaults. A bare number sets the warning level and keeps the
 * default critical level (raised if needed so warning ≤ critical).
 *
 * @param {unknown} config The `perf.budgets` config value.
 * @returns {Budgets}
 */
export function resolveBudgets(config) {
  /** @type {Record<string, Threshold>} */
  const budgets = Object.fromEntries(
    Object.entries(DEFAULT_BUDGETS).map(([key, value]) => [key, { ...value }]),
  );
  if (config === undefined) return /** @type {Budgets} */ (budgets);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new UsageError('Config "perf.budgets" must be an object.');
  }

  for (const [key, value] of Object.entries(config)) {
    const current = budgets[key];
    if (!current) {
      throw new UsageError(`Unknown budget "${key}" in config "perf.budgets".`, {
        hint: `Known budgets: ${Object.keys(DEFAULT_BUDGETS).join(', ')}.`,
      });
    }
    if (typeof value === 'number') {
      assertNonNegative(value, key);
      budgets[key] =
        key === 'lighthouseScore'
          ? { warning: value, critical: Math.min(value, current.critical) }
          : { warning: value, critical: Math.max(value, current.critical) };
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new UsageError(`Budget "${key}" must be a number or { "warning", "critical" }.`);
    }
    const unknown = Object.keys(value).filter((name) => name !== 'warning' && name !== 'critical');
    if (unknown.length > 0) {
      throw new UsageError(`Budget "${key}" has unknown field(s): ${unknown.join(', ')}.`);
    }
    const { warning = current.warning, critical = current.critical } =
      /** @type {{ warning?: unknown, critical?: unknown }} */ (value);
    assertNonNegative(warning, `${key}.warning`);
    assertNonNegative(critical, `${key}.critical`);
    const inverted = key === 'lighthouseScore';
    if (
      inverted
        ? /** @type {number} */ (warning) < /** @type {number} */ (critical)
        : /** @type {number} */ (warning) > /** @type {number} */ (critical)
    ) {
      throw new UsageError(
        inverted
          ? `Budget "${key}" has a warning level below its critical level (lower scores are worse).`
          : `Budget "${key}" has a warning level above its critical level.`,
      );
    }
    budgets[key] = {
      warning: /** @type {number} */ (warning),
      critical: /** @type {number} */ (critical),
    };
  }
  return /** @type {Budgets} */ (budgets);
}

/**
 * @param {Threshold} threshold
 * @param {number | null | undefined} value
 * @returns {'critical' | 'warning' | null}
 */
export function classify(threshold, value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value >= threshold.critical) return 'critical';
  if (value >= threshold.warning) return 'warning';
  return null;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertNonNegative(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new UsageError(`Budget "${label}" must be a non-negative number.`);
  }
}
