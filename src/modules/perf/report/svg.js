import { escapeHtml } from './escape.js';

/**
 * Dependency-free SVG charts for the report. Marks are styled through CSS classes so the same
 * markup works inline in the HTML report (which defines light and dark tokens) and as
 * standalone .svg files (which embed the same tokens).
 *
 * Palette: the validated reference categorical palette, assigned to resource types in a fixed
 * order (never cycled); "Other" is neutral gray. Every chart ships with a legend for two or
 * more series and a table view elsewhere in the report, because three light-mode hues sit
 * below 3:1 contrast and color must never carry identity alone.
 */

export const TYPE_GROUPS = /** @type {const} */ ([
  'Document',
  'Script',
  'Stylesheet',
  'API',
  'Image',
  'Font',
  'Other',
]);

/** @typedef {(typeof TYPE_GROUPS)[number]} TypeGroup */

const TYPE_CLASS = /** @type {Record<TypeGroup, string>} */ ({
  Document: 's1',
  Script: 's2',
  Stylesheet: 's3',
  API: 's4',
  Image: 's5',
  Font: 's6',
  Other: 'so',
});

/**
 * @param {string} resourceType CDP resource type.
 * @returns {TypeGroup}
 */
export function typeGroup(resourceType) {
  if (resourceType === 'Fetch' || resourceType === 'XHR' || resourceType === 'EventSource') {
    return 'API';
  }
  return /** @type {readonly string[]} */ (TYPE_GROUPS).includes(resourceType)
    ? /** @type {TypeGroup} */ (resourceType)
    : 'Other';
}

/** @param {TypeGroup} group */
export const typeClass = (group) => TYPE_CLASS[group];

/** Chart tokens and mark styles, shared by the HTML report and standalone SVG files. */
export const CHART_CSS = `
.viz { --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e; --ink-3:#77766f; --grid:#e6e5e0;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300; --so:#9a9992; }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .viz {
  --surface:#1a1a19; --ink:#f0efec; --ink-2:#c3c2b7; --ink-3:#9a9990; --grid:#33332f;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300; --so:#7d7c75; } }
:root[data-theme="dark"] .viz { --surface:#1a1a19; --ink:#f0efec; --ink-2:#c3c2b7; --ink-3:#9a9990; --grid:#33332f;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300; --so:#7d7c75; }
.viz text { font: 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--ink-2); }
.viz .t-strong { fill: var(--ink); font-weight: 600; }
.viz .t-muted { fill: var(--ink-3); font-size: 11px; }
.viz .grid { stroke: var(--grid); stroke-width: 1; }
.viz .marker-line { stroke: var(--ink-3); stroke-width: 1; }
.viz .s1 { fill: var(--s1); } .viz .s2 { fill: var(--s2); } .viz .s3 { fill: var(--s3); }
.viz .s4 { fill: var(--s4); } .viz .s5 { fill: var(--s5); } .viz .s6 { fill: var(--s6); } .viz .so { fill: var(--so); }
.viz .wait { opacity: 0.4; }
.viz .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.viz .line.s1 { stroke: var(--s1); } .viz .line.s2 { stroke: var(--s2); } .viz .line.s3 { stroke: var(--s3); }
.viz .dot { stroke: var(--surface); stroke-width: 2; }
.viz .bg { fill: var(--surface); }
.viz [data-tip]:hover { opacity: 0.85; }
`;

const LABEL_CHAR_PX = 6.6;
const BAR = 10;

/**
 * Wraps chart markup in an accessible inline `<svg>`.
 *
 * @param {{ width: number, height: number, title: string, desc?: string, body: string }} chart
 * @returns {string}
 */
export function inlineSvg({ width, height, title, desc = '', body }) {
  const id = `c${Math.random().toString(36).slice(2, 9)}`;
  return (
    `<svg class="viz" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-labelledby="${id}t ${id}d" preserveAspectRatio="xMinYMin meet">` +
    `<title id="${id}t">${escapeHtml(title)}</title><desc id="${id}d">${escapeHtml(desc)}</desc>` +
    `<rect class="bg" width="${width}" height="${height}"/>${body}</svg>`
  );
}

/**
 * Same chart as a standalone .svg document with its own styles.
 *
 * @param {{ width: number, height: number, title: string, desc?: string, body: string }} chart
 * @returns {string}
 */
export function standaloneSvg(chart) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${inlineSvg(chart)
    .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
    .replace(' width="100%"', ` width="${chart.width}" height="${chart.height}"`)
    .replace('</desc>', `</desc><style>${CHART_CSS}</style>`)}\n`;
}

/**
 * @typedef {object} WaterfallRow
 * @property {string} label
 * @property {TypeGroup} group
 * @property {number} startMs
 * @property {number | null} responseStartMs
 * @property {number} endMs
 * @property {boolean} critical On the critical path (marked with ◆ and bold, not color alone).
 * @property {string} tip Full description for the tooltip.
 */

/**
 * Request waterfall: one row per request; the lighter part of a bar is waiting (queue, DNS,
 * connect, TLS, server), the solid part is downloading. Vertical hairlines mark paint events.
 *
 * @param {{ rows: WaterfallRow[], markers: Array<{ label: string, atMs: number }>, width?: number, title: string }} options
 * @returns {{ width: number, height: number, title: string, desc: string, body: string }}
 */
export function waterfallChart({ rows, markers, width = 960, title }) {
  const labelWidth = 260;
  const rowHeight = 18;
  const top = 34;
  const plotLeft = labelWidth + 8;
  const plotWidth = width - plotLeft - 56;
  const maxMs = niceMax(
    Math.max(1, ...rows.map((row) => row.endMs), ...markers.map((marker) => marker.atMs)),
  );
  const x = (/** @type {number} */ ms) => plotLeft + (ms / maxMs) * plotWidth;
  const height = top + rows.length * rowHeight + 28;
  const parts = [];

  for (const tick of ticks(maxMs)) {
    parts.push(
      `<line class="grid" x1="${x(tick)}" x2="${x(tick)}" y1="${top - 6}" y2="${height - 24}"/>`,
      `<text class="t-muted" x="${x(tick)}" y="${height - 8}" text-anchor="middle">${escapeHtml(formatMs(tick))}</text>`,
    );
  }

  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    const label = truncate(`${row.critical ? '◆ ' : ''}${row.label}`, labelWidth);
    parts.push(
      `<text x="${labelWidth}" y="${y + 12}" text-anchor="end"${row.critical ? ' class="t-strong"' : ''}>${escapeHtml(label)}</text>`,
    );
    const cls = typeClass(row.group);
    const start = x(row.startMs);
    const end = Math.max(start + 2, x(row.endMs));
    const split =
      row.responseStartMs !== null ? Math.min(end, Math.max(start, x(row.responseStartMs))) : start;
    const barY = y + (rowHeight - BAR) / 2;
    const tip = escapeHtml(row.tip);
    parts.push(`<g data-tip="${tip}"><title>${tip}</title>`);
    if (split > start) {
      parts.push(
        `<rect class="${cls} wait" x="${start}" y="${barY}" width="${split - start}" height="${BAR}" rx="2"/>`,
      );
    }
    parts.push(
      `<rect class="${cls}" x="${split}" y="${barY}" width="${Math.max(2, end - split)}" height="${BAR}" rx="2"/>`,
      `<rect fill="transparent" x="${plotLeft}" y="${y}" width="${plotWidth}" height="${rowHeight}"/></g>`,
    );
  });

  markers.forEach((marker, index) => {
    const mx = x(marker.atMs);
    parts.push(
      `<line class="marker-line" x1="${mx}" x2="${mx}" y1="${top - 6}" y2="${height - 24}"/>`,
      `<text class="t-muted" x="${mx + 3}" y="${12 + (index % 2) * 13}">${escapeHtml(`${marker.label} ${formatMs(marker.atMs)}`)}</text>`,
    );
  });

  const groups = TYPE_GROUPS.filter((group) => rows.some((row) => row.group === group));
  parts.push(
    legend(
      groups.map((group) => ({ label: group, cls: typeClass(group) })),
      plotLeft + 220,
      4,
    ),
  );

  return {
    width,
    height,
    title,
    desc: `Request waterfall with ${rows.length} requests over ${formatMs(maxMs)}. Lighter segments are waiting, solid segments are downloading; ◆ marks the critical path.`,
    body: parts.join(''),
  };
}

/**
 * @typedef {object} BarSeries
 * @property {string} key
 * @property {string} label
 * @property {string} cls
 */

/**
 * Horizontal grouped bars (one row per item, one bar per series).
 *
 * @param {{ rows: Array<{ label: string, values: Record<string, number | null>, tip: string }>, series: BarSeries[], format: (value: number) => string, title: string, width?: number }} options
 * @returns {{ width: number, height: number, title: string, desc: string, body: string }}
 */
export function groupedBarChart({ rows, series, format, title, width = 960 }) {
  const labelWidth = 300;
  const groupGap = 12;
  const rowHeight = series.length * (BAR + 2) - 2 + groupGap;
  const top = 30;
  const plotLeft = labelWidth + 8;
  const plotWidth = width - plotLeft - 80;
  const maxValue = niceMax(
    Math.max(1, ...rows.flatMap((row) => series.map((s) => row.values[s.key] ?? 0))),
  );
  const x = (/** @type {number} */ value) => plotLeft + (value / maxValue) * plotWidth;
  const height = top + rows.length * rowHeight + 24;
  const parts = [];

  for (const tick of ticks(maxValue)) {
    parts.push(
      `<line class="grid" x1="${x(tick)}" x2="${x(tick)}" y1="${top - 4}" y2="${height - 22}"/>`,
      `<text class="t-muted" x="${x(tick)}" y="${height - 6}" text-anchor="middle">${escapeHtml(format(tick))}</text>`,
    );
  }

  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    const tip = escapeHtml(row.tip);
    parts.push(
      `<text x="${labelWidth}" y="${y + (rowHeight - groupGap) / 2 + 4}" text-anchor="end">${escapeHtml(truncate(row.label, labelWidth))}</text>`,
      `<g data-tip="${tip}"><title>${tip}</title>`,
    );
    series.forEach((s, seriesIndex) => {
      const value = row.values[s.key];
      if (value === null || value === undefined) return;
      const barY = y + seriesIndex * (BAR + 2);
      parts.push(roundedBar(s.cls, plotLeft, barY, Math.max(2, x(value) - plotLeft)));
      if (seriesIndex === series.length - 1) {
        parts.push(
          `<text x="${x(value) + 6}" y="${barY + BAR - 1}">${escapeHtml(format(value))}</text>`,
        );
      }
    });
    parts.push(
      `<rect fill="transparent" x="${plotLeft}" y="${y}" width="${plotWidth}" height="${rowHeight - groupGap}"/></g>`,
    );
  });
  if (series.length > 1) parts.push(legend(series, plotLeft, 6));

  return {
    width,
    height,
    title,
    desc: `${title}. ${rows.length} rows; values are listed in the table below the chart.`,
    body: parts.join(''),
  };
}

/**
 * Horizontal stacked bars with a 2px surface gap between segments.
 *
 * @param {{ rows: Array<{ label: string, segments: Array<{ key: string, value: number }>, tip: string }>, series: BarSeries[], format: (value: number) => string, title: string, width?: number }} options
 * @returns {{ width: number, height: number, title: string, desc: string, body: string }}
 */
export function stackedBarChart({ rows, series, format, title, width = 960 }) {
  const labelWidth = 220;
  const rowHeight = 26;
  const top = 30;
  const plotLeft = labelWidth + 8;
  const plotWidth = width - plotLeft - 90;
  const totals = rows.map((row) => row.segments.reduce((sum, segment) => sum + segment.value, 0));
  const maxValue = niceMax(Math.max(1, ...totals));
  const scale = (/** @type {number} */ value) => (value / maxValue) * plotWidth;
  const height = top + rows.length * rowHeight + 24;
  const parts = [];

  for (const tick of ticks(maxValue)) {
    const tx = plotLeft + scale(tick);
    parts.push(
      `<line class="grid" x1="${tx}" x2="${tx}" y1="${top - 4}" y2="${height - 22}"/>`,
      `<text class="t-muted" x="${tx}" y="${height - 6}" text-anchor="middle">${escapeHtml(format(tick))}</text>`,
    );
  }

  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    const barY = y + (rowHeight - BAR - 4) / 2;
    const tip = escapeHtml(row.tip);
    parts.push(
      `<text x="${labelWidth}" y="${barY + BAR - 1}" text-anchor="end">${escapeHtml(truncate(row.label, labelWidth))}</text>`,
      `<g data-tip="${tip}"><title>${tip}</title>`,
    );
    let cursor = plotLeft;
    const ordered = series
      .map((s) => ({ s, value: row.segments.find((segment) => segment.key === s.key)?.value ?? 0 }))
      .filter(({ value }) => value > 0);
    ordered.forEach(({ s, value }, segmentIndex) => {
      const segmentWidth = Math.max(1, scale(value) - (segmentIndex < ordered.length - 1 ? 2 : 0));
      parts.push(
        segmentIndex === ordered.length - 1
          ? roundedBar(s.cls, cursor, barY, segmentWidth)
          : `<rect class="${s.cls}" x="${cursor}" y="${barY}" width="${segmentWidth}" height="${BAR}"/>`,
      );
      cursor += scale(value);
    });
    parts.push(
      `<text x="${cursor + 6}" y="${barY + BAR - 1}">${escapeHtml(format(totals[index]))}</text>`,
      `<rect fill="transparent" x="${plotLeft}" y="${y}" width="${plotWidth}" height="${rowHeight}"/></g>`,
    );
  });
  parts.push(legend(series, plotLeft, 6));

  return {
    width,
    height,
    title,
    desc: `${title}. ${rows.length} rows; values are listed in the table below the chart.`,
    body: parts.join(''),
  };
}

/**
 * Line chart over ordinal x positions (e.g. stress stages), 2px lines with ringed 8px markers,
 * direct end labels (≤ 4 series) plus a legend.
 *
 * @param {{ xLabels: string[], xTitle: string, series: Array<BarSeries & { values: Array<number | null> }>, format: (value: number) => string, title: string, width?: number, height?: number }} options
 * @returns {{ width: number, height: number, title: string, desc: string, body: string }}
 */
export function lineChart({ xLabels, xTitle, series, format, title, width = 640, height = 300 }) {
  const left = 64;
  const right = series.length > 1 ? 90 : 30;
  const top = 34;
  const bottom = 46;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = niceMax(
    Math.max(1, ...series.flatMap((s) => s.values.filter((value) => value !== null))),
  );
  const x = (/** @type {number} */ index) =>
    left + (xLabels.length === 1 ? plotWidth / 2 : (index / (xLabels.length - 1)) * plotWidth);
  const y = (/** @type {number} */ value) => top + plotHeight - (value / maxValue) * plotHeight;
  const parts = [];

  for (const tick of ticks(maxValue)) {
    parts.push(
      `<line class="grid" x1="${left}" x2="${left + plotWidth}" y1="${y(tick)}" y2="${y(tick)}"/>`,
      `<text class="t-muted" x="${left - 8}" y="${y(tick) + 4}" text-anchor="end">${escapeHtml(format(tick))}</text>`,
    );
  }
  xLabels.forEach((label, index) => {
    parts.push(
      `<text class="t-muted" x="${x(index)}" y="${top + plotHeight + 18}" text-anchor="middle">${escapeHtml(label)}</text>`,
    );
  });
  parts.push(
    `<text class="t-muted" x="${left + plotWidth / 2}" y="${height - 6}" text-anchor="middle">${escapeHtml(xTitle)}</text>`,
  );

  /** @type {number[]} */
  const endLabelYs = [];
  for (const s of series) {
    const points = s.values
      .map((value, index) => (value === null ? null : { px: x(index), py: y(value), value, index }))
      .filter((point) => point !== null);
    if (points.length === 0) continue;
    parts.push(
      `<polyline class="line ${s.cls}" points="${points.map((point) => `${point.px},${point.py}`).join(' ')}"/>`,
    );
    for (const point of points) {
      const tip = escapeHtml(
        `${s.label} at ${xLabels[point.index]} ${xTitle}: ${format(point.value)}`,
      );
      parts.push(
        `<g data-tip="${tip}"><title>${tip}</title><circle class="${s.cls} dot" cx="${point.px}" cy="${point.py}" r="4"/>` +
          `<circle fill="transparent" cx="${point.px}" cy="${point.py}" r="12"/></g>`,
      );
    }
    if (series.length > 1 && series.length <= 4) {
      const last = points[points.length - 1];
      // Converging lines would stack labels on top of each other; the legend covers those.
      if (endLabelYs.every((labelY) => Math.abs(labelY - last.py) >= 14)) {
        endLabelYs.push(last.py);
        parts.push(`<text x="${last.px + 10}" y="${last.py + 4}">${escapeHtml(s.label)}</text>`);
      }
    }
  }
  if (series.length > 1) parts.push(legend(series, left, 6));

  return {
    width,
    height,
    title,
    desc: `${title}. Values for each ${xTitle} are listed in the table next to the chart.`,
    body: parts.join(''),
  };
}

/**
 * @param {Array<{ label: string, cls: string }>} items
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
function legend(items, x, y) {
  let cursor = x;
  return items
    .map((item) => {
      const markup =
        `<rect class="${item.cls}" x="${cursor}" y="${y + 2}" width="10" height="10" rx="2"/>` +
        `<text x="${cursor + 14}" y="${y + 11}">${escapeHtml(item.label)}</text>`;
      cursor += 14 + item.label.length * LABEL_CHAR_PX + 16;
      return markup;
    })
    .join('');
}

/**
 * A bar with a 4px rounded data end and a square baseline.
 *
 * @param {string} cls
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @returns {string}
 */
function roundedBar(cls, x, y, width) {
  const r = Math.min(4, width / 2, BAR / 2);
  return `<path class="${cls}" d="M${x},${y}h${width - r}a${r},${r} 0 0 1 ${r},${r}v${BAR - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(width - r)}z"/>`;
}

/**
 * Rounds a maximum up to the next "nice" value (1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8 × 10ⁿ), each
 * divisible into four clean quarter ticks, so the data fills most of the axis.
 *
 * @param {number} value
 * @returns {number}
 */
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) {
    if (value <= step * exponent) return step * exponent;
  }
  return 10 * exponent;
}

/**
 * @param {number} max
 * @returns {number[]}
 */
function ticks(max) {
  return [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * max);
}

/**
 * @param {string} text
 * @param {number} widthPx
 * @returns {string}
 */
function truncate(text, widthPx) {
  const maxChars = Math.floor(widthPx / LABEL_CHAR_PX);
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** @param {number} ms */
export function formatMs(ms) {
  if (ms >= 10_000) return `${Math.round(ms / 1000)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}
