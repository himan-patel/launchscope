import { Command, CommanderError } from 'commander';
import { registerDoctor } from './commands/doctor.js';
import { registerLogin } from './commands/login.js';
import { BRAND } from './core/brand.js';
import { ExitCode, LaunchScopeError } from './core/errors.js';
import { createLogger, createPalette, formatBanner, shouldUseColor } from './core/logger.js';
import { CHECK_MODULES } from './modules/registry.js';
import { createRuntime } from './runtime.js';

/** @typedef {import('./runtime.js').CliIO} CliIO */

const STATUS_LABELS = /** @type {const} */ ({
  available: 'available',
  'in-progress': 'in progress',
  planned: 'planned',
});

/**
 * Builds the command tree. Commander's own output is routed through `io` and its process
 * exits are disabled, so `run` decides every exit code.
 *
 * @param {CliIO} io
 * @returns {Command}
 */
export function createProgram(io) {
  const program = new Command();
  const helpPalette = createPalette(shouldUseColor(io.stdout, io.env));

  program
    .name(BRAND.command)
    .description('Check a web app before you ship it. Performance first, with more checks coming.')
    .version(BRAND.version, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .option('-c, --config <path>', 'config file (default: launchscope.config.json)')
    .option('-o, --output-dir <dir>', 'report directory (default: launchscope-reports)')
    .option('--no-color', 'disable colored output')
    .option('-q, --quiet', 'only print errors')
    .option('--verbose', 'print debug details')
    .addHelpText('beforeAll', formatBanner(helpPalette))
    .addHelpText(
      'afterAll',
      `\nRun "${BRAND.command} modules" to see available and planned checks.\nDocs: ${BRAND.repositoryUrl}`,
    )
    .showHelpAfterError(`(run "${BRAND.command} --help" for usage)`)
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
    })
    .exitOverride();

  /** @type {import('./modules/registry.js').ModuleServices} */
  const services = {
    resolveRuntime: (command) => createRuntime(command.optsWithGlobals(), io),
  };

  program
    .command('modules')
    .description('list available and planned check modules')
    .option('--json', 'print as JSON to stdout')
    .action(async (/** @type {{ json?: boolean }} */ options, command) => {
      const runtime = await services.resolveRuntime(command);
      if (options.json) {
        const payload = CHECK_MODULES.map(({ id, title, status, summary }) => ({
          id,
          title,
          status,
          summary,
        }));
        io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      writeModuleTable(runtime.logger);
    });

  registerLogin(program, services);
  registerDoctor(program, services);

  for (const checkModule of CHECK_MODULES) {
    checkModule.register?.(program, services);
  }

  return program;
}

/**
 * Parses arguments and runs the matching command.
 *
 * @param {string[]} argv Full argv, including the node binary and script path.
 * @param {CliIO} io
 * @returns {Promise<number>} Process exit code.
 */
export async function run(argv, io) {
  const program = createProgram(io);
  try {
    await program.parseAsync(argv);
    return ExitCode.OK;
  } catch (error) {
    return handleError(error, io, {
      verbose: argv.includes('--verbose'),
      color: !argv.includes('--no-color') && shouldUseColor(io.stderr, io.env),
    });
  }
}

/**
 * Errors can be thrown before options are parsed, so flags are read from raw argv here.
 *
 * @param {unknown} error
 * @param {CliIO} io
 * @param {{ verbose: boolean, color: boolean }} flags
 * @returns {number}
 */
function handleError(error, io, { verbose, color }) {
  // Commander has already printed its own message (or the help/version text).
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
  }

  const logger = createLogger({ stream: io.stderr, color });

  if (error instanceof LaunchScopeError) {
    logger.error(error.message);
    if (error.hint) logger.info(`  ${logger.paint.dim(error.hint)}`);
    if (verbose && error.cause instanceof Error && error.cause.stack) {
      logger.info(logger.paint.dim(error.cause.stack));
    }
    return error.exitCode;
  }

  logger.error('Unexpected internal error.');
  if (verbose && error instanceof Error && error.stack) {
    logger.info(logger.paint.dim(error.stack));
  } else {
    logger.info(
      logger.paint.dim(`  Re-run with --verbose for details, and report it at ${BRAND.issuesUrl}`),
    );
  }
  return ExitCode.INTERNAL;
}

/**
 * @param {import('./core/logger.js').Logger} logger
 */
function writeModuleTable(logger) {
  const { paint } = logger;
  const idWidth = Math.max(...CHECK_MODULES.map((checkModule) => checkModule.id.length));
  const statusWidth = Math.max(...Object.values(STATUS_LABELS).map((label) => label.length));

  logger.info(paint.bold(`${BRAND.name} check modules\n`));
  for (const { id, status, summary } of CHECK_MODULES) {
    const label = STATUS_LABELS[status].padEnd(statusWidth);
    const coloredLabel =
      status === 'available'
        ? paint.green(label)
        : status === 'in-progress'
          ? paint.yellow(label)
          : paint.dim(label);
    logger.info(`  ${paint.cyan(id.padEnd(idWidth))}  ${coloredLabel}  ${summary}`);
  }
}
