import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf --lighthouse', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-lighthouse-'));
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  it('audits each measured route and links the Lighthouse report', async () => {
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/about,/dashboard',
        '--runs',
        '1',
        '--device',
        'desktop',
        '--lighthouse',
        '--json',
        '-o',
        'out',
      ],
      { cwd: workdir, timeout: 240_000 },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Lighthouse · 2 route\(s\), desktop preset/);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.lighthouse.length, 2);
    for (const entry of summary.lighthouse) {
      assert.equal(entry.error, null, entry.error ?? '');
      assert.ok(entry.score >= 0 && entry.score <= 1, `score ${entry.score}`);
      assert.ok(entry.metrics.lcpMs > 0);
    }
    const [runName] = await readdir(join(workdir, 'out'));
    const perfDir = join(workdir, 'out', runName, 'perf');
    assert.ok((await stat(join(perfDir, 'routes', 'about', 'lighthouse.html'))).size > 10_000);
    const html = await readFile(join(perfDir, 'index.html'), 'utf8');
    assert.match(html, /id="lighthouse"/);
    assert.match(html, /href="routes\/about\/lighthouse\.html"/);
  });
});
