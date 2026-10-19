import { loadConfig } from './core/config.js';
import { UsageError } from './core/errors.js';
import { createLogger, shouldUseColor } from './core/logger.js';
import { DEFAULT_OUTPUT_DIR } from './core/report-dir.js';

/**
 * Process-level dependencies, injected so the CLI can be exercised in tests without
 * touching the real process streams or environment.
 *
 * @typedef {object} CliIO
 * @property {NodeJS.WritableStream & { isTTY?: boolean }} stdout Machine-readable output.
 * @property {NodeJS.WritableStream & { isTTY?: boolean }} stderr Human-readable progress and errors.
 * @property {Record<string, string | undefined>} env
 * @property {string} cwd
 */

/**
 * @typedef {object} GlobalOptions
 * @property {string} [config]
 * @property {string} [outputDir]
 * @property {boolean} color False when `--no-color` was passed.
 * @property {boolean} [quiet]
 * @property {boolean} [verbose]
 */

/**
 * Everything a command needs at execution time.
 *
 * @typedef {object} Runtime
 * @property {CliIO} io
 * @property {import('./core/logger.js').Logger} logger
 * @property {import('./core/config.js').LoadedConfig} config
 * @property {string} outputDir Base directory for run reports, relative to `io.cwd` or absolute.
 */

/**
 * @param {GlobalOptions} options
 * @param {CliIO} io
 * @returns {import('./core/logger.js').Logger}
 */
export function createLoggerFromOptions(options, io) {
  if (options.quiet && options.verbose) {
    throw new UsageError('--quiet and --verbose cannot be used together.');
  }
  return createLogger({
    stream: io.stderr,
    level: options.quiet ? 'quiet' : options.verbose ? 'verbose' : 'normal',
    color: options.color !== false && shouldUseColor(io.stderr, io.env),
  });
}

/**
 * Resolves global options and config into a runtime. Precedence: CLI flag > config file > default.
 *
 * @param {GlobalOptions} options
 * @param {CliIO} io
 * @returns {Promise<Runtime>}
 */
export async function createRuntime(options, io) {
  const logger = createLoggerFromOptions(options, io);
  const config = await loadConfig({ cwd: io.cwd, env: io.env, explicitPath: options.config });
  if (config.path) logger.debug(`Loaded config from ${config.path}`);

  const configOutputDir =
    typeof config.values.outputDir === 'string' ? config.values.outputDir : undefined;

  return {
    io,
    logger,
    config,
    outputDir: options.outputDir ?? configOutputDir ?? DEFAULT_OUTPUT_DIR,
  };
}
