import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf --baseline', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-baseline-e2e-'));
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  const run = (/** @type {string[]} */ extra) =>
    runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/dashboard',
        '--runs',
        '2',
        '--output-dir',
        'out',
        ...extra,
      ],
      { cwd: workdir },
    );

  it('warns and continues when there is no earlier run yet', async () => {
    const first = await run(['--baseline', 'latest']);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stderr, /No earlier completed run for this host was found/);
  });

  it('reports a regression against the latest earlier run and can fail CI on it', async () => {
    server.setSlowDelay(900);
    const second = await run(['--baseline', 'latest', '--json', '--fail-on', 'warning']);
    server.setSlowDelay(250);
    assert.equal(second.code, 1, second.stderr);
    assert.match(second.stderr, /Baseline .*summary\.json/);
    assert.match(second.stderr, /Compared with baseline: \d+ regression\(s\)/);

    const summary = JSON.parse(second.stdout);
    const slow = summary.comparison.endpoints.find(
      (/** @type {{ endpoint: string }} */ entry) => entry.endpoint === 'GET /api/slow',
    );
    const p95 = slow.changes.find(
      (/** @type {{ label: string }} */ change) => change.label === 'p95',
    );
    assert.equal(p95.verdict, 'regression');
    assert.ok(p95.after > p95.before + 500, `${p95.before} → ${p95.after}`);

    const regressions = summary.bottlenecks.filter(
      (/** @type {{ rule: string }} */ f) => f.rule === 'regression',
    );
    assert.ok(
      regressions.some((/** @type {{ title: string }} */ f) =>
        /GET \/api\/slow p95 regressed/.test(f.title),
      ),
    );

    const runs = (await readdir(join(workdir, 'out'))).sort();
    const latest = join(workdir, 'out', runs[runs.length - 1], 'perf');
    const html = await readFile(join(latest, 'index.html'), 'utf8');
    assert.match(html, /id="baseline"/);
    assert.match(html, /▲ /);
    const markdown = await readFile(join(latest, 'summary.md'), 'utf8');
    assert.match(markdown, /## Compared with baseline/);
  });

  it('rejects an invalid baseline path before measuring', async () => {
    const result = await runCli(['perf', server.origin, '--baseline', 'nope', '--dry-run'], {
      cwd: workdir,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /No LaunchScope summary found/);
  });
});
