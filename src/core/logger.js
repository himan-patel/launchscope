import { BRAND } from './brand.js';

/**
 * Human-readable progress goes to stderr so stdout stays clean for machine output
 * (for example `--json`), which lets users pipe results safely.
 */

/** @typedef {'quiet' | 'normal' | 'verbose'} LogLevel */

/**
 * @typedef {object} Logger
 * @property {(message: string) => void} error
 * @property {(message: string) => void} warn
 * @property {(message: string) => void} info
 * @property {(message: string) => void} success
 * @property {(message: string) => void} debug
 * @property {() => void} banner
 * @property {Palette} paint
 */

/**
 * @typedef {object} Palette
 * @property {(text: string) => string} bold
 * @property {(text: string) => string} dim
 * @property {(text: string) => string} red
 * @property {(text: string) => string} yellow
 * @property {(text: string) => string} green
 * @property {(text: string) => string} cyan
 * @property {(text: string) => string} magenta
 */

const ANSI = /** @type {const} */ ({
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  magenta: [35, 39],
  cyan: [36, 39],
});

/**
 * Decides whether to emit ANSI colors, following the NO_COLOR and FORCE_COLOR conventions.
 *
 * @param {{ isTTY?: boolean }} stream
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function shouldUseColor(stream, env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

/**
 * @param {boolean} enabled
 * @returns {Palette}
 */
export function createPalette(enabled) {
  /** @param {keyof typeof ANSI} style */
  const make = (style) => {
    const [open, close] = ANSI[style];
    return enabled
      ? (/** @type {string} */ text) => `\u001b[${open}m${text}\u001b[${close}m`
      : (/** @type {string} */ text) => text;
  };
  return {
    bold: make('bold'),
    dim: make('dim'),
    red: make('red'),
    yellow: make('yellow'),
    green: make('green'),
    cyan: make('cyan'),
    magenta: make('magenta'),
  };
}

/**
 * @param {object} options
 * @param {{ write: (chunk: string) => unknown }} options.stream
 * @param {LogLevel} [options.level]
 * @param {boolean} [options.color]
 * @returns {Logger}
 */
export function createLogger({ stream, level = 'normal', color = false }) {
  const paint = createPalette(color);
  /** @param {string} line */
  const write = (line) => {
    stream.write(`${line}\n`);
  };
  const showInfo = level !== 'quiet';

  return {
    paint,
    error: (message) => write(`${paint.red('✖')} ${message}`),
    warn: (message) => {
      if (showInfo) write(`${paint.yellow('!')} ${message}`);
    },
    info: (message) => {
      if (showInfo) write(message);
    },
    success: (message) => {
      if (showInfo) write(`${paint.green('✔')} ${message}`);
    },
    debug: (message) => {
      if (level === 'verbose') write(paint.dim(`· ${message}`));
    },
    banner: () => {
      if (showInfo) write(formatBanner(paint));
    },
  };
}

/**
 * @param {Palette} paint
 * @returns {string}
 */
export function formatBanner(paint) {
  return [
    `${paint.magenta('▲')} ${paint.bold(BRAND.command)} ${paint.dim(`v${BRAND.version}`)}`,
    `  ${paint.dim(BRAND.tagline)}`,
    '',
  ].join('\n');
}
