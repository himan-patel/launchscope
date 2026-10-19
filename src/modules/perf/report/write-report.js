import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { routeWaterfall, routeLabel, stressCharts } from './charts.js';
import { renderHtmlReport } from './html.js';
import { standaloneSvg } from './svg.js';
import { endpointsCsv, routesCsv, stressCsv, summaryMarkdown } from './tables.js';

/**
 * Writes the human-facing report files next to the JSON written during the run:
 *
 * ```
 * perf/
 *   index.html          visual report (open this)
 *   summary.md          Markdown summary for PRs and tickets
 *   routes.csv, endpoints.csv
 *   routes/<route>/waterfall.svg
 *   stress/stages.csv, stress/hops.csv, stress/latency.svg, stress/throughput.svg
 * ```
 *
 * @param {object} input
 * @param {string} input.perfDirectory
 * @param {any} input.summary
 * @param {Map<string, import('./html.js').RouteDetail>} input.details
 * @returns {Promise<{ html: string, markdown: string }>}
 */
export async function writeReport({ perfDirectory, summary, details }) {
  for (const [slug, detail] of details) {
    if (!detail.trace || !detail.load) continue;
    const route = summary.routes.find((/** @type {{ slug: string }} */ r) => r.slug === slug);
    const chart = routeWaterfall({
      routeLabel: routeLabel(route?.url ?? slug),
      trace: detail.trace,
      load: detail.load,
    });
    await writeFile(join(perfDirectory, 'routes', slug, 'waterfall.svg'), standaloneSvg(chart));
  }

  await writeFile(join(perfDirectory, 'routes.csv'), routesCsv(summary.routes));
  await writeFile(join(perfDirectory, 'endpoints.csv'), endpointsCsv(summary.endpoints));

  if (summary.stress) {
    const csv = stressCsv(summary.stress);
    await writeFile(join(perfDirectory, 'stress', 'stages.csv'), csv.stages);
    await writeFile(join(perfDirectory, 'stress', 'hops.csv'), csv.hops);
    const charts = stressCharts(summary.stress);
    if (charts) {
      await writeFile(join(perfDirectory, 'stress', 'latency.svg'), standaloneSvg(charts.latency));
      await writeFile(
        join(perfDirectory, 'stress', 'throughput.svg'),
        standaloneSvg(charts.throughput),
      );
      if (charts.errors) {
        await writeFile(join(perfDirectory, 'stress', 'errors.svg'), standaloneSvg(charts.errors));
      }
    }
  }

  const markdown = join(perfDirectory, 'summary.md');
  await writeFile(markdown, summaryMarkdown(summary));
  const html = join(perfDirectory, 'index.html');
  await writeFile(html, renderHtmlReport({ summary, details }));
  return { html, markdown };
}
