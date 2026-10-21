import { readFileSync } from 'node:fs';
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
 * @property {'closed' | 'open'} mode `closed`: virtual users wait for each response (stages are
 *   concurrent users). `open`: route replays start at a fixed rate regardless of responses
 *   (rates are replays per second).
 * @property {number[]} rates Replays started per second, per stage (open mode), ascending.
 * @property {number} maxInFlight Open mode: replays allowed in flight before new ones are dropped.
 * @property {RegExp[]} replay Same-origin POST/PUT/PATCH requests (by path) that may be replayed
 *   with their captured bodies. Everything else is GET-only; DELETE is never replayed.
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
 * @property {boolean} exportK6 Write a k6 load-test script built from the measured scenarios.
 * @property {boolean} lighthouse Run Google Lighthouse once per measured route (optional peer dependency).
 * @property {import('./analyze/budgets.js').Budgets} budgets Thresholds for findings.
 * @property {string | undefined} baseline 'latest' or an absolute path to a previous run to compare with.
 * @property {{ enabled: boolean, urlTemplate: string | undefined }} traceContext W3C traceparent on target-origin requests.
 * @property {'pages' | 'api'} mode `pages`: measure routes in a browser (`launchscope perf`). `api`:
 *   call API endpoints directly, without a browser (`launchscope api`).
 * @property {import('./discover/openapi.js').ApiOperation[]} endpoints Endpoints listed with
 *   `--endpoint` or `perf.endpoints`, measured directly over HTTP. Writes carry their body.
 * @property {string[]} imports Absolute paths of HAR files to import requests from.
 * @property {boolean} importWrites Also import recorded POST/PUT/PATCH requests, with their bodies.
 * @property {string | undefined} openapi 'auto', an http(s) URL, or an absolute path to an OpenAPI document (JSON or YAML).
 * @property {string | undefined} repo Absolute path of an app repository to read routes from.
 * @property {Record<string, string>} routeParams Values for dynamic route segments, by parameter name.
 * @property {boolean} spa Measure client-side navigations between measured routes.
 * @property {number} spaMax Maximum navigation pairs to measure.
 * @property {Array<'chromium' | 'firefox' | 'webkit'>} browsers Browsers to load routes in; Chromium is always the primary.
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
  endpoints: 100,
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

export const CONFIG_KEYS = new Set([
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
  'endpoints',
  'import',
  'importWrites',
  'openapi',
  'repo',
  'routeParams',
  'spa',
  'spaMax',
  'browsers',
  'exportK6',
  'lighthouse',
]);
export const STRESS_CONFIG_KEYS = new Set([
  'stages',
  'duration',
  'timeout',
  'includeAssets',
  'allowRemote',
  'maxErrorRate',
  'mode',
  'rates',
  'maxInFlight',
  'replay',
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
 * @property {boolean} [exportK6]
 * @property {boolean} [lighthouse]
 * @property {string} [baseline]
 * @property {boolean} [traceContext]
 * @property {string} [traceUrl]
 * @property {string[]} [endpoint]
 * @property {string[]} [import]
 * @property {boolean} [importWrites]
 * @property {string} [openapi]
 * @property {string} [repo]
 * @property {boolean} [spa]
 * @property {string} [spaMax]
 * @property {string} [browsers]
 * @property {boolean} [stress]
 * @property {string} [stressStages]
 * @property {string} [stressDuration]
 * @property {string} [stressTimeout]
 * @property {boolean} [stressIncludeAssets]
 * @property {boolean} [allowRemote]
 * @property {string} [stressMode]
 * @property {string} [stressRates]
 * @property {string[]} [stressReplay]
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
 * @param {'pages' | 'api'} [input.mode] `api` for `launchscope api`: no browser, no page routes.
 * @returns {PerfSettings}
 */
export function resolvePerfSettings({ target, cli, config, cwd, mode = 'pages' }) {
  const section = readSection(config, 'perf', CONFIG_KEYS);
  const stressSection = readSection(section.stress, 'perf.stress', STRESS_CONFIG_KEYS);
  const { url: targetUrl, scope } = parseTarget(target);

  const routes = mode === 'api' ? [] : parseRoutes(cli.routes ?? section.routes, targetUrl);
  const endpoints = parseEndpoints(cli.endpoint ?? section.endpoints, targetUrl, cwd);
  const repo = resolveRepo(cli.repo ?? section.repo, cwd);
  const imports = parseImports(cli.import ?? section.import, cwd);
  // With nothing listed, `launchscope api` looks for a spec at the usual locations.
  const openapi =
    resolveOpenApi(cli.openapi ?? section.openapi, cwd) ??
    (mode === 'api' && endpoints.length === 0 && imports.length === 0 && repo === undefined
      ? 'auto'
      : undefined);
  const storageState = cli.storageState ?? optionalString(section.storageState, 'storageState');

  return {
    targetUrl,
    scope,
    mode,
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
    sitemap:
      mode === 'pages' &&
      parseBoolean(cli.sitemap ?? section.sitemap, 'sitemap', routes.length === 0),
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
    exportK6: parseBoolean(cli.exportK6 ?? section.exportK6, 'exportK6', false),
    lighthouse:
      mode === 'pages' && parseBoolean(cli.lighthouse ?? section.lighthouse, 'lighthouse', false),
    budgets: resolveBudgets(section.budgets),
    baseline: resolveBaseline(cli.baseline ?? section.baseline, cwd),
    traceContext: resolveTraceContext(cli, section.traceContext),
    endpoints,
    imports,
    importWrites: parseBoolean(cli.importWrites ?? section.importWrites, 'importWrites', false),
    openapi,
    repo,
    routeParams: parseRouteParams(section.routeParams),
    spa: mode === 'pages' && parseBoolean(cli.spa ?? section.spa, 'spa', false),
    spaMax: parseInteger(cli.spaMax ?? section.spaMax, '--spa-max', {
      min: 1,
      max: 100,
      fallback: 20,
    }),
    browsers: mode === 'pages' ? parseBrowsers(cli.browsers ?? section.browsers) : ['chromium'],
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
      includeAssets:
        mode === 'pages' &&
        parseBoolean(
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
      mode: parseChoice(
        cli.stressMode ?? stressSection.mode,
        '--stress-mode',
        STRESS_MODES,
        'closed',
      ),
      rates: parseRates(cli.stressRates ?? stressSection.rates),
      replay: parsePatterns(cli.stressReplay ?? stressSection.replay, 'Stress replay pattern'),
      maxInFlight: parseInteger(stressSection.maxInFlight, 'stress.maxInFlight', {
        min: 1,
        max: 10_000,
        fallback: 1000,
      }),
    },
  };
}

/**
 * A copy of the settings that is safe to write into reports: header values, the query values
 * of listed endpoints (which may carry keys or tokens), and request bodies are redacted.
 *
 * @param {PerfSettings} settings
 */
export function toReportableSettings(settings) {
  return {
    ...settings,
    targetUrl: settings.targetUrl.href,
    // Bodies are never written to reports; only their presence is.
    endpoints: settings.endpoints.map(
      ({ url, method = 'GET', body }) =>
        `${method} ${redactQuery(url)}${body === null || body === undefined ? '' : ' (with body)'}`,
    ),
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
 * Endpoints are `"/path"`, `"METHOD /path"`, or `"METHOD /path <body>"`, where the body is inline
 * text or `@file` (paths or same-origin URLs). Config entries may also be objects:
 * `{ method, path, body, bodyFile, contentType }`. POST, PUT, and PATCH are sent only because the
 * user listed them; DELETE and other methods are refused. Bodies stay in memory and never reach
 * report files.
 *
 * @param {unknown} value
 * @param {URL} targetUrl
 * @param {string} cwd Base for `@file` and `bodyFile` paths.
 * @returns {import('./discover/openapi.js').ApiOperation[]}
 */
function parseEndpoints(value, targetUrl, cwd) {
  if (value === undefined) return [];
  const items = typeof value === 'string' || isPlainObject(value) ? [value] : value;
  if (!Array.isArray(items)) {
    throw new UsageError(
      'Endpoints must be a list like ["/api/health", "POST /api/search @q.json"].',
    );
  }
  /** @type {Map<string, import('./discover/openapi.js').ApiOperation>} */
  const endpoints = new Map();
  for (const item of items) {
    const entry = typeof item === 'string' ? parseEndpointString(item) : parseEndpointObject(item);
    if (!entry) continue;
    const { raw } = entry;
    const method = ENDPOINT_METHODS.find((choice) => choice === entry.method);
    if (method === undefined) {
      throw new UsageError(`Endpoint "${raw}": ${entry.method} is not supported.`, {
        hint: 'List GET endpoints, or POST, PUT, and PATCH with a body. DELETE is never sent.',
      });
    }
    let url;
    try {
      url = new URL(entry.path, targetUrl);
    } catch {
      throw new UsageError(`Endpoint "${raw}" is not a valid path or URL.`);
    }
    if (url.origin !== targetUrl.origin) {
      throw new UsageError(`Endpoint "${raw}" is not on the target origin ${targetUrl.origin}.`, {
        hint: 'Headers and cookies are only sent to the target, so endpoints must be on it too.',
      });
    }
    url.hash = '';
    const body = readEndpointBody(entry, raw, cwd);
    if (body !== null && method === 'GET') {
      throw new UsageError(`Endpoint "${raw}": GET requests cannot have a body.`);
    }
    endpoints.set(`${method} ${url.href}`, {
      url: url.href,
      path: url.pathname,
      operationId: null,
      ...(method === 'GET'
        ? {}
        : {
            method,
            body,
            contentType: entry.contentType ?? (body === null ? null : guessContentType(body)),
          }),
    });
  }
  if (endpoints.size > LIMITS.endpoints) {
    throw new UsageError(`At most ${LIMITS.endpoints} endpoints can be listed.`);
  }
  return [...endpoints.values()];
}

const ENDPOINT_METHODS = /** @type {const} */ (['GET', 'POST', 'PUT', 'PATCH']);
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * @typedef {object} EndpointEntry
 * @property {string} raw For error messages.
 * @property {string} method Uppercased.
 * @property {string} path
 * @property {string | null} inlineBody
 * @property {string | null} bodyFile
 * @property {string | null} contentType
 */

/**
 * @param {string} item
 * @returns {EndpointEntry | null}
 */
function parseEndpointString(item) {
  const raw = item.trim();
  if (raw === '') return null;
  const match = /^(?:([A-Za-z]+)\s+)?(\S+)(?:\s+([\s\S]+))?$/.exec(raw);
  // Without a method, anything after the path is a typo rather than a body.
  if (!match || (!match[1] && match[3])) {
    throw new UsageError(
      `Endpoint "${raw}" must look like "/path", "GET /path", or "POST /path @body.json".`,
    );
  }
  const rest = match[3]?.trim() ?? null;
  return {
    raw,
    method: (match[1] ?? 'GET').toUpperCase(),
    path: match[2],
    inlineBody: rest && !rest.startsWith('@') ? rest : null,
    bodyFile: rest?.startsWith('@') ? rest.slice(1) : null,
    contentType: null,
  };
}

const ENDPOINT_OBJECT_KEYS = new Set(['method', 'path', 'body', 'bodyFile', 'contentType']);

/**
 * @param {unknown} item
 * @returns {EndpointEntry}
 */
function parseEndpointObject(item) {
  if (!isPlainObject(item)) {
    throw new UsageError('Each endpoint must be a string or an object with "path".');
  }
  const record = /** @type {Record<string, unknown>} */ (item);
  const unknown = Object.keys(record).filter((key) => !ENDPOINT_OBJECT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown key(s) in endpoint: ${unknown.join(', ')}.`, {
      hint: `Allowed keys: ${[...ENDPOINT_OBJECT_KEYS].join(', ')}.`,
    });
  }
  const { method = 'GET', path, body, bodyFile, contentType } = record;
  if (typeof path !== 'string' || path.trim() === '') {
    throw new UsageError('Each endpoint object needs a "path" string.');
  }
  if (typeof method !== 'string')
    throw new UsageError(`Endpoint "${path}": "method" must be a string.`);
  if (body !== undefined && bodyFile !== undefined) {
    throw new UsageError(`Endpoint "${path}": use "body" or "bodyFile", not both.`);
  }
  if (bodyFile !== undefined && (typeof bodyFile !== 'string' || bodyFile.trim() === '')) {
    throw new UsageError(`Endpoint "${path}": "bodyFile" must be a path.`);
  }
  if (
    contentType !== undefined &&
    (typeof contentType !== 'string' || /[\r\n]/.test(contentType))
  ) {
    throw new UsageError(`Endpoint "${path}": "contentType" must be a single-line string.`);
  }
  return {
    raw: `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase(),
    path: path.trim(),
    // Objects and arrays are sent as JSON; strings as they are.
    inlineBody:
      body === undefined || body === null
        ? null
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
    bodyFile: /** @type {string | undefined} */ (bodyFile) ?? null,
    contentType:
      /** @type {string | undefined} */ (contentType) ??
      (body !== undefined && body !== null && typeof body !== 'string' ? 'application/json' : null),
  };
}

/**
 * @param {EndpointEntry} entry
 * @param {string} raw
 * @param {string} cwd
 * @returns {string | null}
 */
function readEndpointBody(entry, raw, cwd) {
  let body = entry.inlineBody;
  if (entry.bodyFile !== null) {
    const path = resolve(cwd, entry.bodyFile);
    try {
      body = readFileSync(path, 'utf8');
    } catch (error) {
      throw new UsageError(`Endpoint "${raw}": could not read body file ${path}.`, {
        cause: error,
      });
    }
  }
  if (body !== null && Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new UsageError(`Endpoint "${raw}": the request body is larger than 1 MB.`);
  }
  return body;
}

/**
 * @param {string} body
 * @returns {string}
 */
function guessContentType(body) {
  try {
    JSON.parse(body);
    return 'application/json';
  } catch {
    return 'text/plain;charset=UTF-8';
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * @param {string} [label]
 * @returns {RegExp[]}
 */
function parsePatterns(value, label = 'Exclude pattern') {
  if (value === undefined) return [];
  const items = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(items) || !items.every((item) => typeof item === 'string')) {
    throw new UsageError(`${label}s must be strings (regular expressions).`);
  }
  return items.map((source) => {
    try {
      return new RegExp(source, 'i');
    } catch (error) {
      throw new UsageError(`${label} "${source}" is not a valid regular expression.`, {
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
    throw new UsageError(
      '--openapi must be "auto", a URL, or a path to an OpenAPI file (JSON or YAML).',
    );
  }
  if (value === 'auto' || /^https?:\/\//i.test(value)) return value;
  return resolve(cwd, value);
}

/**
 * @param {unknown} value One path or a list of paths.
 * @param {string} cwd
 * @returns {string[]} Absolute paths.
 */
function parseImports(value, cwd) {
  if (value === undefined) return [];
  const items = typeof value === 'string' ? [value] : value;
  if (
    !Array.isArray(items) ||
    !items.every((item) => typeof item === 'string' && item.trim() !== '')
  ) {
    throw new UsageError('Imports must be paths to HAR files.');
  }
  return [...new Set(items.map((item) => resolve(cwd, item)))];
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

const BROWSERS = /** @type {const} */ (['chromium', 'firefox', 'webkit']);

/**
 * @param {unknown} value Comma-separated string or array.
 * @returns {Array<'chromium' | 'firefox' | 'webkit'>} Always starts with chromium.
 */
function parseBrowsers(value) {
  if (value === undefined) return ['chromium'];
  const items =
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
      : Array.isArray(value)
        ? value
        : null;
  if (!items || items.length === 0) {
    throw new UsageError(
      '--browsers must list chromium, firefox, and/or webkit, e.g. chromium,firefox.',
    );
  }
  for (const item of items) {
    if (!BROWSERS.includes(item)) {
      throw new UsageError(`Unknown browser "${item}". Choose from: ${BROWSERS.join(', ')}.`);
    }
  }
  return ['chromium', ...BROWSERS.filter((name) => name !== 'chromium' && items.includes(name))];
}

const STRESS_MODES = /** @type {const} */ (['closed', 'open']);
const DEFAULT_RATES = Object.freeze([1, 5, 10, 25, 50]);

/**
 * @param {unknown} value
 * @returns {number[]} Strictly increasing replays per second (decimals allowed).
 */
function parseRates(value) {
  if (value === undefined) return [...DEFAULT_RATES];
  const items = typeof value === 'string' ? value.split(',').map((item) => item.trim()) : value;
  if (!Array.isArray(items) || items.length === 0 || items.length > LIMITS.stressStages) {
    throw new UsageError(
      `Stress rates must be 1 to ${LIMITS.stressStages} replays per second, e.g. 2,5,10.`,
    );
  }
  const rates = items.map((item) => {
    const rate = typeof item === 'number' ? item : Number(item);
    if (!Number.isFinite(rate) || rate <= 0 || rate > LIMITS.stressConcurrency) {
      throw new UsageError(
        `Each stress rate must be a number above 0 and at most ${LIMITS.stressConcurrency} (got "${item}").`,
      );
    }
    return rate;
  });
  for (let index = 1; index < rates.length; index += 1) {
    if (rates[index] <= rates[index - 1])
      throw new UsageError('Stress rates must be strictly increasing, e.g. 2,5,10.');
  }
  return rates;
}

/**
 * @param {string} href
 * @returns {string} The URL with every query value replaced by `[redacted]`.
 */
function redactQuery(href) {
  const url = new URL(href);
  const names = [...new Set(url.searchParams.keys())];
  url.search = '';
  for (const name of names) url.searchParams.append(name, '[redacted]');
  return url.href.replaceAll('%5Bredacted%5D', '[redacted]');
}
