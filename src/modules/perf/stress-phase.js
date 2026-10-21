import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatDuration } from '../../core/duration.js';
import { writeJsonFile } from '../../core/report-dir.js';
import { analyzeStress } from './stress/analyze.js';
import { runStress } from './stress/runner.js';
import { apiScenario, buildScenarios, loadCookieJar } from './stress/scenario.js';

/**
 * @typedef {object} StressPhaseResult
 * @property {import('./stress/runner.js').StressResult} result
 * @property {import('./stress/analyze.js').StressInsights} insights
 * @property {import('./analyze/bottlenecks.js').Finding[]} findings
 */

/**
 * Replays the measured routes under increasing concurrency and writes `stress/` artifacts.
 * An aborted `signal` (Ctrl+C) stops the current stage and keeps what was measured so far.
 *
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {import('./measure-routes.js').RouteRecord[]} options.routes
 * @param {import('./discover/openapi.js').ApiOperation[]} [options.apiOperations] Replayed as one extra scenario.
 * @param {string} options.perfDirectory
 * @param {import('../../core/logger.js').Logger} options.logger
 * @param {AbortSignal} options.signal
 * @returns {Promise<StressPhaseResult | null>}
 */
export async function runStressPhase({
  settings,
  routes,
  apiOperations = [],
  perfDirectory,
  logger,
  signal,
}) {
  const { paint } = logger;
  const scenarios = buildScenarios(routes, {
    targetOrigin: settings.targetUrl.origin,
    includeAssets: settings.stress.includeAssets,
  });
  const api = apiScenario(apiOperations, { replay: settings.stress.replay });
  if (api.levels[0].length > 0) scenarios.push(api);
  if (scenarios.length === 0) {
    logger.warn('Skipping the stress test: no route loaded successfully on the target origin.');
    return null;
  }

  const cookieFor = await loadCookieJar(settings.storageStatePath);
  logger.info('');
  const replayed = new Set(
    scenarios.flatMap((scenario) =>
      scenario.levels
        .flat()
        .filter((request) => request.method && request.method !== 'GET')
        .map((request) => request.label),
    ),
  );
  logger.info(
    paint.bold('Stress test') +
      paint.dim(
        ` · ${scenarios.length} scenario(s), requests to ${settings.targetUrl.origin} only` +
          (replayed.size ? '' : ', GET only'),
      ),
  );
  if (replayed.size > 0) {
    logger.warn(
      `Replaying allowlisted writes with their recorded bodies: ${[...replayed].join(', ')}. These can create data on the target.`,
    );
  } else if (settings.stress.replay.length > 0) {
    logger.warn('No request matched --stress-replay; the stress test sends GET requests only.');
  }

  const result = await runStress({
    scenarios,
    settings: settings.stress,
    headers: settings.headers,
    cookieFor,
    signal,
    onStage: (stage) => {
      const icon = stage.errorRate > 0 ? paint.yellow('!') : paint.green('✔');
      logger.info(
        `  ${icon} ${(stage.mode === 'open' ? `${stage.load}/s` : `${stage.load} users`).padStart(9)}  ` +
          paint.dim(
            `${stage.requestsPerSecond.toFixed(1)} req/s · p50 ${formatDuration(stage.latencyMs?.p50 ?? Number.NaN)} · ` +
              `p95 ${formatDuration(stage.latencyMs?.p95 ?? Number.NaN)} · errors ${(stage.errorRate * 100).toFixed(1)}%` +
              (stage.mode === 'open'
                ? ` · peak in flight ${stage.concurrency}${stage.dropped ? ` · dropped ${stage.dropped}` : ''}`
                : ''),
          ),
      );
    },
  });
  if (result.stoppedReason) logger.warn(result.stoppedReason);

  const { insights, findings } = analyzeStress(result, settings.budgets);
  const stressDirectory = join(perfDirectory, 'stress');
  await mkdir(stressDirectory, { recursive: true });
  await writeJsonFile(join(stressDirectory, 'stress.json'), { ...result, insights });
  return { result, insights, findings };
}
