import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { BRAND } from '../core/brand.js';
import { ExitCode, LaunchScopeError } from '../core/errors.js';

const require = createRequire(import.meta.url);
const BROWSER_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} Check
 * @property {string} name
 * @property {'ok' | 'warn' | 'fail'} status `fail` only for things LaunchScope cannot run without.
 * @property {string} detail
 * @property {string | null} fix How to resolve a warning or failure.
 */

/**
 * Registers `launchscope doctor`: verifies the environment by actually exercising it (launching
 * each browser, importing Lighthouse, writing to the output directory) rather than guessing from
 * file paths, so the answer is the same one a real run would get on this machine and OS.
 *
 * @param {import('commander').Command} program
 * @param {import('../modules/registry.js').ModuleServices} services
 */
export function registerDoctor(program, services) {
  program
    .command('doctor')
    .description('check Node.js, browsers, Lighthouse, and the output directory on this machine')
    .option('--json', 'print the checks as JSON to stdout')
    .action(async (/** @type {{ json?: boolean }} */ options, command) => {
      const runtime = await services.resolveRuntime(command);
      const checks = await runChecks({ outputDir: resolve(runtime.io.cwd, runtime.outputDir) });
      if (options.json) {
        runtime.io.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
      } else {
        const { paint } = runtime.logger;
        runtime.logger.info(
          paint.bold(`${BRAND.name} doctor`) + paint.dim(` · ${platform()} ${release()} ${arch()}`),
        );
        for (const check of checks) {
          const icon =
            check.status === 'ok'
              ? paint.green('✔')
              : check.status === 'warn'
                ? paint.yellow('!')
                : paint.red('✖');
          runtime.logger.info(`  ${icon} ${check.name.padEnd(18)} ${check.detail}`);
          if (check.fix) runtime.logger.info(paint.dim(`      ${check.fix}`));
        }
      }
      const failed = checks.filter((check) => check.status === 'fail');
      if (failed.length > 0) {
        throw new LaunchScopeError(`${failed.length} required check(s) failed.`, {
          exitCode: ExitCode.CHECK_FAILED,
        });
      }
    });
}

/**
 * @param {{ outputDir: string }} options
 * @returns {Promise<Check[]>}
 */
export async function runChecks({ outputDir }) {
  const manifest = require('../../package.json');
  /** @type {Check[]} */
  const checks = [checkNode(process.versions.node, manifest.engines.node, 'Node.js', true)];

  /** @type {typeof import('playwright') | null} */
  let playwright = null;
  try {
    playwright = await import('playwright');
    checks.push({
      name: 'Playwright',
      status: 'ok',
      detail: require('playwright/package.json').version,
      fix: null,
    });
  } catch (error) {
    checks.push({
      name: 'Playwright',
      status: 'fail',
      detail: `not loadable: ${firstLine(error)}`,
      fix: 'Reinstall dependencies with "npm ci".',
    });
  }

  for (const browser of /** @type {const} */ (['chromium', 'firefox', 'webkit'])) {
    const required = browser === 'chromium';
    if (!playwright) {
      checks.push({
        name: label(browser),
        status: required ? 'fail' : 'warn',
        detail: 'skipped (Playwright missing)',
        fix: null,
      });
      continue;
    }
    try {
      const instance = await playwright[browser].launch({ timeout: BROWSER_TIMEOUT_MS });
      const version = instance.version();
      await instance.close();
      checks.push({
        name: label(browser),
        status: 'ok',
        detail: `launches (${version})`,
        fix: null,
      });
    } catch (error) {
      checks.push({
        name: label(browser),
        status: required ? 'fail' : 'warn',
        detail: `does not launch: ${firstLine(error)}`,
        fix: required
          ? 'Run "npx playwright install chromium", or use --browser-channel chrome with an installed Chrome.'
          : `Needed only for --browsers: run "npx playwright install ${browser}".`,
      });
    }
  }

  try {
    await import('lighthouse');
    const lighthouseManifest = require('lighthouse/package.json');
    const engine = checkNode(
      process.versions.node,
      lighthouseManifest.engines?.node ?? '>=0.0.0',
      'Lighthouse',
      false,
    );
    checks.push({
      ...engine,
      detail:
        engine.status === 'ok'
          ? `${lighthouseManifest.version} (Node.js ${process.versions.node} supported)`
          : engine.detail,
    });
  } catch {
    checks.push({
      name: 'Lighthouse',
      status: 'warn',
      detail: 'not installed',
      fix: 'Needed only for --lighthouse: run "npm install lighthouse".',
    });
  }

  try {
    await mkdir(outputDir, { recursive: true });
    const probe = join(outputDir, `.launchscope-doctor-${process.pid}`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    checks.push({
      name: 'Output directory',
      status: 'ok',
      detail: `writable (${outputDir})`,
      fix: null,
    });
  } catch (error) {
    checks.push({
      name: 'Output directory',
      status: 'fail',
      detail: `not writable: ${firstLine(error)}`,
      fix: 'Pass a writable --output-dir.',
    });
  }
  return checks;
}

/**
 * Checks a version against a `>=x[.y[.z]]` range (the form used in `engines` fields).
 *
 * @param {string} version
 * @param {string} range
 * @param {string} name
 * @param {boolean} required
 * @returns {Check}
 */
export function checkNode(version, range, name, required) {
  const minimum = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (!minimum)
    return {
      name,
      status: 'warn',
      detail: `cannot interpret required range "${range}"`,
      fix: null,
    };
  const actual = version.split('.').map(Number);
  const wanted = minimum.slice(1).map((part) => Number(part ?? 0));
  let satisfied = true;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== wanted[index]) {
      satisfied = actual[index] > wanted[index];
      break;
    }
  }
  return satisfied
    ? { name, status: 'ok', detail: `${version} (requires ${range})`, fix: null }
    : {
        name,
        status: required ? 'fail' : 'warn',
        detail: `${version} does not satisfy ${range}`,
        fix: 'Switch Node.js versions: "nvm use" (macOS/Linux), "nvm use 22.23.3" (nvm-windows), or "fnm use" (any OS) in the project folder.',
      };
}

/** @param {'chromium' | 'firefox' | 'webkit'} browser */
function label(browser) {
  return browser === 'chromium' ? 'Chromium' : browser === 'firefox' ? 'Firefox' : 'WebKit';
}

/** @param {unknown} error */
function firstLine(error) {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 200);
}
