import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf --browsers (real Firefox and WebKit)', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;
  /** @type {any} */
  let summary;
  /** @type {string} */
  let stderr;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-browsers-'));
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/about,/dashboard',
        '--runs',
        '1',
        '--browsers',
        'chromium,firefox,webkit',
        '--json',
        '-o',
        'out',
      ],
      { cwd: workdir, timeout: 240_000 },
    );
    assert.equal(result.code, 0, result.stderr);
    stderr = result.stderr;
    summary = JSON.parse(result.stdout);
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  it('loads every measured route in each extra browser', () => {
    assert.deepEqual(
      summary.browsers.map((/** @type {{ browser: string }} */ b) => b.browser),
      ['firefox', 'webkit'],
    );
    for (const entry of summary.browsers) {
      assert.deepEqual(
        entry.routes.map((/** @type {{ slug: string }} */ r) => r.slug),
        ['about', 'dashboard'],
      );
      const dashboard = entry.routes[1];
      assert.equal(dashboard.status, 200, entry.browser);
      assert.equal(dashboard.error, null);
      assert.ok(dashboard.metrics.loadMs.p50 > 0, `${entry.browser} load`);
      assert.ok(dashboard.metrics.requestCount.p50 >= 7, `${entry.browser} requests`);
      assert.ok(dashboard.metrics.transferBytes.p50 > 200_000, `${entry.browser} bytes`);
    }
    assert.match(stderr, /Firefox \d+/);
    assert.match(stderr, /WebKit \d+/);
  });

  it('reports paint metrics where the browser supports them', () => {
    const [firefox, webkit] = summary.browsers;
    assert.ok(firefox.routes[0].metrics.fcpMs?.p50 > 0);
    const webkitLcp = webkit.routes[0].metrics.lcpMs;
    assert.ok(webkitLcp === null || webkitLcp.p50 > 0, 'missing or positive, never zero');
  });

  it('writes browsers.json and a comparison section', async () => {
    const [runName] = await readdir(join(workdir, 'out'));
    const perfDir = join(workdir, 'out', runName, 'perf');
    const saved = JSON.parse(await readFile(join(perfDir, 'browsers.json'), 'utf8'));
    assert.equal(saved.length, 2);
    const html = await readFile(join(perfDir, 'index.html'), 'utf8');
    assert.match(html, /id="browsers"/);
    assert.match(html, /Firefox/);
    assert.match(html, /WebKit/);
  });
});
