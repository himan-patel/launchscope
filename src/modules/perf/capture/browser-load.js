import { installVitalsObserver } from './vitals.js';

/**
 * Captures a page load in Firefox or WebKit, where the Chrome DevTools Protocol is not
 * available. Requests come from Playwright's request events and `request.timing()`/`sizes()`,
 * which cover status, timing, and size but not initiators or redirect detail, so cross-browser
 * runs are compared on page-level metrics rather than traced hop by hop. Network throttling and
 * CPU slowdown are Chromium-only and do not apply here.
 */

const NETWORK_IDLE_MS = 500;
const MAX_SETTLE_MS = 10_000;
const MAX_MESSAGES = 20;

const RESOURCE_TYPES = /** @type {Record<string, string>} */ ({
  document: 'Document',
  stylesheet: 'Stylesheet',
  script: 'Script',
  image: 'Image',
  font: 'Font',
  media: 'Media',
  fetch: 'Fetch',
  xhr: 'XHR',
  eventsource: 'EventSource',
  websocket: 'WebSocket',
  manifest: 'Manifest',
});

/**
 * @param {object} options
 * @param {import('playwright').BrowserContext} options.context
 * @param {string} options.url
 * @param {import('../settings.js').PerfSettings} options.settings
 * @param {number} options.run
 * @returns {Promise<import('./page-capture.js').PageLoad>}
 */
export async function captureBrowserLoad({ context, url, settings, run }) {
  const page = await context.newPage();
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const pageErrors = [];
  /** @type {Map<import('playwright').Request, { failed: string | null }>} */
  const requests = new Map();
  let inflight = 0;
  let lastActivity = Date.now();

  page.on('console', (message) => {
    if (message.type() === 'error' && consoleErrors.length < MAX_MESSAGES)
      consoleErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => {
    if (pageErrors.length < MAX_MESSAGES) pageErrors.push(error.message.slice(0, 300));
  });
  page.on('request', (request) => {
    requests.set(request, { failed: null });
    inflight += 1;
    lastActivity = Date.now();
  });
  const settle = (
    /** @type {import('playwright').Request} */ request,
    /** @type {string | null} */ failed,
  ) => {
    const entry = requests.get(request);
    if (entry) entry.failed = failed;
    inflight = Math.max(0, inflight - 1);
    lastActivity = Date.now();
  };
  page.on('requestfinished', (request) => settle(request, null));
  page.on('requestfailed', (request) => settle(request, request.failure()?.errorText ?? 'failed'));

  try {
    await page.addInitScript(installVitalsObserver);
    const startedAt = new Date();
    const wallStart = performance.now();
    /** @type {string | null} */
    let error = null;
    /** @type {import('playwright').Response | null} */
    let response = null;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: settings.timeoutMs });
    } catch (navigationError) {
      error =
        navigationError instanceof Error
          ? navigationError.message.split('\n')[0].slice(0, 300)
          : 'failed';
    }

    const deadline = Date.now() + Math.min(MAX_SETTLE_MS, settings.timeoutMs);
    let networkIdle = false;
    while (Date.now() < deadline) {
      if (inflight === 0 && Date.now() - lastActivity >= NETWORK_IDLE_MS) {
        networkIdle = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const wallTimeMs = Math.round(performance.now() - wallStart);
    const vitals = error
      ? null
      : await page.evaluate(() => window.__launchscopeVitals()).catch(() => null);
    const title = error ? null : await page.title().catch(() => null);

    const entries = [...requests];
    const origin = Math.min(
      ...entries.map(([request]) => request.timing().startTime).filter((time) => time > 0),
    );
    const records = await Promise.all(
      entries.map(async ([request, { failed }]) => {
        const timing = request.timing();
        const sizes = await request.sizes().catch(() => null);
        const response = await request.response().catch(() => null);
        const startMs = round(timing.startTime - origin);
        const durationMs = timing.responseEnd >= 0 ? round(timing.responseEnd) : 0;
        return /** @type {import('./network-recorder.js').RequestRecord} */ ({
          id: `${run}-${request.url()}-${timing.startTime}`,
          url: request.url(),
          method: request.method(),
          resourceType: RESOURCE_TYPES[request.resourceType()] ?? 'Other',
          isNavigation: request.isNavigationRequest() && request.frame() === page.mainFrame(),
          initiator: { type: 'other', url: null, stackUrls: [], requestId: null },
          startMs,
          endMs: round(startMs + durationMs),
          durationMs,
          responseStartMs: timing.responseStart >= 0 ? round(startMs + timing.responseStart) : null,
          phases: null,
          status: response?.status() ?? null,
          mimeType: null,
          protocol: null,
          fromCache: false,
          fromServiceWorker: false,
          connectionReused: false,
          transferBytes: sizes ? sizes.responseBodySize + sizes.responseHeadersSize : 0,
          bodyBytes: sizes?.responseBodySize ?? 0,
          headers: {},
          redirects: [],
          failure: failed ? { errorText: failed, canceled: false } : null,
          pending: false,
          jsonShape: null,
          graphql: null,
          causedBy: null,
          frameId: null,
          isMainFrame: request.frame() === page.mainFrame(),
          streaming: request.resourceType() === 'eventsource',
        });
      }),
    );

    return {
      url,
      finalUrl: response?.url() ?? null,
      cache: 'cold',
      run,
      status: response?.status() ?? null,
      title,
      startedAt: startedAt.toISOString(),
      wallTimeMs,
      networkIdle,
      vitals,
      requests: records.sort((a, b) => a.startMs - b.startMs),
      consoleErrors,
      pageErrors,
      links: [],
      sockets: [],
      error,
      traceId: null,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
