import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseDuration } from '../core/duration.js';
import { LaunchScopeError, UsageError } from '../core/errors.js';
import { parseTarget } from '../core/target.js';

const DEFAULT_SAVE_PATH = '.auth/session.json';
const DEFAULT_WAIT = '5m';

/**
 * Registers `launchscope login <url>`: opens a real browser window, lets the user sign in by
 * hand (including SSO and MFA), and saves the session as a Playwright storage-state file that
 * any module can reuse with `--storage-state`.
 *
 * @param {import('commander').Command} program
 * @param {import('../modules/registry.js').ModuleServices} services
 */
export function registerLogin(program, services) {
  program
    .command('login')
    .description('sign in once in a browser window and save the session for authenticated checks')
    .argument('<url>', 'page to open, e.g. https://staging.example.com/login')
    .option('-s, --save <file>', `where to save the session (default: ${DEFAULT_SAVE_PATH})`)
    .option('--browser-channel <name>', 'use an installed browser, e.g. chrome or msedge')
    .option('--wait <duration>', `how long to wait for you to finish (default: ${DEFAULT_WAIT})`)
    .action(
      async (
        /** @type {string} */ url,
        /** @type {{ save?: string, browserChannel?: string, wait?: string }} */ options,
        command,
      ) => {
        const runtime = await services.resolveRuntime(command);
        const { url: target } = parseTarget(url);
        const savePath = resolve(runtime.io.cwd, options.save ?? DEFAULT_SAVE_PATH);
        const waitMs = parseDuration(options.wait ?? DEFAULT_WAIT, '--wait');
        const { logger } = runtime;

        const playwright = await import('playwright');
        const browser = await playwright.chromium
          .launch({ headless: false, channel: options.browserChannel })
          .catch((error) => {
            throw new LaunchScopeError('Could not open a browser window to sign in.', {
              hint: 'Run "npx playwright install chromium", or pass --browser-channel chrome.',
              cause: error,
            });
          });
        try {
          logger.info(`Opening ${logger.paint.cyan(target.href)} in a browser window…`);
          logger.info('Sign in there, then come back here and press Enter to save the session.');
          await saveSession({
            browser,
            url: target.href,
            savePath,
            waitForUser: () => waitForEnterOrTimeout(waitMs),
          });
        } finally {
          await browser.close().catch(() => {});
        }
        logger.success(`Session saved to ${savePath}`);
        logger.warn(
          'This file contains live session cookies. Keep it private and out of version control.',
        );
        logger.info(
          logger.paint.dim(
            `Use it with: launchscope perf ${target.origin} --storage-state ${savePath}`,
          ),
        );
      },
    );
}

/**
 * Opens `url`, waits for the user (or a test) to finish signing in, and writes the browser
 * session to `savePath` with owner-only permissions.
 *
 * @param {object} options
 * @param {import('playwright').Browser} options.browser
 * @param {string} options.url
 * @param {string} options.savePath
 * @param {(page: import('playwright').Page) => Promise<void>} options.waitForUser
 * @returns {Promise<{ cookies: number, origins: number }>}
 */
export async function saveSession({ browser, url, savePath, waitForUser }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url);
    await waitForUser(page);
    const state = await context.storageState();
    await mkdir(dirname(savePath), { recursive: true, mode: 0o700 });
    await writeFile(savePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(savePath, 0o600);
    return { cookies: state.cookies.length, origins: state.origins.length };
  } finally {
    await context.close();
  }
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForEnterOrTimeout(timeoutMs) {
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new UsageError('launchscope login needs an interactive terminal to wait for you.'),
    );
  }
  return new Promise((resolvePromise, reject) => {
    const reader = createInterface({ input: process.stdin });
    const timer = setTimeout(() => {
      reader.close();
      reject(new UsageError('Timed out waiting for sign-in.', { hint: 'Increase --wait.' }));
    }, timeoutMs);
    reader.once('line', () => {
      clearTimeout(timer);
      reader.close();
      resolvePromise();
    });
  });
}
