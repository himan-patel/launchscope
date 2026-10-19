import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf --stress-mode open', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-open-'));
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  it('drives a fixed arrival rate and finds where latency climbs', async () => {
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/dashboard',
        '--runs',
        '1',
        '--stress',
        '--stress-mode',
        'open',
        '--stress-rates',
        '2,24',
        '--stress-duration',
        '2s',
        '--json',
        '-o',
        'out',
      ],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /2\/s {2}/);
    assert.match(result.stderr, /24\/s {2}.*peak in flight \d+/);

    const { stress } = JSON.parse(result.stdout);
    assert.equal(stress.mode, 'open');
    const [low, high] = stress.stages;
    assert.equal(low.targetRate, 2);
    assert.equal(high.targetRate, 24);
    assert.ok(high.concurrency > low.concurrency, 'more replays in flight at the higher rate');
    assert.equal(stress.insights.knee?.concurrency, 24);
    assert.equal(stress.insights.knee?.hop?.label, 'GET /api/slow');

    const [runName] = await readdir(join(workdir, 'out'));
    const html = await readFile(join(workdir, 'out', runName, 'perf', 'index.html'), 'utf8');
    assert.match(html, /24 replays\/s/);
    assert.match(html, /replays per second/);
  });
});
