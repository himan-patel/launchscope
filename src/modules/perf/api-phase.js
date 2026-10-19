import { join } from 'node:path';
import { writeJsonFile } from '../../core/report-dir.js';
import { loadOpenApi, planOperations } from './discover/openapi.js';
import { measureApiOperations } from './measure-api.js';
import { loadCookieJar } from './stress/scenario.js';

const MAX_OPERATIONS = 100;
const SPEC_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} ApiPhaseResult
 * @property {import('./discover/openapi.js').OpenApiPlan} plan
 * @property {number} measured Operations measured.
 */

/**
 * Loads the OpenAPI document, measures its safe GET operations directly, folds the results into
 * the endpoint statistics, and writes `openapi.json`.
 *
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {import('../../core/logger.js').Logger} options.logger
 * @param {string} options.perfDirectory
 * @param {AbortSignal} options.signal
 * @param {import('./analyze/index.js').RunAccumulator} options.accumulator
 * @returns {Promise<ApiPhaseResult | null>}
 */
export async function runApiPhase({ settings, logger, perfDirectory, signal, accumulator }) {
  if (!settings.openapi || signal.aborted) return null;
  const loaded = await loadOpenApi({
    reference: settings.openapi,
    targetUrl: settings.targetUrl,
    headers: settings.headers,
    timeoutMs: Math.min(SPEC_TIMEOUT_MS, settings.timeoutMs),
  });
  if (!loaded) {
    logger.warn(
      'No OpenAPI document found at the usual locations (e.g. /openapi.json); skipping API measurement.',
    );
    return null;
  }

  const plan = planOperations({
    document: loaded.document,
    source: loaded.source,
    targetUrl: settings.targetUrl,
    limit: MAX_OPERATIONS,
  });
  logger.info('');
  logger.info(
    `${logger.paint.bold('API')}      ${plan.operations.length} GET operation(s) from ${plan.source}` +
      logger.paint.dim(plan.skipped.length ? ` · ${plan.skipped.length} skipped` : ''),
  );

  const loads = await measureApiOperations({
    operations: plan.operations,
    runs: settings.runs,
    timeoutMs: settings.timeoutMs,
    headers: settings.headers,
    cookieFor: await loadCookieJar(settings.storageStatePath),
    signal,
  });
  accumulator.addApiLoads(loads, settings.targetUrl.origin);

  await writeJsonFile(join(perfDirectory, 'openapi.json'), {
    source: plan.source,
    title: plan.title,
    measured: plan.operations,
    skipped: plan.skipped,
    runs: loads.length,
  });
  return { plan, measured: plan.operations.length };
}
