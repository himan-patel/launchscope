import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvCell, escapeHtml, toCsv } from './escape.js';
import { renderHtmlReport } from './html.js';
import { lineChart, niceMax, standaloneSvg, typeGroup } from './svg.js';
import { summaryMarkdown } from './tables.js';

describe('escapeHtml', () => {
  it('escapes markup and quotes', () => {
    assert.equal(
      escapeHtml(`<img src=x onerror="alert('x')">&`),
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    );
    assert.equal(escapeHtml(null), '');
  });
});

describe('csvCell', () => {
  it('quotes separators and neutralizes spreadsheet formulas', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell(-12.346), '-12.35');
    assert.equal(csvCell(null), '');
    assert.equal(toCsv(['a', 'b'], [[1, 'x']]), 'a,b\r\n1,x\r\n');
  });
});

describe('niceMax', () => {
  it('rounds up to a close, clean axis maximum', () => {
    assert.equal(niceMax(270), 300);
    assert.equal(niceMax(999), 1000);
    assert.equal(niceMax(1150), 1200);
    assert.equal(niceMax(0.07), 0.08);
    assert.equal(niceMax(0), 1);
  });
});

describe('typeGroup', () => {
  it('maps CDP resource types to chart groups', () => {
    assert.equal(typeGroup('Fetch'), 'API');
    assert.equal(typeGroup('XHR'), 'API');
    assert.equal(typeGroup('Stylesheet'), 'Stylesheet');
    assert.equal(typeGroup('Media'), 'Other');
  });
});

describe('lineChart', () => {
  it('drops end labels that would collide and keeps the legend', () => {
    const chart = lineChart({
      xLabels: ['1', '10'],
      xTitle: 'users',
      series: [
        { key: 'p95', label: 'p95', cls: 's2', values: [100, 900] },
        { key: 'p99', label: 'p99', cls: 's3', values: [110, 905] },
      ],
      format: (value) => `${value} ms`,
      title: 'Latency',
    });
    // Two legend entries plus one end label: the converging second end label is dropped.
    const labels = chart.body.match(/>p9\d<\/text>/g) ?? [];
    assert.equal(labels.length, 3);

    const apart = lineChart({
      xLabels: ['1', '10'],
      xTitle: 'users',
      series: [
        { key: 'p95', label: 'p95', cls: 's2', values: [100, 400] },
        { key: 'p99', label: 'p99', cls: 's3', values: [110, 905] },
      ],
      format: (value) => `${value} ms`,
      title: 'Latency',
    });
    assert.equal((apart.body.match(/>p9\d<\/text>/g) ?? []).length, 4);
    assert.match(
      chart.body,
      /<rect class="s3"[^>]*\/><text[^>]*>p99<\/text>/,
      'legend still lists p99',
    );
  });

  it('produces a standalone SVG document with embedded styles', () => {
    const svg = standaloneSvg(
      lineChart({
        xLabels: ['1'],
        xTitle: 'users',
        series: [{ key: 'rps', label: 'rps', cls: 's1', values: [5] }],
        format: String,
        title: 'Throughput <b>',
      }),
    );
    assert.match(
      svg,
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/,
    );
    assert.match(svg, /<style>/);
    assert.match(svg, /Throughput &lt;b&gt;/);
  });
});

describe('renderHtmlReport', () => {
  const hostile = `<script>alert(1)</script>`;
  const summary = {
    schemaVersion: 1,
    tool: { name: 'launchscope', version: '0.0.0' },
    target: 'https://app.test/',
    startedAt: '2026-10-19T00:00:00.000Z',
    finishedAt: '2026-10-19T00:01:00.000Z',
    settings: { runs: 1, warmRuns: 0, device: 'desktop', throttle: 'none' },
    totals: {
      routes: 1,
      failedRoutes: 0,
      pageLoads: 1,
      requests: 1,
      endpoints: 0,
      findings: { critical: 1, warning: 0, info: 0 },
    },
    routes: [
      {
        url: `https://app.test/?q=${encodeURIComponent(hostile)}`,
        slug: 'home',
        depth: 0,
        source: 'seed',
        title: hostile,
        status: 200,
        finalUrl: null,
        runs: { cold: 1, warm: 0, failed: 1 },
        error: hostile,
        metrics: {},
        warmMetrics: null,
        resourceTypes: [],
        thirdParty: { requests: 0, transferBytes: 0, origins: [] },
        consoleErrors: [],
        pageErrors: [],
        representativeRun: null,
      },
    ],
    endpoints: [],
    bottlenecks: [
      {
        id: 'x',
        rule: 'route-failed',
        severity: 'critical',
        category: 'errors',
        title: hostile,
        detail: hostile,
        recommendation: hostile,
        subject: { route: 'home', routeUrl: 'https://app.test/' },
        evidence: { error: hostile },
        impact: 1,
      },
    ],
    stress: null,
    skippedUrls: {},
  };

  it('escapes every value that comes from the measured site', () => {
    const html = renderHtmlReport({ summary, details: new Map() });
    assert.ok(!html.includes(hostile), 'raw script tag must not appear');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal((html.match(/<script>/g) ?? []).length, 1, 'only the report tooltip script');
  });

  it('is a complete, self-contained document with no external resources', () => {
    const html = renderHtmlReport({ summary, details: new Map() });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.doesNotMatch(html, /<(?:link|script)[^>]+(?:href|src)=["']https?:/);
  });

  it('renders a Markdown summary with escaped content', () => {
    const markdown = summaryMarkdown(summary);
    assert.match(markdown, /^# LaunchScope performance report: app\.test/);
    assert.ok(!markdown.includes('<script>'));
    assert.match(markdown, /🔴 \*\*critical\*\*/);
  });
});
