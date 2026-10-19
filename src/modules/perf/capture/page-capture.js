import { MOBILE_CPU_SLOWDOWN, THROTTLE_PRESETS } from './browser.js';
import { NetworkRecorder } from './network-recorder.js';
import { applyObservedCauses } from './causality.js';
import { measureInteractive } from './interactive.js';
import { installRequestTracker } from './request-tracker.js';
import { installVitalsObserver } from './vitals.js';

const NETWORK_IDLE_MS = 500;
const MAX_SETTLE_MS = 10_000;
const MAX_CONSOLE_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 300;
const MAX_LINKS = 500;
// Time to Interactive needs a 5 s quiet window to be observed; this caps the extra wait.
const MAX_INTERACTIVE_WAIT_MS = 20_000;
const INTERACTIVE_POLL_MS = 250;

/**
 * @typedef {object} PageLoad
 * @property {string} url Requested URL.
 * @property {string | null} finalUrl URL after redirects.
 * @property {'cold' | 'warm'} cache
 * @property {number} run 1-based run number within its cache mode.
 * @property {number | null} status Main document status.
 * @property {string | null} title
 * @property {string} startedAt ISO timestamp.
 * @property {number} wallTimeMs Navigation start to capture end, as measured by LaunchScope.
 * @property {boolean} networkIdle Whether the network went quiet before the settle timeout.
 * @property {import('./vitals.js').PageVitals | null} vitals
 * @property {import('./network-recorder.js').RequestRecord[]} requests
 * @property {string[]} consoleErrors
 * @property {string[]} pageErrors Uncaught exceptions.
 * @property {string[]} links Absolute link targets found on the page (when requested).
 * @property {import("./network-recorder.js").SocketRecord[]} sockets WebSocket connections opened during the load.
 * @property {string | null} error Navigation error, if the page failed to load.
 * @property {Map<string, import('./network-recorder.js').ReplayBody>} [replayBodies] Non-enumerable;
 *   bodies of allowlisted requests for stress replay, never serialized.
 * @property {string | null} traceId W3C trace ID sent with this load's requests (with --trace-context).
 */

/**
 * Loads one URL in a fresh page and records everything about the load.
 *
 * @param {object} options
 * @param {import('playwright').BrowserContext} options.context
 * @param {string} options.url
 * @param {import('../settings.js').PerfSettings} options.settings
 * @param {'cold' | 'warm'} options.cache
 * @param {number} options.run
 * @param {boolean} [options.collectLinks]
 * @param {boolean} [options.inspectJson] Summarize JSON response shapes (bodies are not kept).
 * @param {boolean} [options.screenshot]
 * @param {import('./trace-context.js').TraceRegistry} [options.traces] Start a trace for this load.
 * @param {(record: { url: string, method: string }) => boolean} [options.captureBody] Keep these
 *   requests' bodies in memory (as the non-enumerable `replayBodies` on the load) for stress replay.
 * @returns {Promise<{ load: PageLoad, screenshot: Buffer | null }>}
 */
export async function capturePageLoad({
  context,
  url,
  settings,
  cache,
  run,
  collectLinks = false,
  inspectJson = false,
  screenshot = false,
  traces,
  captureBody,
}) {
  const page = await context.newPage();
  const traceId = traces ? traces.startTrace(page) : null;
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && consoleErrors.length < MAX_CONSOLE_MESSAGES) {
      consoleErrors.push(truncate(message.text()));
    }
  });
  page.on('pageerror', (error) => {
    if (pageErrors.length < MAX_CONSOLE_MESSAGES) pageErrors.push(truncate(error.message));
  });

  try {
    const { recorder } = await startRecording({
      context,
      page,
      settings,
      cache,
      inspectJson,
      captureBody,
    });

    const startedAt = new Date();
    const wallStart = performance.now();
    /** @type {string | null} */
    let error = null;
    /** @type {import('playwright').Response | null} */
    let response = null;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: settings.timeoutMs });
    } catch (navigationError) {
      error = truncate(
        navigationError instanceof Error ? navigationError.message.split('\n')[0] : 'failed',
      );
    }

    const networkIdle = await recorder.waitForIdle({
      idleMs: NETWORK_IDLE_MS,
      timeoutMs: Math.min(MAX_SETTLE_MS, settings.timeoutMs),
    });
    const wallTimeMs = Math.round(performance.now() - wallStart);

    const interactive = error
      ? null
      : await waitForInteractive(
          page,
          recorder,
          Math.min(MAX_INTERACTIVE_WAIT_MS, settings.timeoutMs),
        );
    const pageVitals = error ? null : await safeEvaluate(page, () => window.__launchscopeVitals());
    const vitals =
      pageVitals && interactive
        ? {
            ...pageVitals,
            tbtMs: interactive.tbtMs,
            ttiMs: interactive.ttiMs,
            tbtComplete: interactive.complete,
          }
        : pageVitals;
    const links = collectLinks && !error ? await readLinks(page) : [];
    const title = error ? null : await page.title().catch(() => null);
    const image =
      screenshot && !error ? await page.screenshot({ type: 'png' }).catch(() => null) : null;

    // Requests still in flight are closed at the capture end (navigation start ≈ time origin).
    const captureEndMs = Math.round(performance.now() - wallStart);
    const requests = await recorder.finish(captureEndMs);
    applyObservedCauses(requests, (await readTrackedCalls(page)) ?? []);
    const sockets = recorder.sockets(captureEndMs);

    /** @type {PageLoad} */
    const load = {
      url,
      finalUrl: response?.url() ?? null,
      cache,
      run,
      status: response?.status() ?? null,
      title,
      startedAt: startedAt.toISOString(),
      wallTimeMs,
      networkIdle,
      vitals,
      requests,
      consoleErrors,
      pageErrors,
      links,
      sockets,
      error,
      traceId,
    };
    // Replay bodies stay off the serialized load: JSON.stringify skips non-enumerable properties.
    Object.defineProperty(load, 'replayBodies', {
      value: recorder.replayBodies(),
      enumerable: false,
    });
    return { load, screenshot: image };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Prepares a page for measurement: the in-page vitals observer, a CDP network recorder, and the
 * cache, network throttling, and CPU slowdown settings of the run.
 *
 * @param {object} options
 * @param {import('playwright').BrowserContext} options.context
 * @param {import('playwright').Page} options.page
 * @param {import('../settings.js').PerfSettings} options.settings
 * @param {'cold' | 'warm'} options.cache
 * @param {boolean} [options.inspectJson]
 * @param {(record: { url: string, method: string }) => boolean} [options.captureBody]
 * @returns {Promise<{ recorder: NetworkRecorder }>}
 */
export async function startRecording({
  context,
  page,
  settings,
  cache,
  inspectJson = false,
  captureBody,
}) {
  await page.addInitScript(installVitalsObserver);
  await page.addInitScript(installRequestTracker);
  const session = await context.newCDPSession(page);
  const recorder = new NetworkRecorder(session, { inspectJson, captureBody });
  await session.send('Network.enable', { maxPostDataSize: 0 });
  if (cache === 'cold') await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (settings.throttle !== 'none') {
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      ...THROTTLE_PRESETS[settings.throttle],
    });
  }
  if (settings.device === 'mobile') {
    await session.send('Emulation.setCPUThrottlingRate', { rate: MOBILE_CPU_SLOWDOWN });
  }
  return { recorder };
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<import('./causality.js').TrackedCall[] | null>}
 */
export function readTrackedCalls(page) {
  return safeEvaluate(page, () => window.__launchscopeRequests?.() ?? []);
}

/**
 * Keeps observing the page until Time to Interactive can be determined (a 5 s CPU and network
 * quiet window after FCP has actually happened), or until `maxWaitMs`. Long tasks come from the
 * page; network activity comes from the recorder, shifted onto the page's clock using the
 * wall-clock time of the first request and the page's `performance.timeOrigin`.
 *
 * @param {import('playwright').Page} page
 * @param {NetworkRecorder} recorder
 * @param {number} maxWaitMs
 * @returns {Promise<import('./interactive.js').InteractiveResult | null>} Null when the browser
 *   has no Long Tasks API or the page never painted.
 */
export async function waitForInteractive(page, recorder, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const observed = await safeEvaluate(page, () => window.__launchscopeInteractivity?.() ?? null);
    if (!observed?.longTasksSupported) return null;
    const offset = recorder.originWallMs === null ? 0 : recorder.originWallMs - observed.timeOrigin;
    const requests = recorder.quietWindowRequests().map(({ startMs, endMs }) => ({
      startMs: startMs + offset,
      endMs: endMs === null ? null : endMs + offset,
    }));
    const final = Date.now() >= deadline;
    const result = measureInteractive({ ...observed, requests, final });
    if (!result || result.complete || final) return result;
    await new Promise((resolve) => setTimeout(resolve, INTERACTIVE_POLL_MS));
  }
}

/**
 * @template T
 * @param {import('playwright').Page} page
 * @param {() => T} fn
 * @returns {Promise<T | null>}
 */
async function safeEvaluate(page, fn) {
  try {
    return await page.evaluate(fn);
  } catch {
    return null;
  }
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}
 */
async function readLinks(page) {
  const hrefs = await safeEvaluate(page, () =>
    Array.from(
      document.querySelectorAll('a[href]'),
      (anchor) => /** @type {HTMLAnchorElement} */ (anchor).href,
    ),
  );
  return [...new Set(hrefs ?? [])].slice(0, MAX_LINKS);
}

/** @param {string} text */
function truncate(text) {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}
