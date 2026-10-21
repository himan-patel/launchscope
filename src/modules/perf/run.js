import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BRAND } from '../../core/brand.js';
import { formatDuration } from '../../core/duration.js';
import { ExitCode, LaunchScopeError, UsageError } from '../../core/errors.js';
import { createInterruptController, INTERRUPTED_EXIT_CODE } from '../../core/interrupt.js';
import { createRunDirectory, writeJsonFile } from '../../core/report-dir.js';
import { SEVERITY_ORDER, sortFindings } from './analyze/bottlenecks.js';
import { compareRuns, loadBaseline, regressionFindings } from './analyze/compare.js';
import { countBySeverity, RunAccumulator } from './analyze/index.js';
import { repoVerificationFindings, verifyRepoRoutes } from './analyze/repo-verification.js';
import { runApiPhase } from './api-phase.js';
import { discoverRepoRoutes } from './discover/repo.js';
import { writeFindings, writeRunHeader } from './console-output.js';
import { runCrossBrowserPhase } from './cross-browser-phase.js';
import { loadLighthouse, runLighthousePhase } from './lighthouse-phase.js';
import { measureRoutes } from './measure-routes.js';
import { runNavigationPhase } from './navigation-phase.js';
import { buildK6Script } from './report/k6.js';
import { writeReport } from './report/write-report.js';
import { toReportableSettings } from './settings.js';
import { runStressPhase } from './stress-phase.js';
import { assertStressAllowed } from './stress/safety.js';
import { apiScenario, buildScenarios } from './stress/scenario.js';

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

  const baseline = settings.baseline
    ? await loadBaseline({
        reference: settings.baseline,
        outputDirectory: resolve(io.cwd, runtime.outputDir),
        currentRunDirectory: runDirectory,
        mode: settings.mode,
      })
    : null;
  if (baseline) {
    logger.info(`Baseline ${baseline.path} (${baseline.summary.startedAt})`);
  } else if (settings.baseline === 'latest') {
    logger.warn(
      'No earlier completed run for this host was found; skipping the baseline comparison.',
    );
  }

  if (settings.lighthouse) await loadLighthouse();

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
    await measureAndReport({
      settings,
      runtime,
      perfDirectory,
      baseline,
      signal: interrupt.signal,
    });
  } finally {
    interrupt.dispose();
  }
}

/**
 * @param {object} options
 * @param {import('./settings.js').PerfSettings} options.settings
 * @param {import('../../runtime.js').Runtime} options.runtime
 * @param {string} options.perfDirectory
 * @param {{ path: string, summary: any } | null} options.baseline
 * @param {AbortSignal} options.signal Aborted by Ctrl+C / SIGTERM.
 */
async function measureAndReport({ settings, runtime, perfDirectory, baseline, signal }) {
  const { logger, io } = runtime;
  const startedAt = new Date();
  const accumulator = new RunAccumulator();
  const repo = settings.repo
    ? await discoverRepoRoutes({ root: settings.repo, routeParams: settings.routeParams })
    : null;
  if (repo) {
    await writeJsonFile(join(perfDirectory, 'repo.json'), repo);
    logger.info(
      `Repo     ${repo.pages.length} page route(s), ${repo.apis.length} GET API route(s)` +
        (repo.frameworks.length ? ` (${repo.frameworks.join(', ')})` : ' (no known router found)') +
        logger.paint.dim(repo.skipped.length ? ` · ${repo.skipped.length} need routeParams` : ''),
    );
  }
  const { routes, skipped } =
    settings.mode === 'api'
      ? { routes: [], skipped: {} }
      : await measureRoutes({
          settings,
          logger,
          perfDirectory,
          signal,
          accumulator,
          repoRoutes: repo?.pages ?? [],
        });
  const api = await runApiPhase({
    settings,
    logger,
    perfDirectory,
    signal,
    accumulator,
    repoApis: repo?.apis ?? [],
  });
  if (settings.mode === 'api' && !signal.aborted && (api?.operations.length ?? 0) === 0) {
    throw new UsageError('No API endpoints to measure.', {
      hint: settings.imports.length
        ? 'No imported request was an API call on the target origin; imports.json lists why (writes need --import-writes).'
        : settings.openapi
          ? 'The OpenAPI spec had no callable GET operations. List endpoints with --endpoint "/api/health".'
          : 'List endpoints with --endpoint "/api/health", import a HAR file with --import, or point --openapi at a spec.',
    });
  }
  const navigation =
    settings.spa && !signal.aborted
      ? await runNavigationPhase({ settings, routes, perfDirectory, logger, signal })
      : null;
  const analysis = accumulator.finish(settings.budgets);
  // Page routes are not loaded in API mode, so they cannot be verified.
  const verification =
    repo && settings.mode === 'pages'
      ? verifyRepoRoutes({
          repo,
          routes: analysis.routes,
          endpoints: analysis.endpoints,
          targetUrl: settings.targetUrl,
          exclude: settings.exclude,
        })
      : null;
  if (repo && verification) {
    await writeJsonFile(join(perfDirectory, 'repo.json'), { ...repo, verification });
    const { counts } = verification;
    logger.info(
      `Repo     verified against the live app: ${counts.ok} ok, ${counts['not-found']} not found, ` +
        `${counts.error} error, ${counts['not-measured']} not measured`,
    );
  }
  const lighthouse =
    settings.lighthouse && !signal.aborted
      ? await runLighthousePhase({ settings, routes, perfDirectory, logger, signal })
      : null;
  const crossBrowser = !signal.aborted
    ? await runCrossBrowserPhase({
        settings,
        routes,
        chromium: analysis.routes,
        perfDirectory,
        logger,
        signal,
      })
    : null;

  const stress =
    settings.stress.enabled && !signal.aborted
      ? await runStressPhase({
          settings,
          routes,
          apiOperations: api?.operations ?? [],
          perfDirectory,
          logger,
          signal,
        })
      : null;
  if (settings.exportK6) {
    const scenarios = buildScenarios(routes, {
      targetOrigin: settings.targetUrl.origin,
      includeAssets: settings.stress.includeAssets,
    });
    const apiCalls = apiScenario(api?.operations ?? [], { replay: settings.stress.replay });
    if (apiCalls.levels[0].length > 0) scenarios.push(apiCalls);
    if (scenarios.length > 0) {
      await mkdir(join(perfDirectory, 'stress'), { recursive: true });
      const k6Path = join(perfDirectory, 'stress', 'k6-script.js');
      await writeFile(k6Path, buildK6Script({ scenarios, settings }));
      logger.info(`k6 script: ${k6Path}`);
    } else {
      logger.warn('No route loaded successfully on the target origin; no k6 script was written.');
    }
  }

  const comparison = baseline
    ? compareRuns({
        current: { routes: analysis.routes, endpoints: analysis.endpoints },
        // An API run has no routes; comparing them would list every baseline route as missing.
        baseline: settings.mode === 'api' ? { ...baseline.summary, routes: [] } : baseline.summary,
        baselinePath: baseline.path,
      })
    : null;
  analysis.bottlenecks = sortFindings([
    ...analysis.bottlenecks,
    ...(stress?.findings ?? []),
    ...(navigation?.findings ?? []),
    ...(crossBrowser?.findings ?? []),
    ...(lighthouse?.findings ?? []),
    ...(verification ? repoVerificationFindings(verification) : []),
    ...(comparison ? regressionFindings(comparison) : []),
  ]);
  analysis.totals.findings = countBySeverity(analysis.bottlenecks);

  const summary = {
    schemaVersion: 1,
    tool: { name: BRAND.command, version: BRAND.version },
    target: settings.targetUrl.href,
    mode: settings.mode,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    interrupted: signal.aborted,
    settings: toReportableSettings(settings),
    totals: analysis.totals,
    routes: analysis.routes,
    endpoints: analysis.endpoints,
    bottlenecks: analysis.bottlenecks,
    stress: stress ? { ...stress.result, insights: stress.insights } : null,
    navigations: navigation?.navigations ?? null,
    browsers: crossBrowser?.browsers ?? null,
    lighthouse: lighthouse?.results ?? null,
    comparison,
    openapi: api?.plan
      ? {
          source: api.plan.source,
          title: api.plan.title,
          measured: api.plan.operations.length,
          skipped: api.plan.skipped,
        }
      : null,
    imports: api?.imports
      ? {
          sources: api.imports.sources,
          measured: api.imports.operations.length,
          skipped: api.imports.skipped,
        }
      : null,
    repo: repo
      ? {
          frameworks: repo.frameworks,
          pages: repo.pages.length,
          apis: repo.apis.length,
          skipped: repo.skipped,
          verification,
        }
      : null,
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
    settings.mode === 'api'
      ? `Measured ${analysis.endpoints.length} endpoint(s), ${settings.runs} run(s) each`
      : `Measured ${routes.length} route(s), ${analysis.endpoints.length} endpoint(s)` +
          (skippedText ? logger.paint.dim(` · skipped: ${skippedText}`) : ''),
  );
  if (comparison) {
    logger.info(
      `Compared with baseline: ${comparison.counts.regressions} regression(s), ${comparison.counts.improvements} improvement(s)` +
        logger.paint.dim(` · ${comparison.baseline.startedAt}`),
    );
  }
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
