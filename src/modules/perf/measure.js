import { createMeasurementContext } from './capture/browser.js';
import { capturePageLoad } from './capture/page-capture.js';
import { redactHarFile } from './report/har.js';

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

  for (let run = 1; run <= settings.runs; run += 1) {
    const first = run === 1;
    const recordHarTo = first ? harPath : undefined;
    const context = await createMeasurementContext(browser, devices, settings, {
      harPath: recordHarTo,
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
    const context = await createMeasurementContext(browser, devices, settings);
    try {
      await capturePageLoad({ context, url, settings, cache: 'warm', run: 0 });
      for (let run = 1; run <= settings.warmRuns; run += 1) {
        const result = await capturePageLoad({ context, url, settings, cache: 'warm', run });
        loads.push(result.load);
      }
    } finally {
      await context.close();
    }
  }

  return { url, loads, screenshot, links };
}
