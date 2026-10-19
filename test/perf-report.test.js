import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf report directory (fixture app, real Chromium)', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;
  /** @type {string} */
  let perfDir;
  /** @type {{ code: number, stdout: string, stderr: string }} */
  let result;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-report-'));
    result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/,/dashboard',
        '--runs',
        '1',
        '-H',
        'Authorization: Bearer super-secret-token',
        '--stress',
        '--stress-stages',
        '1,3',
        '--stress-duration',
        '1s',
        '--output-dir',
        'out',
      ],
      { cwd: workdir },
    );
    const [runName] = await readdir(join(workdir, 'out'));
    perfDir = join(workdir, 'out', runName, 'perf');
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  it('writes the organized directory of reports, data, and visuals', async () => {
    assert.equal(result.code, 0, result.stderr);
    const top = (await readdir(perfDir)).sort();
    assert.deepEqual(top, [
      'bottlenecks.json',
      'endpoints.csv',
      'endpoints.json',
      'index.html',
      'routes',
      'routes.csv',
      'routes.json',
      'settings.json',
      'stress',
      'summary.json',
      'summary.md',
    ]);
    assert.deepEqual((await readdir(join(perfDir, 'routes', 'dashboard'))).sort(), [
      'loads.json',
      'page.har',
      'screenshot.png',
      'trace.json',
      'trace.txt',
      'waterfall.svg',
    ]);
    assert.deepEqual((await readdir(join(perfDir, 'stress'))).sort(), [
      'hops.csv',
      'latency.svg',
      'stages.csv',
      'stress.json',
      'throughput.svg',
    ]);
    assert.match(result.stderr, /Report: .*index\.html/);
  });

  it('builds an HTML report with every section and inline charts', async () => {
    const html = await readFile(join(perfDir, 'index.html'), 'utf8');
    for (const id of [
      'summary',
      'bottlenecks',
      'routes',
      'endpoints',
      'stress',
      'method',
      'route-dashboard',
    ]) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.ok((html.match(/<svg class="viz"/g) ?? []).length >= 5, 'charts are inlined');
    assert.match(html, /src="routes\/dashboard\/screenshot\.png"/);
  });

  it('never writes the auth header or its value into any report file', async () => {
    const files = [
      'summary.json',
      'settings.json',
      'index.html',
      'summary.md',
      'routes/dashboard/page.har',
      'routes/dashboard/loads.json',
      'stress/stress.json',
    ];
    for (const file of files) {
      const text = await readFile(join(perfDir, file), 'utf8');
      assert.ok(!text.includes('super-secret-token'), `${file} leaked the token`);
    }
    const har = JSON.parse(
      await readFile(join(perfDir, 'routes', 'dashboard', 'page.har'), 'utf8'),
    );
    const authHeaders = har.log.entries.flatMap((/** @type {any} */ entry) =>
      entry.request.headers.filter(
        (/** @type {{ name: string }} */ h) => h.name.toLowerCase() === 'authorization',
      ),
    );
    assert.ok(authHeaders.length > 0, 'the header was sent to the target origin');
    assert.ok(authHeaders.every((/** @type {{ value: string }} */ h) => h.value === '[redacted]'));
  });

  it('writes CSVs with headers and a Markdown summary', async () => {
    const routesCsv = await readFile(join(perfDir, 'routes.csv'), 'utf8');
    assert.match(routesCsv, /^route,url,status,/);
    assert.equal(routesCsv.trim().split('\r\n').length, 3);
    const stages = await readFile(join(perfDir, 'stress', 'stages.csv'), 'utf8');
    assert.match(
      stages,
      /^mode,load,concurrency,target_rate,achieved_rate,dropped,duration_ms,requests,/,
    );
    const markdown = await readFile(join(perfDir, 'summary.md'), 'utf8');
    assert.match(markdown, /## Bottlenecks/);
    assert.match(markdown, /## Stress test/);
  });

  it('writes standalone SVG charts', async () => {
    const svg = await readFile(join(perfDir, 'routes', 'dashboard', 'waterfall.svg'), 'utf8');
    assert.match(svg, /^<\?xml/);
    assert.match(svg, /◆ \/api\/slow/);
  });
});
