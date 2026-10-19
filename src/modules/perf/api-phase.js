import { join } from 'node:path';
import { writeJsonFile } from '../../core/report-dir.js';
import { templatePath } from './analyze/endpoints.js';
import { loadOpenApi, planOperations } from './discover/openapi.js';
import { measureApiOperations } from './measure-api.js';
import { loadCookieJar } from './stress/scenario.js';

const MAX_OPERATIONS = 100;
const SPEC_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} ApiPhaseResult
 * @property {import('./discover/openapi.js').OpenApiPlan | null} plan The OpenAPI plan, if any.
 * @property {import('./discover/openapi.js').ApiOperation[]} operations Everything measured.
 */

/**
 * Measures API endpoints directly over HTTP: GET operations from an OpenAPI document and GET
 * routes found in the repository (skipping any the spec already covers). Results are folded into
 * the endpoint statistics; the OpenAPI plan is written to `openapi.json`.
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
  if ((!settings.openapi && repoApis.length === 0) || signal.aborted) return null;
  const plan = settings.openapi ? await planFromSpec(settings, logger) : null;
  const specOperations = plan?.operations ?? [];

  const covered = new Set(specOperations.map((operation) => templateKey(operation.url)));
  /** @type {import('./discover/openapi.js').ApiOperation[]} */
  const repoOperations = [];
  for (const path of repoApis) {
    const url = new URL(path, settings.targetUrl.origin).href;
    if (covered.has(templateKey(url)) || repoOperations.length >= MAX_OPERATIONS) continue;
    covered.add(templateKey(url));
    repoOperations.push({ url, path, operationId: null });
  }
  if (specOperations.length === 0 && repoOperations.length === 0)
    return plan ? { plan, operations: [] } : null;

  logger.info('');
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

  const cookieFor = await loadCookieJar(settings.storageStatePath);
  for (const [operations, source] of /** @type {const} */ ([
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
      signal,
    });
    accumulator.addApiLoads(loads, settings.targetUrl.origin, source);
  }

  if (plan) {
    await writeJsonFile(join(perfDirectory, 'openapi.json'), {
      source: plan.source,
      title: plan.title,
      measured: plan.operations,
      skipped: plan.skipped,
      runs: settings.runs,
    });
  }
  return { plan, operations: [...specOperations, ...repoOperations] };
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
