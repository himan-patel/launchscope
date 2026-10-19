import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf --stress', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-stress-'));
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  it('refuses public targets before doing any work', async () => {
    const result = await runCli(['perf', 'http://8.8.8.8', '--stress', '--dry-run'], {
      cwd: workdir,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Refusing to stress test 8\.8\.8\.8/);
    assert.match(result.stderr, /--allow-remote/);
  });

  it('allows a public target only with --allow-remote, with a warning', async () => {
    const result = await runCli(
      ['perf', 'http://8.8.8.8', '--stress', '--allow-remote', '--dry-run'],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Stress testing a public host/);
  });

  it('replays the dashboard under load, finds the knee, and names the slow hop', async () => {
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/dashboard',
        '--runs',
        '1',
        '--stress',
        '--stress-stages',
        '1,12',
        '--stress-duration',
        '2s',
        '--json',
        '--output-dir',
        'out',
      ],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Stress test · 1 route scenario\(s\)/);

    const summary = JSON.parse(result.stdout);
    const { stress } = summary;
    assert.deepEqual(
      stress.stages.map((/** @type {{ concurrency: number }} */ stage) => stage.concurrency),
      [1, 12],
    );
    const [one, twelve] = stress.stages;
    assert.ok(one.requests > 0 && twelve.requests > one.requests);
    assert.equal(one.errors + twelve.errors, 0);

    const hopLabels = twelve.hops.map((/** @type {{ label: string }} */ hop) => hop.label).sort();
    assert.deepEqual(hopLabels, [
      'GET /api/items/:id',
      'GET /api/me',
      'GET /api/projects',
      'GET /api/slow',
      'GET /dashboard',
    ]);

    assert.equal(stress.insights.knee?.concurrency, 12);
    assert.equal(stress.insights.knee?.hop?.label, 'GET /api/slow');
    const knee = summary.bottlenecks.find(
      (/** @type {{ rule: string }} */ f) => f.rule === 'stress-knee',
    );
    assert.ok(knee, 'stress-knee finding');

    const [runName] = await readdir(join(workdir, 'out'));
    const onDisk = JSON.parse(
      await readFile(join(workdir, 'out', runName, 'perf', 'stress', 'stress.json'), 'utf8'),
    );
    assert.deepEqual(onDisk.insights, stress.insights);
    assert.ok((server.hits.get('/logout') ?? 0) === 0);
  });
});
