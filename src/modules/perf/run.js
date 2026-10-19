import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatDuration } from '../../core/duration.js';
import { createRunDirectory, writeJsonFile } from '../../core/report-dir.js';
import { toReportableSettings } from './settings.js';

/**
 * Runs the performance module end to end.
 *
 * @param {import('./settings.js').PerfSettings} settings
 * @param {import('../../runtime.js').Runtime} runtime
 * @returns {Promise<void>}
 */
export async function runPerf(settings, runtime) {
  const { logger, io } = runtime;
  logger.banner();
  logger.info(`Target   ${logger.paint.cyan(settings.targetUrl.href)} (${settings.scope})`);
  logger.info(
    `Plan     ${settings.runs} cold run(s)${settings.warmRuns ? ` + ${settings.warmRuns} warm` : ''} per route, ` +
      `${settings.device}, throttle ${settings.throttle}, timeout ${formatDuration(settings.timeoutMs)}`,
  );

  const runDirectory = await createRunDirectory({
    outputDir: runtime.outputDir,
    cwd: io.cwd,
    targetUrl: settings.targetUrl,
  });
  const perfDirectory = join(runDirectory, 'perf');
  await mkdir(perfDirectory, { recursive: true });
  await writeJsonFile(join(perfDirectory, 'settings.json'), toReportableSettings(settings));

  if (settings.dryRun) {
    logger.success(`Dry run: settings resolved and written to ${perfDirectory}`);
    return;
  }

  logger.success(`Report directory: ${perfDirectory}`);
}
