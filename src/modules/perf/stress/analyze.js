import { formatDuration } from '../../../core/duration.js';
import { classify } from '../analyze/budgets.js';

/**
 * Reads a stress run like a capacity test:
 * - **knee**: the first stage where p95 latency at least doubles versus the first stage (and
 *   grows by 50 ms or more). The hop whose p95 grew the most at that stage is the likely
 *   bottleneck under load.
 * - **saturation**: the first stage where concurrency rose by 1.5× or more but throughput grew
 *   by less than 10%; adding users only adds queueing from there.
 * - **breaking point**: the first stage whose error rate crosses the warning budget.
 */

const KNEE_RATIO = 2;
const KNEE_MIN_GROWTH_MS = 50;
const SATURATION_CONCURRENCY_RATIO = 1.5;
const SATURATION_MAX_GAIN = 0.1;

/**
 * @typedef {object} StressInsights
 * @property {number | null} peakRequestsPerSecond
 * @property {number | null} peakAtConcurrency
 * @property {{ concurrency: number, p95Ms: number, baselineP95Ms: number, hop: { label: string, baselineP95Ms: number, p95Ms: number } | null } | null} knee
 * @property {{ concurrency: number, requestsPerSecond: number } | null} saturation
 * @property {{ concurrency: number, errorRate: number } | null} breakingPoint
 */

/**
 * @param {import('./runner.js').StressResult} result
 * @param {import('../analyze/budgets.js').Budgets} budgets
 * @returns {{ insights: StressInsights, findings: import('../analyze/bottlenecks.js').Finding[] }}
 */
export function analyzeStress(result, budgets) {
  const stages = result.stages.filter((stage) => stage.requests > 0);
  /** @type {StressInsights} */
  const insights = {
    peakRequestsPerSecond: null,
    peakAtConcurrency: null,
    knee: null,
    saturation: null,
    breakingPoint: null,
  };
  /** @type {import('../analyze/bottlenecks.js').Finding[]} */
  const findings = [];
  if (stages.length === 0) return { insights, findings };

  const peak = stages.reduce((best, stage) =>
    stage.requestsPerSecond > best.requestsPerSecond ? stage : best,
  );
  insights.peakRequestsPerSecond = peak.requestsPerSecond;
  insights.peakAtConcurrency = peak.concurrency;

  const baseline = stages[0];
  const baselineP95 = baseline.latencyMs?.p95;
  if (baselineP95 !== undefined) {
    for (const stage of stages.slice(1)) {
      const p95 = stage.latencyMs?.p95;
      if (p95 === undefined) continue;
      if (p95 >= baselineP95 * KNEE_RATIO && p95 - baselineP95 >= KNEE_MIN_GROWTH_MS) {
        insights.knee = {
          concurrency: stage.concurrency,
          p95Ms: p95,
          baselineP95Ms: baselineP95,
          hop: worstHop(baseline, stage),
        };
        break;
      }
    }
  }

  for (let index = 1; index < stages.length; index += 1) {
    const previous = stages[index - 1];
    const current = stages[index];
    const concurrencyRatio = current.concurrency / previous.concurrency;
    const gain =
      previous.requestsPerSecond > 0
        ? (current.requestsPerSecond - previous.requestsPerSecond) / previous.requestsPerSecond
        : 1;
    if (concurrencyRatio >= SATURATION_CONCURRENCY_RATIO && gain < SATURATION_MAX_GAIN) {
      insights.saturation = {
        concurrency: previous.concurrency,
        requestsPerSecond: previous.requestsPerSecond,
      };
      break;
    }
  }

  const breaking = stages.find((stage) => stage.errorRate >= budgets.stressErrorRate.warning);
  if (breaking) {
    insights.breakingPoint = { concurrency: breaking.concurrency, errorRate: breaking.errorRate };
  }

  const subject = {};
  const worstErrorStage = stages.reduce((worst, stage) =>
    stage.errorRate > worst.errorRate ? stage : worst,
  );
  const errorSeverity = result.stoppedReason?.startsWith('Error rate')
    ? 'critical'
    : classify(budgets.stressErrorRate, worstErrorStage.errorRate);
  if (errorSeverity) {
    findings.push({
      id: 'stress-errors',
      rule: 'stress-errors',
      severity: errorSeverity,
      category: 'stress',
      title: `Errors under load: ${(worstErrorStage.errorRate * 100).toFixed(1)}% at ${worstErrorStage.concurrency} concurrent users`,
      detail: `${worstErrorStage.errors} of ${worstErrorStage.requests} requests failed. ${worstErrorStage.errorSamples.slice(0, 3).join(' | ')}${result.stoppedReason ? ` ${result.stoppedReason}` : ''}`,
      recommendation:
        'Find the failing hop in the per-hop table; check connection pools, rate limits, timeouts, and server logs at this concurrency.',
      subject,
      evidence: {
        concurrency: worstErrorStage.concurrency,
        errorRate: worstErrorStage.errorRate,
        errors: worstErrorStage.errors,
      },
      impact: worstErrorStage.errorRate * 10_000,
    });
  }

  const lastStage = stages[stages.length - 1];
  const lastP95 = lastStage.latencyMs?.p95;
  const latencySeverity = classify(budgets.stressP95Ms, lastP95);
  if (latencySeverity && lastP95 !== undefined) {
    findings.push({
      id: 'stress-latency',
      rule: 'stress-latency',
      severity: latencySeverity,
      category: 'stress',
      title: `p95 latency reaches ${formatDuration(lastP95)} at ${lastStage.concurrency} concurrent users`,
      detail: `Up from ${formatDuration(baselineP95 ?? 0)} with ${baseline.concurrency} user(s).`,
      recommendation:
        'Profile the slowest hop under load; add caching, scale the bottleneck tier, or reduce work per request.',
      subject,
      evidence: { concurrency: lastStage.concurrency, p95Ms: lastP95 },
      impact: lastP95,
    });
  }

  if (insights.knee) {
    const { knee } = insights;
    findings.push({
      id: 'stress-knee',
      rule: 'stress-knee',
      severity: 'warning',
      category: 'stress',
      title: `Latency ${Math.round((knee.p95Ms / knee.baselineP95Ms) * 10) / 10}× higher at ${knee.concurrency} concurrent users${knee.hop ? `; ${knee.hop.label} degrades most` : ''}`,
      detail: `p95 went from ${formatDuration(knee.baselineP95Ms)} to ${formatDuration(knee.p95Ms)}.${knee.hop ? ` ${knee.hop.label}: p95 ${formatDuration(knee.hop.baselineP95Ms)} → ${formatDuration(knee.hop.p95Ms)}.` : ''}`,
      recommendation: knee.hop
        ? `Investigate ${knee.hop.label} first: look for limited worker or connection pools, locks, or queries that serialize under concurrency.`
        : 'Look for limited worker or connection pools, locks, or queries that serialize under concurrency.',
      subject: knee.hop ? { endpoint: knee.hop.label } : subject,
      evidence: {
        concurrency: knee.concurrency,
        p95Ms: knee.p95Ms,
        baselineP95Ms: knee.baselineP95Ms,
      },
      impact: knee.p95Ms - knee.baselineP95Ms,
    });
  }

  if (insights.saturation) {
    findings.push({
      id: 'stress-saturation',
      rule: 'stress-saturation',
      severity: 'info',
      category: 'stress',
      title: `Throughput plateaus around ${insights.saturation.requestsPerSecond} req/s from ${insights.saturation.concurrency} concurrent users`,
      detail: 'Adding users beyond this point increases latency instead of throughput.',
      recommendation:
        'Treat this as current capacity; scale out or remove the bottleneck before expecting more traffic.',
      subject,
      evidence: { ...insights.saturation },
      impact: insights.saturation.requestsPerSecond,
    });
  }

  return { insights, findings };
}

/**
 * @param {import('./runner.js').StageResult} baseline
 * @param {import('./runner.js').StageResult} stage
 * @returns {{ label: string, baselineP95Ms: number, p95Ms: number } | null}
 */
function worstHop(baseline, stage) {
  const before = new Map(baseline.hops.map((hop) => [hop.label, hop.latencyMs?.p95]));
  let worst = null;
  let worstGrowth = 0;
  for (const hop of stage.hops) {
    const p95 = hop.latencyMs?.p95;
    const baselineP95 = before.get(hop.label);
    if (p95 === undefined || baselineP95 === undefined) continue;
    const growth = p95 - baselineP95;
    if (growth > worstGrowth) {
      worstGrowth = growth;
      worst = { label: hop.label, baselineP95Ms: baselineP95, p95Ms: p95 };
    }
  }
  return worst;
}
