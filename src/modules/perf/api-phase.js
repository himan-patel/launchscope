import { join } from 'node:path';
import { writeJsonFile } from '../../core/report-dir.js';
import { templatePath } from './analyze/endpoints.js';
import { loadImports } from './discover/imports.js';
import { loadOpenApi, planOperations } from './discover/openapi.js';
import { measureApiOperations } from './measure-api.js';
import { loadCookieJar } from './stress/scenario.js';

const MAX_OPERATIONS = 100;
const SPEC_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} ApiPhaseResult
 * @property {import('./discover/openapi.js').OpenApiPlan | null} plan The OpenAPI plan, if any.
 * @property {import('./discover/imports.js').ImportPlan | null} [imports] Requests imported from files.
 * @property {import('./discover/openapi.js').ApiOperation[]} operations Everything measured.
 */

/**
 * Measures API endpoints directly over HTTP: endpoints listed with `--endpoint`, requests
 * imported from HAR files, GET operations from an OpenAPI document, and GET routes found in the
 * repository, in that order of precedence. Results are folded into the endpoint statistics; the
 * OpenAPI plan is written to `openapi.json` and the import plan to `imports.json`.
 *
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {import('../../core/logger.js').Logger} options.logger
 * @param {string} options.perfDirectory
 * @param {AbortSignal} options.signal
 * @param {import('./analyze/index.js').RunAccumulator} options.accumulator
 * @param {string[]} [options.repoApis] GET API paths found in the repository.
 * @returns {Promise<ApiPhaseResult | null>}
 */
export async function runApiPhase({
  settings,
  logger,
  perfDirectory,
  signal,
  accumulator,
  repoApis = [],
}) {
  const listed = settings.endpoints;
  const nothingToDo =
    !settings.openapi &&
    repoApis.length === 0 &&
    listed.length === 0 &&
    settings.imports.length === 0;
  if (nothingToDo || signal.aborted) return null;
  const imports =
    settings.imports.length > 0
      ? await loadImports({
          files: settings.imports,
          targetUrl: settings.targetUrl,
          includeWrites: settings.importWrites,
          limit: MAX_OPERATIONS,
        })
      : null;
  const plan = settings.openapi ? await planFromSpec(settings, logger) : null;

  // Earlier sources win: an operation already measured (same method and URL) is not measured
  // again, and repository routes are skipped when any source covers their path template.
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {import('./discover/openapi.js').ApiOperation[]} operations */
  const unseen = (operations) =>
    operations.filter((operation) => {
      const key = `${operation.method ?? 'GET'} ${operation.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const listedOperations = unseen(listed);
  const importedOperations = unseen(imports?.operations ?? []);
  const specOperations = unseen(plan?.operations ?? []);

  const covered = new Set(
    [...listedOperations, ...importedOperations, ...specOperations]
      .filter((operation) => !operation.method)
      .map((operation) => templateKey(operation.url)),
  );
  /** @type {import('./discover/openapi.js').ApiOperation[]} */
  const repoOperations = [];
  for (const path of repoApis) {
    const url = new URL(path, settings.targetUrl.origin).href;
    if (covered.has(templateKey(url)) || repoOperations.length >= MAX_OPERATIONS) continue;
    covered.add(templateKey(url));
    repoOperations.push({ url, path, operationId: null });
  }
  const all = [...listedOperations, ...importedOperations, ...specOperations, ...repoOperations];
  if (all.length === 0) {
    await writePlans({ settings, perfDirectory, plan, imports });
    return plan || imports ? { plan, imports, operations: [] } : null;
  }

  logger.info('');
  if (listedOperations.length > 0) {
    logger.info(
      `${logger.paint.bold('API')}      ${listedOperations.length} listed endpoint(s)` +
        logger.paint.dim(writesNote(listedOperations)),
    );
  }
  if (imports) {
    for (const source of imports.sources) {
      logger.info(
        `${logger.paint.bold('API')}      ${source.operations} request(s) imported from ${source.file} (${source.format.toUpperCase()})`,
      );
    }
    const skippedCount = imports.skipped.reduce((sum, entry) => sum + entry.count, 0);
    if (skippedCount > 0) {
      logger.info(
        logger.paint.dim(
          `         ${skippedCount} recorded request(s) not imported; see imports.json`,
        ),
      );
    }
  }
  if (plan) {
    logger.info(
      `${logger.paint.bold('API')}      ${specOperations.length} GET operation(s) from ${plan.source}` +
        logger.paint.dim(plan.skipped.length ? ` · ${plan.skipped.length} skipped` : ''),
    );
  }
  if (repoOperations.length > 0) {
    logger.info(
      `${logger.paint.bold('API')}      ${repoOperations.length} GET route(s) from the repository`,
    );
  }
  const writes = all.filter((operation) => operation.method);
  if (writes.length > 0) {
    logger.warn(
      `Sending writes ${settings.runs} time(s) each: ${writes.map((operation) => `${operation.method} ${new URL(operation.url).pathname}`).join(', ')}. These can create data on the target.`,
    );
  }

  const cookieFor = await loadCookieJar(settings.storageStatePath);
  for (const [operations, source] of /** @type {const} */ ([
    [listedOperations, 'listed'],
    [importedOperations, 'imported'],
    [specOperations, 'openapi'],
    [repoOperations, 'repo'],
  ])) {
    if (operations.length === 0 || signal.aborted) continue;
    const loads = await measureApiOperations({
      operations,
      runs: settings.runs,
      timeoutMs: settings.timeoutMs,
      headers: settings.headers,
      cookieFor,
      origin: settings.targetUrl.origin,
      signal,
    });
    accumulator.addApiLoads(loads, settings.targetUrl.origin, source);
  }

  await writePlans({ settings, perfDirectory, plan, imports });
  return { plan, imports, operations: all };
}

/**
 * Writes `openapi.json` and `imports.json`. Imported URLs are listed without query strings and
 * bodies are never written, since recorded requests can carry tokens.
 *
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {string} options.perfDirectory
 * @param {import('./discover/openapi.js').OpenApiPlan | null} options.plan
 * @param {import('./discover/imports.js').ImportPlan | null} options.imports
 */
async function writePlans({ settings, perfDirectory, plan, imports }) {
  if (plan) {
    await writeJsonFile(join(perfDirectory, 'openapi.json'), {
      source: plan.source,
      title: plan.title,
      measured: plan.operations,
      skipped: plan.skipped,
      runs: settings.runs,
    });
  }
  if (imports) {
    await writeJsonFile(join(perfDirectory, 'imports.json'), {
      sources: imports.sources,
      measured: imports.operations.map((operation) => ({
        method: operation.method ?? 'GET',
        path: operation.path,
        withBody: operation.body !== null && operation.body !== undefined,
      })),
      skipped: imports.skipped,
      runs: settings.runs,
    });
  }
}

/** @param {import('./discover/openapi.js').ApiOperation[]} operations */
function writesNote(operations) {
  const count = operations.filter((operation) => operation.method).length;
  return count ? ` · ${count} write(s)` : '';
}

/**
 * @param {import('./settings.js').PerfSettings} settings
 * @param {import('../../core/logger.js').Logger} logger
 * @returns {Promise<import('./discover/openapi.js').OpenApiPlan | null>}
 */
async function planFromSpec(settings, logger) {
  const loaded = await loadOpenApi({
    reference: /** @type {string} */ (settings.openapi),
    targetUrl: settings.targetUrl,
    headers: settings.headers,
    timeoutMs: Math.min(SPEC_TIMEOUT_MS, settings.timeoutMs),
  });
  if (!loaded) {
    logger.warn(
      'No OpenAPI document found at the usual locations (e.g. /openapi.json); skipping it.',
    );
    return null;
  }
  return planOperations({
    document: loaded.document,
    source: loaded.source,
    targetUrl: settings.targetUrl,
    limit: MAX_OPERATIONS,
  });
}

/** @param {string} url */
function templateKey(url) {
  return templatePath(new URL(url).pathname);
}
