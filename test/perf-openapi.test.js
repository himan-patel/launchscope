import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf --openapi', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;
  /** @type {any} */
  let summary;
  /** @type {string} */
  let perfDir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-openapi-'));
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/dashboard',
        '--runs',
        '2',
        '--openapi',
        'auto',
        '--stress',
        '--stress-stages',
        '1,2',
        '--stress-duration',
        '1s',
        '--json',
        '-o',
        'out',
      ],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      /API {6}4 GET operation\(s\) from http:\/\/127\.0\.0\.1:\d+\/openapi\.json · 3 skipped/,
    );
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

  it('measures endpoints no page calls and labels where each endpoint came from', () => {
    const unlinked = endpoint('/api/unlinked');
    assert.ok(unlinked, 'unlinked endpoint measured');
    assert.deepEqual(unlinked.discoveredBy, ['openapi']);
    assert.deepEqual(unlinked.routes, []);
    assert.equal(unlinked.calls, 4, 'a new and a reused connection per run');
    assert.ok(unlinked.durationMs.p50 >= 100, `p50 ${unlinked.durationMs.p50}`);
    assert.ok(unlinked.waitMs.p50 >= 100, 'server wait recorded from resource timing');

    assert.deepEqual(endpoint('/api/me').discoveredBy, ['openapi', 'page']);
    assert.deepEqual(endpoint('/api/items/:id').discoveredBy, ['openapi', 'page']);
  });

  it('calls only safe, fully specified GET operations', () => {
    assert.equal(server.hits.get('/api/orders'), undefined, 'POST operation never called');
    assert.equal(server.hits.get('/api/legacy'), undefined, 'deprecated operation never called');
    const skipped = summary.openapi.skipped
      .map((/** @type {{ path: string }} */ s) => s.path)
      .sort();
    assert.deepEqual(skipped, ['/api/legacy', '/api/orders', '/api/orders/{orderId}']);
  });

  it('includes the API operations in the stress test', () => {
    const hops = summary.stress.stages[0].hops.map((/** @type {{ label: string }} */ h) => h.label);
    assert.ok(hops.includes('GET /api/unlinked'), hops.join(', '));
  });

  it('writes openapi.json and shows the source in the report', async () => {
    const plan = JSON.parse(await readFile(join(perfDir, 'openapi.json'), 'utf8'));
    assert.equal(plan.title, 'Fixture API');
    assert.equal(plan.measured.length, 4);
    const html = await readFile(join(perfDir, 'index.html'), 'utf8');
    assert.match(html, /API spec only/);
    assert.match(html, /3 operation\(s\) not called/);
  });
});
