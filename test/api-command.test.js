import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope api', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;
  /** @type {{ code: number, stdout: string, stderr: string }} */
  let result;
  /** @type {any} */
  let summary;
  /** @type {string} */
  let perfDir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-api-'));
    result = await runCli(
      [
        'api',
        server.origin,
        '--endpoint',
        '/api/unlinked',
        '--endpoint',
        'GET /api/me',
        '--runs',
        '3',
        '--stress',
        '--stress-stages',
        '1,2',
        '--stress-duration',
        '1s',
        '--export-k6',
        '--json',
        '-o',
        'out',
      ],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    summary = JSON.parse(result.stdout);
    const [runName] = await readdir(join(workdir, 'out'));
    perfDir = join(workdir, 'out', runName, 'perf');
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  /** @param {string} path */
  const endpoint = (path) =>
    summary.endpoints.find(
      (/** @type {{ key: string }} */ e) => e.key === `GET ${server.origin}${path}`,
    );

  it('measures listed endpoints directly, without loading any page', () => {
    assert.equal(summary.mode, 'api');
    assert.deepEqual(summary.routes, []);
    assert.equal(server.hits.get('/'), undefined, 'no page was loaded');
    assert.equal(server.hits.get('/sitemap.xml'), undefined, 'no sitemap was read');
    assert.equal(server.hits.get('/openapi.json'), undefined, 'no spec lookup when listed');

    const unlinked = endpoint('/api/unlinked');
    assert.deepEqual(unlinked.discoveredBy, ['listed']);
    assert.equal(unlinked.calls, 6, 'a new and a reused connection per run');
    assert.equal(unlinked.newConnectionMs.count, 3);
    assert.equal(unlinked.reusedConnectionMs.count, 3);
    assert.ok(unlinked.durationMs.p50 >= 100, `p50 ${unlinked.durationMs.p50}`);
    assert.ok(unlinked.waitMs.p50 >= 100, 'server wait recorded');
    assert.deepEqual(endpoint('/api/me').discoveredBy, ['listed']);
    assert.match(result.stderr, /API {6}2 listed endpoint\(s\)\n/);
    assert.match(result.stderr, /Measured 2 endpoint\(s\), 3 run\(s\) each/);
  });

  it('stress tests and exports k6 for the listed endpoints', async () => {
    assert.equal(summary.stress.stages.length, 2);
    const k6 = await readFile(join(perfDir, 'stress', 'k6-script.js'), 'utf8');
    assert.match(k6, /\/api\/unlinked/);
    assert.match(k6, /\/api\/me/);
  });

  it('writes a report without page sections', async () => {
    const html = await readFile(join(perfDir, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /id="routes"/);
    assert.doesNotMatch(html, /Routes measured/);
    assert.match(html, /id="endpoints"/);
    assert.match(html, /listed only/);
    const markdown = await readFile(join(perfDir, 'summary.md'), 'utf8');
    assert.match(markdown, /2 endpoint\(s\), 3 call\(s\) each, no browser/);
    assert.doesNotMatch(markdown, /## Routes/);
  });

  it('finds the OpenAPI spec on its own when nothing is listed', async () => {
    const auto = await runCli(['api', server.origin, '--runs', '1', '--json', '-o', 'auto'], {
      cwd: workdir,
    });
    assert.equal(auto.code, 0, auto.stderr);
    const autoSummary = JSON.parse(auto.stdout);
    assert.equal(autoSummary.openapi.measured, 4);
    assert.ok(
      autoSummary.endpoints.some((/** @type {{ discoveredBy: string[] }} */ e) =>
        e.discoveredBy.includes('openapi'),
      ),
    );
  });

  it('compares only with earlier API runs', async () => {
    const second = await runCli(
      [
        'api',
        server.origin,
        '--endpoint',
        '/api/unlinked',
        '--runs',
        '1',
        '--baseline',
        'latest',
        '--json',
        '-o',
        'out',
      ],
      { cwd: workdir },
    );
    assert.equal(second.code, 0, second.stderr);
    const comparison = JSON.parse(second.stdout).comparison;
    assert.deepEqual(comparison.missingRoutes, []);
    assert.deepEqual(comparison.missingEndpoints, ['GET /api/me']);
  });

  it('fails clearly when there is nothing to measure', async () => {
    const nothing = await runCli(
      ['api', 'http://127.0.0.1:9', '--runs', '1', '--timeout', '1s', '-o', 'nothing'],
      { cwd: workdir },
    );
    assert.equal(nothing.code, 2, nothing.stderr);
    assert.match(nothing.stderr, /No API endpoints to measure/);
  });

  it('sends listed writes with their bodies, and replays them only when allowlisted', async () => {
    await writeFile(join(workdir, 'search.json'), '{"q":"shoes"}');
    const before = server.writes.length;
    const writes = await runCli(
      [
        'api',
        server.origin,
        '--endpoint',
        'POST /api/search @search.json',
        '--endpoint',
        'POST /api/track viewed=api',
        '--runs',
        '2',
        '--stress',
        '--stress-stages',
        '1',
        '--stress-duration',
        '1s',
        '--stress-replay',
        '^/api/search$',
        '--json',
        '-o',
        'writes',
      ],
      { cwd: workdir },
    );
    assert.equal(writes.code, 0, writes.stderr);
    assert.match(writes.stderr, /2 listed endpoint\(s\) · 2 write\(s\)/);
    assert.match(writes.stderr, /Sending listed writes 2 time\(s\) each/);
    assert.match(
      writes.stderr,
      /Replaying allowlisted writes with their recorded bodies: POST \/api\/search/,
    );

    const sent = server.writes.slice(before);
    const tracks = sent.filter((write) => write.path === '/api/track');
    assert.equal(tracks.length, 2, 'measured twice, never replayed under stress');
    assert.deepEqual(tracks[0], {
      method: 'POST',
      path: '/api/track',
      body: 'viewed=api',
      contentType: 'text/plain;charset=UTF-8',
    });
    const searches = sent.filter((write) => write.path === '/api/search');
    assert.ok(searches.length > 2, 'allowlisted write replayed under stress');
    assert.ok(searches.every((write) => write.body === '{"q":"shoes"}'));
    assert.equal(searches[0].contentType, 'application/json');

    const summary = JSON.parse(writes.stdout);
    const search = summary.endpoints.find(
      (/** @type {{ key: string }} */ e) => e.key === `POST ${server.origin}/api/search`,
    );
    assert.equal(search.calls, 2);
    assert.deepEqual(summary.settings.endpoints, [
      `POST ${server.origin}/api/search (with body)`,
      `POST ${server.origin}/api/track (with body)`,
    ]);
    const [runName] = await readdir(join(workdir, 'writes'));
    const files = await readdir(join(workdir, 'writes', runName, 'perf'), { recursive: true });
    for (const file of files.filter((name) => /\.(json|html|md|csv)$/.test(name))) {
      const text = await readFile(join(workdir, 'writes', runName, 'perf', file), 'utf8');
      assert.doesNotMatch(text, /shoes|viewed=api/, `${file} contains a request body`);
    }
  });

  it('never sends DELETE', async () => {
    const write = await runCli(['api', server.origin, '--endpoint', 'DELETE /api/orders/1'], {
      cwd: workdir,
    });
    assert.equal(write.code, 2);
    assert.match(write.stderr, /DELETE is not supported/);
    assert.equal(server.hits.get('/api/orders/1'), undefined);
  });
});

describe('launchscope perf --endpoint', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-perf-endpoint-'));
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  it('measures listed endpoints alongside the pages', async () => {
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/dashboard',
        '--runs',
        '1',
        '--endpoint',
        '/api/unlinked',
        '--endpoint',
        '/api/me',
        '--json',
      ],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, 'pages');
    /** @param {string} path */
    const find = (path) =>
      summary.endpoints.find(
        (/** @type {{ key: string }} */ e) => e.key === `GET ${server.origin}${path}`,
      );
    assert.deepEqual(find('/api/unlinked').discoveredBy, ['listed']);
    assert.deepEqual(find('/api/me').discoveredBy, ['listed', 'page']);
  });
});
