import { resolve } from 'node:path';
import { parseDuration } from '../../core/duration.js';
import { UsageError } from '../../core/errors.js';
import { parseTarget } from '../../core/target.js';
import { resolveBudgets } from './analyze/budgets.js';

/**
 * @typedef {'none' | 'warning' | 'critical'} FailOnLevel
 * @typedef {'desktop' | 'mobile'} DeviceProfile
 * @typedef {'none' | '4g' | '3g'} ThrottleProfile
 */

/**
 * @typedef {object} StressSettings
 * @property {boolean} enabled
 * @property {number[]} stages Concurrent virtual users per stage, ascending.
 * @property {number} stageDurationMs
 * @property {number} requestTimeoutMs
 * @property {boolean} includeAssets Also replay same-origin scripts, styles, images, and fonts.
 * @property {boolean} allowRemote Permit targets that are not loopback or private addresses.
 * @property {number} maxErrorRate Abort the stress test once a stage exceeds this error ratio.
 */

/**
 * Fully resolved settings for one `launchscope perf` run.
 *
 * @typedef {object} PerfSettings
 * @property {URL} targetUrl
 * @property {import('../../core/target.js').HostScope} scope
 * @property {string[]} routes Explicit routes as absolute same-origin URLs.
 * @property {number} maxRoutes
 * @property {number} depth Link-crawl depth from the target (0 disables crawling).
 * @property {boolean} sitemap Read /sitemap.xml for additional routes.
 * @property {RegExp[]} exclude URL patterns never visited (logout links are always excluded).
 * @property {number} runs Cold-cache measurement runs per route.
 * @property {number} warmRuns Additional warm-cache runs per route.
 * @property {DeviceProfile} device
 * @property {ThrottleProfile} throttle
 * @property {number} timeoutMs Page load timeout.
 * @property {string | undefined} browserChannel Installed browser to use (e.g. `chrome`).
 * @property {boolean} headed
 * @property {string | undefined} storageStatePath Absolute path to a saved login session.
 * @property {Record<string, string>} headers Extra headers, sent to the target origin only.
 * @property {FailOnLevel} failOn
 * @property {boolean} json
 * @property {boolean} dryRun Resolve settings and create the run directory without a browser.
 * @property {import('./analyze/budgets.js').Budgets} budgets Thresholds for findings.
 * @property {string | undefined} baseline 'latest' or an absolute path to a previous run to compare with.
 * @property {{ enabled: boolean, urlTemplate: string | undefined }} traceContext W3C traceparent on target-origin requests.
 * @property {string | undefined} openapi 'auto', an http(s) URL, or an absolute path to an OpenAPI JSON document.
 * @property {string | undefined} repo Absolute path of an app repository to read routes from.
 * @property {Record<string, string>} routeParams Values for dynamic route segments, by parameter name.
 * @property {StressSettings} stress
 */

export const PERF_DEFAULTS = Object.freeze({
  maxRoutes: 10,
  depth: 1,
  sitemap: true,
  runs: 3,
  warmRuns: 0,
  device: /** @type {DeviceProfile} */ ('desktop'),
  throttle: /** @type {ThrottleProfile} */ ('none'),
  timeoutMs: 30_000,
  headed: false,
  failOn: /** @type {FailOnLevel} */ ('none'),
  stress: Object.freeze({
    stages: Object.freeze([1, 5, 10, 25, 50]),
    stageDurationMs: 10_000,
    requestTimeoutMs: 10_000,
    includeAssets: false,
    allowRemote: false,
    maxErrorRate: 0.5,
  }),
});

/** Routes matching this are never visited, so a crawl cannot end the user's session. */
export const ALWAYS_EXCLUDED = /(?:^|[/_.-])(?:log-?out|sign-?out|log-?off)(?:$|[/_.?#-])/i;

export const LIMITS = Object.freeze({
  maxRoutes: 500,
  depth: 5,
  runs: 50,
  warmRuns: 20,
  stressStages: 10,
  stressConcurrency: 1000,
});

const DEVICES = /** @type {const} */ (['desktop', 'mobile']);
const THROTTLES = /** @type {const} */ (['none', '4g', '3g']);
const FAIL_ON = /** @type {const} */ (['none', 'warning', 'critical']);
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
]);

const CONFIG_KEYS = new Set([
  'routes',
  'maxRoutes',
  'depth',
  'sitemap',
  'exclude',
  'runs',
  'warmRuns',
  'device',
  'throttle',
  'timeout',
  'browserChannel',
  'storageState',
  'headers',
  'failOn',
  'stress',
  'budgets',
  'baseline',
  'traceContext',
  'openapi',
  'repo',
  'routeParams',
]);
const STRESS_CONFIG_KEYS = new Set([
  'stages',
  'duration',
  'timeout',
  'includeAssets',
  'allowRemote',
  'maxErrorRate',
]);

/**
 * Raw option values as commander produces them. Anything not passed is undefined.
 *
 * @typedef {object} PerfCliOptions
 * @property {string} [routes]
 * @property {string} [maxRoutes]
 * @property {string} [depth]
 * @property {boolean} [sitemap] False when `--no-sitemap` was passed.
 * @property {string[]} [exclude]
 * @property {string} [runs]
 * @property {string} [warmRuns]
 * @property {string} [device]
 * @property {string} [throttle]
 * @property {string} [timeout]
 * @property {string} [browserChannel]
 * @property {boolean} [headed]
 * @property {string} [storageState]
 * @property {string[]} [header]
 * @property {string} [failOn]
 * @property {boolean} [json]
 * @property {boolean} [dryRun]
 * @property {string} [baseline]
 * @property {boolean} [traceContext]
 * @property {string} [traceUrl]
 * @property {string} [openapi]
 * @property {string} [repo]
 * @property {boolean} [stress]
 * @property {string} [stressStages]
 * @property {string} [stressDuration]
 * @property {string} [stressTimeout]
 * @property {boolean} [stressIncludeAssets]
 * @property {boolean} [allowRemote]
 */

/**
 * Merges CLI options, the `perf` config section, and defaults (in that order of precedence)
 * into validated settings. Every user-supplied value is checked here, at the trust boundary.
 *
 * @param {object} input
 * @param {string} input.target
 * @param {PerfCliOptions} input.cli
 * @param {unknown} input.config The `perf` section of launchscope.config.json, if any.
 * @param {string} input.cwd
 * @returns {PerfSettings}
 */
export function resolvePerfSettings({ target, cli, config, cwd }) {
  const section = readSection(config, 'perf', CONFIG_KEYS);
  const stressSection = readSection(section.stress, 'perf.stress', STRESS_CONFIG_KEYS);
  const { url: targetUrl, scope } = parseTarget(target);

  const routes = parseRoutes(cli.routes ?? section.routes, targetUrl);
  const storageState = cli.storageState ?? optionalString(section.storageState, 'storageState');

  return {
    targetUrl,
    scope,
    routes,
    maxRoutes: parseInteger(cli.maxRoutes ?? section.maxRoutes, '--max-routes', {
      min: 1,
      max: LIMITS.maxRoutes,
      fallback: Math.max(PERF_DEFAULTS.maxRoutes, routes.length),
    }),
    depth: parseInteger(cli.depth ?? section.depth, '--depth', {
      min: 0,
      max: LIMITS.depth,
      fallback: routes.length > 0 ? 0 : PERF_DEFAULTS.depth,
    }),
    sitemap: parseBoolean(cli.sitemap ?? section.sitemap, 'sitemap', routes.length === 0),
    exclude: parsePatterns(cli.exclude ?? section.exclude),
    runs: parseInteger(cli.runs ?? section.runs, '--runs', {
      min: 1,
      max: LIMITS.runs,
      fallback: PERF_DEFAULTS.runs,
    }),
    warmRuns: parseInteger(cli.warmRuns ?? section.warmRuns, '--warm-runs', {
      min: 0,
      max: LIMITS.warmRuns,
      fallback: PERF_DEFAULTS.warmRuns,
    }),
    device: parseChoice(cli.device ?? section.device, '--device', DEVICES, PERF_DEFAULTS.device),
    throttle: parseChoice(
      cli.throttle ?? section.throttle,
      '--throttle',
      THROTTLES,
      PERF_DEFAULTS.throttle,
    ),
    timeoutMs: parseOptionalDuration(
      cli.timeout ?? section.timeout,
      '--timeout',
      PERF_DEFAULTS.timeoutMs,
    ),
    browserChannel: cli.browserChannel ?? optionalString(section.browserChannel, 'browserChannel'),
    headed: cli.headed ?? PERF_DEFAULTS.headed,
    storageStatePath: storageState === undefined ? undefined : resolve(cwd, storageState),
    headers: parseHeaders(cli.header, section.headers),
    failOn: parseChoice(cli.failOn ?? section.failOn, '--fail-on', FAIL_ON, PERF_DEFAULTS.failOn),
    json: cli.json ?? false,
    dryRun: cli.dryRun ?? false,
    budgets: resolveBudgets(section.budgets),
    baseline: resolveBaseline(cli.baseline ?? section.baseline, cwd),
    traceContext: resolveTraceContext(cli, section.traceContext),
    openapi: resolveOpenApi(cli.openapi ?? section.openapi, cwd),
    repo: resolveRepo(cli.repo ?? section.repo, cwd),
    routeParams: parseRouteParams(section.routeParams),
    stress: {
      enabled: cli.stress ?? false,
      stages: parseStages(cli.stressStages ?? stressSection.stages),
      stageDurationMs: parseOptionalDuration(
        cli.stressDuration ?? stressSection.duration,
        '--stress-duration',
        PERF_DEFAULTS.stress.stageDurationMs,
      ),
      requestTimeoutMs: parseOptionalDuration(
        cli.stressTimeout ?? stressSection.timeout,
        '--stress-timeout',
        PERF_DEFAULTS.stress.requestTimeoutMs,
      ),
      includeAssets: parseBoolean(
        cli.stressIncludeAssets ?? stressSection.includeAssets,
        'stress.includeAssets',
        PERF_DEFAULTS.stress.includeAssets,
      ),
      allowRemote: parseBoolean(
        cli.allowRemote ?? stressSection.allowRemote,
        'stress.allowRemote',
        PERF_DEFAULTS.stress.allowRemote,
      ),
      maxErrorRate: parseRatio(stressSection.maxErrorRate, 'stress.maxErrorRate'),
    },
  };
}

/**
 * A copy of the settings that is safe to write into reports: header values are redacted.
 *
 * @param {PerfSettings} settings
 */
export function toReportableSettings(settings) {
  return {
    ...settings,
    targetUrl: settings.targetUrl.href,
    exclude: settings.exclude.map((pattern) => pattern.source),
    headers: Object.fromEntries(Object.keys(settings.headers).map((name) => [name, '[redacted]'])),
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {Set<string>} allowedKeys
 * @returns {{ [key: string]: unknown }}
 */
function readSection(value, label, allowedKeys) {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError(`Config "${label}" must be an object.`);
  }
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown key(s) in config "${label}": ${unknown.join(', ')}.`, {
      hint: `Allowed keys: ${[...allowedKeys].join(', ')}.`,
    });
  }
  return /** @type {{ [key: string]: unknown }} */ (value);
}

/**
 * @param {unknown} value
 * @param {URL} targetUrl
 * @returns {string[]}
 */
function parseRoutes(value, targetUrl) {
  if (value === undefined) return [];
  const items =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? value
        : null;
  if (!items) throw new UsageError('Routes must be a comma-separated string or an array of paths.');

  const routes = new Set();
  for (const item of items.map((route) => route.trim()).filter(Boolean)) {
    let url;
    try {
      url = new URL(item, targetUrl);
    } catch {
      throw new UsageError(`Route "${item}" is not a valid path or URL.`);
    }
    if (url.origin !== targetUrl.origin) {
      throw new UsageError(`Route "${item}" is not on the target origin ${targetUrl.origin}.`);
    }
    url.hash = '';
    routes.add(url.href);
  }
  return [...routes];
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{ min: number, max: number, fallback: number }} bounds
 * @returns {number}
 */
function parseInteger(value, label, { min, max, fallback }) {
  if (value === undefined) return fallback;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new UsageError(`${label} must be a whole number from ${min} to ${max} (got "${value}").`);
  }
  return number;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new UsageError(`Config "${label}" must be true or false.`);
  return value;
}

/**
 * @template {string} T
 * @param {unknown} value
 * @param {string} label
 * @param {readonly T[]} choices
 * @param {T} fallback
 * @returns {T}
 */
function parseChoice(value, label, choices, fallback) {
  if (value === undefined) return fallback;
  const match = choices.find((choice) => choice === value);
  if (match === undefined) {
    throw new UsageError(`${label} must be one of: ${choices.join(', ')} (got "${value}").`);
  }
  return match;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} fallback
 * @returns {number}
 */
function parseOptionalDuration(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new UsageError(`${label} must be a duration like 500ms, 10s, or 2m.`);
  }
  return parseDuration(value, label);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string | undefined}
 */
function optionalString(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`Config "perf.${label}" must be a non-empty string.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {RegExp[]}
 */
function parsePatterns(value) {
  if (value === undefined) return [];
  const items = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(items) || !items.every((item) => typeof item === 'string')) {
    throw new UsageError('Exclude patterns must be strings (regular expressions).');
  }
  return items.map((source) => {
    try {
      return new RegExp(source, 'i');
    } catch (error) {
      throw new UsageError(`Exclude pattern "${source}" is not a valid regular expression.`, {
        cause: error,
      });
    }
  });
}

/**
 * @param {string[] | undefined} cliHeaders `Name: value` strings from repeated `--header`.
 * @param {unknown} configHeaders
 * @returns {Record<string, string>}
 */
function parseHeaders(cliHeaders, configHeaders) {
  /** @type {Record<string, string>} */
  const headers = {};

  if (configHeaders !== undefined) {
    if (
      typeof configHeaders !== 'object' ||
      configHeaders === null ||
      Array.isArray(configHeaders)
    ) {
      throw new UsageError('Config "perf.headers" must be an object of header names to values.');
    }
    for (const [name, value] of Object.entries(configHeaders)) {
      if (typeof value !== 'string') {
        throw new UsageError(`Config header "${name}" must have a string value.`);
      }
      addHeader(headers, name, value);
    }
  }

  for (const raw of cliHeaders ?? []) {
    const separator = raw.indexOf(':');
    if (separator <= 0) {
      throw new UsageError(`--header must look like "Name: value".`);
    }
    addHeader(headers, raw.slice(0, separator), raw.slice(separator + 1));
  }
  return headers;
}

/**
 * @param {Record<string, string>} headers
 * @param {string} rawName
 * @param {string} rawValue
 */
function addHeader(headers, rawName, rawValue) {
  const name = rawName.trim().toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
    throw new UsageError(`"${rawName.trim()}" is not a valid header name.`);
  }
  if (FORBIDDEN_HEADERS.has(name)) {
    throw new UsageError(`The "${name}" header is managed by the browser and cannot be set.`);
  }
  if (/[\r\n]/.test(rawValue)) {
    throw new UsageError(`Header "${name}" must not contain line breaks.`);
  }
  headers[name] = rawValue.trim();
}

/**
 * @param {unknown} value
 * @returns {number[]}
 */
function parseStages(value) {
  if (value === undefined) return [...PERF_DEFAULTS.stress.stages];
  const items = typeof value === 'string' ? value.split(',').map((item) => item.trim()) : value;
  if (!Array.isArray(items) || items.length === 0) {
    throw new UsageError('Stress stages must be a list of concurrency levels, e.g. 1,10,50.');
  }
  if (items.length > LIMITS.stressStages) {
    throw new UsageError(`At most ${LIMITS.stressStages} stress stages are allowed.`);
  }
  const stages = items.map((item) =>
    parseInteger(item, 'Each stress stage', {
      min: 1,
      max: LIMITS.stressConcurrency,
      fallback: 1,
    }),
  );
  for (let index = 1; index < stages.length; index += 1) {
    if (stages[index] <= stages[index - 1]) {
      throw new UsageError('Stress stages must be strictly increasing, e.g. 1,10,50.');
    }
  }
  return stages;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function parseRatio(value, label) {
  if (value === undefined) return PERF_DEFAULTS.stress.maxErrorRate;
  if (typeof value !== 'number' || !(value > 0 && value <= 1)) {
    throw new UsageError(`Config "${label}" must be a number greater than 0 and at most 1.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} cwd
 * @returns {string | undefined} `latest`, or an absolute path.
 */
function resolveBaseline(value, cwd) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError('--baseline must be "latest" or a path to a previous run.');
  }
  return value === 'latest' ? 'latest' : resolve(cwd, value);
}

/**
 * `--trace-context`, `--trace-url <template>`, or config `traceContext: true | { urlTemplate }`.
 * A URL template enables trace context on its own.
 *
 * @param {PerfCliOptions} cli
 * @param {unknown} config
 * @returns {{ enabled: boolean, urlTemplate: string | undefined }}
 */
function resolveTraceContext(cli, config) {
  /** @type {string | undefined} */
  let urlTemplate;
  let enabled = false;
  if (config !== undefined) {
    if (typeof config === 'boolean') {
      enabled = config;
    } else if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
      const unknown = Object.keys(config).filter((key) => key !== 'urlTemplate');
      if (unknown.length > 0) {
        throw new UsageError(
          `Unknown key(s) in config "perf.traceContext": ${unknown.join(', ')}.`,
        );
      }
      enabled = true;
      urlTemplate = optionalString(
        /** @type {{ urlTemplate?: unknown }} */ (config).urlTemplate,
        'traceContext.urlTemplate',
      );
    } else {
      throw new UsageError(
        'Config "perf.traceContext" must be true/false or { "urlTemplate": "…" }.',
      );
    }
  }
  if (cli.traceContext !== undefined) enabled = cli.traceContext;
  if (cli.traceUrl !== undefined) {
    urlTemplate = cli.traceUrl;
    enabled = true;
  }
  if (urlTemplate !== undefined) {
    let url;
    try {
      url = new URL(urlTemplate.replaceAll('{traceId}', '0'));
    } catch {
      url = null;
    }
    if (
      !url ||
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      !urlTemplate.includes('{traceId}')
    ) {
      throw new UsageError('--trace-url must be an http(s) URL containing {traceId}.', {
        hint: 'Example: https://tracing.example.com/trace/{traceId}',
      });
    }
  }
  return { enabled, urlTemplate };
}

/**
 * @param {unknown} value
 * @param {string} cwd
 * @returns {string | undefined} `auto`, an http(s) URL, or an absolute file path.
 */
function resolveOpenApi(value, cwd) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError('--openapi must be "auto", a URL, or a path to an OpenAPI JSON file.');
  }
  if (value === 'auto' || /^https?:\/\//i.test(value)) return value;
  return resolve(cwd, value);
}

/**
 * @param {unknown} value
 * @param {string} cwd
 * @returns {string | undefined}
 */
function resolveRepo(value, cwd) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError('--repo must be a path to the app repository.');
  }
  return resolve(cwd, value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function parseRouteParams(value) {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError('Config "perf.routeParams" must map parameter names to example values.');
  }
  /** @type {Record<string, string>} */
  const params = {};
  for (const [name, example] of Object.entries(value)) {
    if (typeof example !== 'string' && typeof example !== 'number') {
      throw new UsageError(`Route parameter "${name}" must be a string or number.`);
    }
    params[name] = String(example);
  }
  return params;
}
