import { createMeasurementContext } from './capture/browser.js';
import { capturePageLoad } from './capture/page-capture.js';
import { TraceRegistry } from './capture/trace-context.js';
import { redactHarFile } from './report/har.js';

/** Methods that may be replayed when allowlisted. DELETE is never replayed. */
export const REPLAYABLE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * @typedef {object} RouteMeasurement
 * @property {string} url
 * @property {import('./capture/page-capture.js').PageLoad[]} loads Cold runs, then warm runs.
 * @property {Buffer | null} screenshot From the first cold run.
 * @property {string[]} links Links found on the page during the first cold run.
 */

/**
 * Measures one route: `settings.runs` cold loads, each in a fresh context (empty cache and a
 * clean connection pool), then optional warm loads in a context primed by one unrecorded load.
 *
 * @param {object} options
 * @param {import('playwright').Browser} options.browser
 * @param {typeof import('playwright').devices} options.devices
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {string} options.url
 * @param {string} [options.harPath] Where to save a redacted HAR of the first cold run.
 * @returns {Promise<RouteMeasurement>}
 */
export async function measureRoute({ browser, devices, settings, url, harPath }) {
  /** @type {import('./capture/page-capture.js').PageLoad[]} */
  const loads = [];
  /** @type {Buffer | null} */
  let screenshot = null;
  /** @type {string[]} */
  let links = [];
  const traces = settings.traceContext.enabled ? new TraceRegistry() : undefined;
  const targetOrigin = settings.targetUrl.origin;
  const replay = settings.stress.enabled ? settings.stress.replay : [];
  /** @param {{ url: string, method: string }} record */
  const captureBody = (record) => {
    if (replay.length === 0 || !REPLAYABLE_METHODS.has(record.method)) return false;
    const url = new URL(record.url);
    return (
      url.origin === targetOrigin &&
      replay.some((pattern) => pattern.test(`${url.pathname}${url.search}`))
    );
  };

  for (let run = 1; run <= settings.runs; run += 1) {
    const first = run === 1;
    const recordHarTo = first ? harPath : undefined;
    const context = await createMeasurementContext(browser, devices, settings, {
      harPath: recordHarTo,
      traces,
    });
    try {
      const result = await capturePageLoad({
        context,
        url,
        settings,
        cache: 'cold',
        run,
        collectLinks: first,
        inspectJson: true,
        screenshot: first,
        traces,
        captureBody,
      });
      loads.push(result.load);
      if (first) {
        screenshot = result.screenshot;
        links = result.load.links;
      }
    } finally {
      await context.close();
    }
    if (recordHarTo) await redactHarFile(recordHarTo);
  }

  if (settings.warmRuns > 0) {
    const context = await createMeasurementContext(browser, devices, settings, { traces });
    try {
      await capturePageLoad({ context, url, settings, cache: 'warm', run: 0 });
      for (let run = 1; run <= settings.warmRuns; run += 1) {
        const result = await capturePageLoad({
          context,
          url,
          settings,
          cache: 'warm',
          run,
          traces,
        });
        loads.push(result.load);
      }
    } finally {
      await context.close();
    }
  }

  return { url, loads, screenshot, links };
}
