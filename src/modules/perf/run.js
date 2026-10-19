import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAND } from '../../core/brand.js';
import { formatDuration } from '../../core/duration.js';
import { ExitCode, LaunchScopeError } from '../../core/errors.js';
import { createInterruptController, INTERRUPTED_EXIT_CODE } from '../../core/interrupt.js';
import { createRunDirectory, writeJsonFile } from '../../core/report-dir.js';
import { SEVERITY_ORDER, sortFindings } from './analyze/bottlenecks.js';
import { countBySeverity, RunAccumulator } from './analyze/index.js';
import { writeFindings, writeRunHeader } from './console-output.js';
import { measureRoutes } from './measure-routes.js';
import { writeReport } from './report/write-report.js';
import { toReportableSettings } from './settings.js';
import { runStressPhase } from './stress-phase.js';
import { assertStressAllowed } from './stress/safety.js';

/**
 * Runs the performance module end to end:
 * settings → safety checks → discovery and measurement → analysis → stress → report.
 *
 * @param {import('./settings.js').PerfSettings} settings
 * @param {import('../../runtime.js').Runtime} runtime
 * @returns {Promise<void>}
 */
export async function runPerf(settings, runtime) {
  const { logger, io } = runtime;
  writeRunHeader(settings, logger);

  const runDirectory = await createRunDirectory({
    outputDir: runtime.outputDir,
    cwd: io.cwd,
    targetUrl: settings.targetUrl,
  });
  const perfDirectory = join(runDirectory, 'perf');
  await mkdir(perfDirectory, { recursive: true });
  await writeJsonFile(join(perfDirectory, 'settings.json'), toReportableSettings(settings));

  if (settings.stress.enabled) {
    const safety = await assertStressAllowed({
      targetUrl: settings.targetUrl,
      allowRemote: settings.stress.allowRemote,
    });
    logger.info(
      `Stress   stages ${settings.stress.stages.join(' → ')} concurrent users, ${formatDuration(settings.stress.stageDurationMs)} each`,
    );
    if (safety.remote) {
      logger.warn(
        `Stress testing a public host (${safety.addresses.join(', ')}). Only do this on systems you own or are authorized to test.`,
      );
    }
  }

  if (settings.dryRun) {
    logger.success(`Dry run: settings resolved and written to ${perfDirectory}`);
    return;
  }

  const interrupt = createInterruptController({
    onFirst: () =>
      logger.warn(
        'Stopping… finishing up and writing a partial report (press Ctrl+C again to quit now).',
      ),
  });
  try {
    await measureAndReport({ settings, runtime, perfDirectory, signal: interrupt.signal });
  } finally {
    interrupt.dispose();
  }
}

/**
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {import('../../runtime.js').Runtime} options.runtime
 * @param {string} options.perfDirectory
 * @param {AbortSignal} options.signal Aborted by Ctrl+C / SIGTERM.
 */
async function measureAndReport({ settings, runtime, perfDirectory, signal }) {
  const { logger, io } = runtime;
  const startedAt = new Date();
  const accumulator = new RunAccumulator();
  const { routes, skipped } = await measureRoutes({
    settings,
    logger,
    perfDirectory,
    signal,
    accumulator,
  });
  const analysis = accumulator.finish(settings.budgets);

  const stress =
    settings.stress.enabled && !signal.aborted
      ? await runStressPhase({ settings, routes, perfDirectory, logger, signal })
      : null;
  if (stress) {
    analysis.bottlenecks = sortFindings([...analysis.bottlenecks, ...stress.findings]);
    analysis.totals.findings = countBySeverity(analysis.bottlenecks);
  }

  const summary = {
    schemaVersion: 1,
    tool: { name: BRAND.command, version: BRAND.version },
    target: settings.targetUrl.href,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    interrupted: signal.aborted,
    settings: toReportableSettings(settings),
    totals: analysis.totals,
    routes: analysis.routes,
    endpoints: analysis.endpoints,
    bottlenecks: analysis.bottlenecks,
    stress: stress ? { ...stress.result, insights: stress.insights } : null,
    skippedUrls: skipped,
  };
  await writeJsonFile(join(perfDirectory, 'summary.json'), summary);
  await writeJsonFile(join(perfDirectory, 'endpoints.json'), analysis.endpoints);
  await writeJsonFile(join(perfDirectory, 'bottlenecks.json'), analysis.bottlenecks);
  const report = await writeReport({
    perfDirectory,
    summary,
    details: new Map(
      routes.map((route) => [
        route.slug,
        {
          trace: route.trace,
          load: route.representativeLoad,
          files: { screenshot: route.hasScreenshot, har: true },
        },
      ]),
    ),
  });

  logger.info('');
  const skippedText = Object.entries(skipped)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
  logger.info(
    `Measured ${routes.length} route(s), ${analysis.endpoints.length} endpoint(s)` +
      (skippedText ? logger.paint.dim(` · skipped: ${skippedText}`) : ''),
  );
  writeFindings(analysis.bottlenecks, logger);
  logger.success(`Report: ${logger.paint.cyan(report.html)}`);
  logger.info(logger.paint.dim(`  All files: ${perfDirectory}`));

  if (settings.json) io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (signal.aborted) {
    throw new LaunchScopeError('Interrupted. The partial report above covers what was measured.', {
      exitCode: INTERRUPTED_EXIT_CODE,
    });
  }
  enforceFailOn(analysis.bottlenecks, settings.failOn);
}

/**
 * Exits with code 1 (after all reports are written) when findings reach `--fail-on`.
 *
 * @param {import('./analyze/bottlenecks.js').Finding[]} findings
 * @param {import('./settings.js').FailOnLevel} failOn
 */
export function enforceFailOn(findings, failOn) {
  if (failOn === 'none') return;
  const failing = findings.filter(
    (finding) => SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[failOn],
  );
  if (failing.length > 0) {
    throw new LaunchScopeError(
      `${failing.length} bottleneck(s) at or above "${failOn}" (--fail-on ${failOn}).`,
      { exitCode: ExitCode.CHECK_FAILED },
    );
  }
}
