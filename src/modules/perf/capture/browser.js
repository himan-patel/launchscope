import { access } from 'node:fs/promises';
import { ExitCode, LaunchScopeError, UsageError } from '../../../core/errors.js';
import { traceparentFor } from './trace-context.js';

/**
 * Network presets, modeled on common lab profiles:
 * - `4g`: "slow 4G" as used by Lighthouse mobile (150 ms RTT, 1.6 Mbps down, 750 Kbps up).
 * - `3g`: Chrome DevTools "Fast 3G" (562.5 ms RTT, 1.44 Mbps down, 675 Kbps up, ×0.9 overhead).
 */
export const THROTTLE_PRESETS = Object.freeze({
  '4g': {
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  },
  '3g': {
    latency: 562.5,
    downloadThroughput: ((1.44 * 1024 * 1024) / 8) * 0.9,
    uploadThroughput: ((675 * 1024) / 8) * 0.9,
  },
});

/** CPU slowdown applied with the mobile profile, matching Lighthouse's mobile default. */
export const MOBILE_CPU_SLOWDOWN = 4;

const DESKTOP_VIEWPORT = Object.freeze({ width: 1366, height: 768 });
const MOBILE_DEVICE = 'Pixel 7';

/**
 * @typedef {import('playwright').Browser} Browser
 * @typedef {import('playwright').BrowserContext} BrowserContext
 */

/** @typedef {'chromium' | 'firefox' | 'webkit'} BrowserName */

/**
 * Launches a browser with actionable errors: Chromium (or an installed Chrome/Edge channel) for
 * the primary, fully detailed measurement, or Firefox/WebKit for cross-browser comparison.
 *
 * @param {import('../settings.js').PerfSettings} settings
 * @param {BrowserName} [browserName]
 * @returns {Promise<{ browser: Browser, devices: typeof import('playwright').devices }>}
 */
export async function launchBrowser(settings, browserName = 'chromium') {
  const playwright = await import('playwright');
  const isChromium = browserName === 'chromium';
  try {
    const browser = await playwright[browserName].launch({
      headless: !settings.headed,
      channel: isChromium ? settings.browserChannel : undefined,
      // LaunchScope handles signals itself so an interrupted run can still write its report.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    return { browser, devices: playwright.devices };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /Executable doesn't exist|browserType\.launch: .*not found|is not found at/i.test(message)
    ) {
      throw new LaunchScopeError(
        isChromium
          ? 'No browser is installed for LaunchScope to drive.'
          : `${browserName === 'firefox' ? 'Firefox' : 'WebKit'} is not installed for LaunchScope to drive.`,
        {
          exitCode: ExitCode.USAGE,
          hint: !isChromium
            ? `Run "npx playwright install ${browserName}".`
            : settings.browserChannel
              ? `Install ${settings.browserChannel}, or run "npx playwright install chromium" and drop --browser-channel.`
              : 'Run "npx playwright install chromium", or use an installed browser with --browser-channel chrome.',
          cause: error,
        },
      );
    }
    throw new LaunchScopeError(`Could not launch the browser: ${message.split('\n')[0]}`, {
      cause: error,
    });
  }
}

/**
 * Creates an isolated browser context (fresh cache and cookies) for one measured run.
 *
 * Extra headers are attached only to requests on the target origin, so tokens are never sent
 * to third parties such as CDNs, analytics, or ad networks. Service workers are blocked so
 * every request is visible to the recorder.
 *
 * @param {Browser} browser
 * @param {typeof import('playwright').devices} devices
 * @param {import('../settings.js').PerfSettings} settings
 * @param {{ harPath?: string, traces?: import('./trace-context.js').TraceRegistry, browserName?: BrowserName }} [options]
 *   `harPath` records a HAR (bodies omitted) written on context close; `traces` adds a
 *   `traceparent` header to target-origin requests.
 * @returns {Promise<BrowserContext>}
 */
export async function createMeasurementContext(
  browser,
  devices,
  settings,
  { harPath, traces, browserName = 'chromium' } = {},
) {
  if (settings.storageStatePath) await assertReadable(settings.storageStatePath);

  const device = settings.device === 'mobile' ? mobileProfile(devices, browserName) : undefined;
  const context = await browser.newContext({
    ...(device ?? { viewport: DESKTOP_VIEWPORT }),
    storageState: settings.storageStatePath,
    serviceWorkers: 'block',
    ...(harPath ? { recordHar: { path: harPath, content: /** @type {const} */ ('omit') } } : {}),
  });

  const headerEntries = Object.entries(settings.headers);
  if (headerEntries.length > 0 || traces) {
    const targetOrigin = settings.targetUrl.origin;
    await context.route(
      (url) => url.origin === targetOrigin,
      (route) => {
        const request = route.request();
        /** @type {Record<string, string>} */
        const headers = { ...request.headers(), ...Object.fromEntries(headerEntries) };
        const traceId = traces?.traceIdFor(safePage(request));
        if (traceId) headers.traceparent = traceparentFor(traceId);
        return route.continue({ headers });
      },
    );
  }
  return context;
}

/**
 * The mobile device profile for a browser. Firefox cannot emulate mobile/touch, so it gets the
 * same screen size and user agent without those flags.
 *
 * @param {typeof import('playwright').devices} devices
 * @param {BrowserName} browserName
 */
function mobileProfile(devices, browserName) {
  const { defaultBrowserType: _defaultBrowserType, ...profile } = devices[MOBILE_DEVICE];
  if (browserName !== 'firefox') return profile;
  const { isMobile: _isMobile, hasTouch: _hasTouch, ...firefoxProfile } = profile;
  return firefoxProfile;
}

/**
 * @param {import('playwright').Request} request
 * @returns {import('playwright').Page | null}
 */
function safePage(request) {
  try {
    return request.frame().page();
  } catch {
    // Service worker and some preflight requests have no frame.
    return null;
  }
}

/**
 * @param {string} path
 */
async function assertReadable(path) {
  try {
    await access(path);
  } catch (error) {
    throw new UsageError(`Storage state file ${path} does not exist or is not readable.`, {
      hint: 'Create one with "launchscope login <url> --save <file>".',
      cause: error,
    });
  }
}
