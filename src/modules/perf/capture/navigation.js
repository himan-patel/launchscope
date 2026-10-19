import { startRecording } from './page-capture.js';

const NETWORK_IDLE_MS = 500;
const DOM_QUIET_MS = 300;
const MAX_SETTLE_MS = 10_000;
const ROUTER_START_MS = 50;

/**
 * Measures one client-side navigation, the way a user experiences it in a single-page app:
 * load the starting page, wait until it settles, click the link to the target, and record every
 * request and DOM change from the click until the network and the DOM have both gone quiet.
 *
 * A navigation is `soft` when the app's router handled it (no new document was requested) and
 * `full` when the browser loaded a new document (a plain page load).
 *
 * @typedef {object} NavigationSample
 * @property {string} from
 * @property {string} to
 * @property {'soft' | 'full' | 'failed'} kind
 * @property {string | null} error
 * @property {number} durationMs Click until network and DOM settle.
 * @property {number} networkMs Click until the last request finished.
 * @property {number} renderMs Click until the last DOM change.
 * @property {string | null} urlAfter
 * @property {import('./network-recorder.js').RequestRecord[]} requests Started after the click; times relative to it.
 */

/**
 * @param {object} options
 * @param {import('playwright').BrowserContext} options.context
 * @param {import('../settings.js').PerfSettings} options.settings
 * @param {string} options.from
 * @param {string} options.to
 * @returns {Promise<NavigationSample>}
 */
export async function measureNavigation({ context, settings, from, to }) {
  const page = await context.newPage();
  /** @type {NavigationSample} */
  const failed = {
    from,
    to,
    kind: 'failed',
    error: null,
    durationMs: 0,
    networkMs: 0,
    renderMs: 0,
    urlAfter: null,
    requests: [],
  };
  try {
    const { recorder } = await startRecording({
      context,
      page,
      settings,
      cache: 'cold',
      inspectJson: true,
    });
    try {
      await page.goto(from, { waitUntil: 'load', timeout: settings.timeoutMs });
    } catch (error) {
      return { ...failed, error: `Could not load ${from}: ${firstLine(error)}` };
    }
    await recorder.waitForIdle({
      idleMs: NETWORK_IDLE_MS,
      timeoutMs: Math.min(MAX_SETTLE_MS, settings.timeoutMs),
    });
    const before = new Set((await recorder.finish(0)).map((request) => request.id));

    const clickedAt = await page.evaluate((target) => {
      const anchor = Array.from(document.querySelectorAll('a[href]')).find(
        (candidate) => /** @type {HTMLAnchorElement} */ (candidate).href === target,
      );
      if (!anchor) return null;
      const at = performance.timeOrigin + performance.now();
      /** @type {HTMLAnchorElement} */ (anchor).click();
      return at;
    }, to);
    if (clickedAt === null) return { ...failed, error: `No link to ${to} on ${from}` };

    await new Promise((resolve) => setTimeout(resolve, ROUTER_START_MS));
    const settleTimeout = Math.min(MAX_SETTLE_MS, settings.timeoutMs);
    await recorder.waitForIdle({ idleMs: NETWORK_IDLE_MS, timeoutMs: settleTimeout });
    await waitForDomQuiet(page, settleTimeout);

    const lastMutationEpoch = await page
      .evaluate(() => {
        const last = window.__launchscopeLastMutation?.() ?? 0;
        return last > 0 ? performance.timeOrigin + last : 0;
      })
      .catch(() => 0);
    const urlAfter = page.url();
    const all = await recorder.finish(0);

    // One constant shift moves every request onto the click's timeline, preserving exact gaps.
    const originWallMs = recorder.originWallMs;
    const shift = originWallMs === null ? 0 : originWallMs - clickedAt;
    const requests = all
      .filter((request) => !before.has(request.id))
      .map((request) => ({
        ...request,
        startMs: round(request.startMs + shift),
        endMs: round(request.endMs + shift),
        responseStartMs:
          request.responseStartMs === null ? null : round(request.responseStartMs + shift),
      }))
      .filter((request) => request.startMs >= -5);

    const isFull = requests.some(
      (request) => request.resourceType === 'Document' && request.isMainFrame,
    );
    const networkMs = Math.max(
      0,
      ...requests
        .filter((request) => !request.streaming && !request.pending)
        .map((request) => request.endMs),
    );
    const renderMs = lastMutationEpoch > clickedAt ? round(lastMutationEpoch - clickedAt) : 0;
    return {
      from,
      to,
      kind: isFull ? 'full' : 'soft',
      error: null,
      durationMs: round(Math.max(networkMs, renderMs)),
      networkMs: round(networkMs),
      renderMs,
      urlAfter,
      requests,
    };
  } catch (error) {
    return { ...failed, error: firstLine(error) };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 */
async function waitForDomQuiet(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const quietFor = await page
      .evaluate(() => performance.now() - (window.__launchscopeLastMutation?.() ?? 0))
      .catch(() => Infinity);
    if (quietFor >= DOM_QUIET_MS) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** @param {unknown} error */
function firstLine(error) {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
