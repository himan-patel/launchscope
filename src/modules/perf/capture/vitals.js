/**
 * In-page Web Vitals collection. `installVitalsObserver` is serialized by Playwright and runs
 * inside the page before any of the page's own scripts, so it must be self-contained.
 *
 * Values are lab measurements from a single load:
 * - LCP: last `largest-contentful-paint` entry before collection.
 * - CLS: largest session window of layout shifts (1 s gap, 5 s cap), excluding shifts after input.
 * - TBT: sum of (long task duration − 50 ms) for long tasks starting after FCP. Lab
 *   approximation: the window ends at collection time rather than at Time to Interactive.
 */

/**
 * @typedef {object} PageVitals
 * @property {number | null} ttfbMs Navigation responseStart (includes redirects, DNS, TLS).
 * @property {number | null} fcpMs
 * @property {number | null} lcpMs
 * @property {string | null} lcpResourceUrl
 * @property {number} cls
 * @property {number} tbtMs
 * @property {number} longTaskCount
 * @property {number | null} domContentLoadedMs
 * @property {number | null} loadMs
 * @property {number | null} documentTransferBytes
 */

export function installVitalsObserver() {
  /** @type {{ lcp: number | null, lcpUrl: string | null, shifts: Array<[number, number]>, longTasks: Array<[number, number]> }} */
  const state = { lcp: null, lcpUrl: null, shifts: [], longTasks: [] };

  /**
   * @param {string} type
   * @param {(entry: any) => void} onEntry
   */
  const observe = (type, onEntry) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(onEntry)).observe({
        type,
        buffered: true,
      });
    } catch {
      // Entry type not supported by this browser; the metric stays empty.
    }
  };

  observe('largest-contentful-paint', (entry) => {
    state.lcp = entry.startTime;
    state.lcpUrl = entry.url || null;
  });
  observe('layout-shift', (entry) => {
    if (!entry.hadRecentInput) state.shifts.push([entry.startTime, entry.value]);
  });
  observe('longtask', (entry) => {
    state.longTasks.push([entry.startTime, entry.duration]);
  });

  // Last DOM change, used to tell when a client-side navigation has finished rendering.
  let lastMutation = 0;
  const startMutationObserver = () => {
    try {
      new MutationObserver(() => {
        lastMutation = performance.now();
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      // MutationObserver unavailable; navigation timing falls back to network activity.
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startMutationObserver, { once: true });
  } else {
    startMutationObserver();
  }
  Object.defineProperty(window, '__launchscopeLastMutation', {
    configurable: false,
    enumerable: false,
    value: () => lastMutation,
  });

  Object.defineProperty(window, '__launchscopeVitals', {
    configurable: false,
    enumerable: false,
    value: () => {
      const navigation = /** @type {PerformanceNavigationTiming | undefined} */ (
        performance.getEntriesByType('navigation')[0]
      );
      const fcpEntry = performance
        .getEntriesByType('paint')
        .find((entry) => entry.name === 'first-contentful-paint');
      const fcp = fcpEntry ? fcpEntry.startTime : null;

      let cls = 0;
      let windowValue = 0;
      let windowStart = -Infinity;
      let previous = -Infinity;
      for (const [time, value] of state.shifts) {
        if (time - previous > 1000 || time - windowStart > 5000) {
          windowValue = 0;
          windowStart = time;
        }
        windowValue += value;
        previous = time;
        cls = Math.max(cls, windowValue);
      }

      let tbt = 0;
      for (const [start, duration] of state.longTasks) {
        if (fcp !== null && start >= fcp) tbt += Math.max(0, duration - 50);
      }

      const positive = (/** @type {number | undefined} */ value) =>
        value !== undefined && value > 0 ? value : null;

      return {
        ttfbMs: positive(navigation?.responseStart),
        fcpMs: fcp,
        lcpMs: state.lcp,
        lcpResourceUrl: state.lcpUrl,
        cls: Math.round(cls * 10_000) / 10_000,
        tbtMs: Math.round(tbt),
        longTaskCount: state.longTasks.length,
        domContentLoadedMs: positive(navigation?.domContentLoadedEventEnd),
        loadMs: positive(navigation?.loadEventEnd),
        documentTransferBytes: navigation ? navigation.transferSize : null,
      };
    },
  });
}
