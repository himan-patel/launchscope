import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatDuration } from '../../core/duration.js';
import { writeJsonFile } from '../../core/report-dir.js';
import { analyzeStress } from './stress/analyze.js';
import { runStress } from './stress/runner.js';
import { buildScenarios, loadCookieJar } from './stress/scenario.js';

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
 * @param {string} options.perfDirectory
 * @param {import('../../core/logger.js').Logger} options.logger
 * @param {AbortSignal} options.signal
 * @returns {Promise<StressPhaseResult | null>}
 */
export async function runStressPhase({ settings, routes, perfDirectory, logger, signal }) {
  const { paint } = logger;
  const scenarios = buildScenarios(routes, {
    targetOrigin: settings.targetUrl.origin,
    includeAssets: settings.stress.includeAssets,
  });
  if (scenarios.length === 0) {
    logger.warn('Skipping the stress test: no route loaded successfully on the target origin.');
    return null;
  }

  const cookieFor = await loadCookieJar(settings.storageStatePath);
  logger.info('');
  logger.info(
    paint.bold('Stress test') +
      paint.dim(
        ` · ${scenarios.length} route scenario(s), GET requests to ${settings.targetUrl.origin} only`,
      ),
  );
  const result = await runStress({
    scenarios,
    settings: settings.stress,
    headers: settings.headers,
    cookieFor,
    signal,
    onStage: (stage) => {
      const icon = stage.errorRate > 0 ? paint.yellow('!') : paint.green('✔');
      logger.info(
        `  ${icon} ${String(stage.concurrency).padStart(4)} users  ` +
          paint.dim(
            `${stage.requestsPerSecond.toFixed(1)} req/s · p50 ${formatDuration(stage.latencyMs?.p50 ?? Number.NaN)} · ` +
              `p95 ${formatDuration(stage.latencyMs?.p95 ?? Number.NaN)} · errors ${(stage.errorRate * 100).toFixed(1)}%`,
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
