import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf (command surface)', () => {
  /** @type {string} */
  let workdir;

  before(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-perf-cmd-'));
  });

  after(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('documents its options in grouped help', async () => {
    const result = await runCli(['perf', '--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: launchscope perf \[options\] <target>/);
    for (const heading of ['Routes:', 'Measurement:', 'Authentication:', 'Stress testing:']) {
      assert.match(result.stdout, new RegExp(heading));
    }
  });

  it('requires a target', async () => {
    const result = await runCli(['perf']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /missing required argument 'target'/);
  });

  it('rejects an invalid target as a usage error', async () => {
    const result = await runCli(['perf', 'ftp://example.com'], { cwd: workdir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Unsupported protocol "ftp:"/);
  });

  it('rejects invalid option values before doing any work', async () => {
    const result = await runCli(['perf', 'http://localhost:9', '--runs', 'lots'], {
      cwd: workdir,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--runs must be a whole number/);
  });

  it('rejects choices commander knows about', async () => {
    const result = await runCli(['perf', 'http://localhost:9', '--device', 'watch'], {
      cwd: workdir,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Allowed choices are desktop, mobile/);
  });

  it('collects repeated --header options', async () => {
    const result = await runCli(
      ['perf', 'http://localhost:9', '-H', 'X-One: 1', '-H', 'Host: nope'],
      { cwd: workdir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /"host" header is managed by the browser/);
  });
});

describe('launchscope perf (run directory)', () => {
  /** @type {string} */
  let workdir;

  before(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-perf-dir-'));
  });

  after(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('writes redacted settings into <output>/<host>_<timestamp>/perf', async () => {
    const result = await runCli(
      [
        'perf',
        'http://127.0.0.1:9',
        '--output-dir',
        'out',
        '--routes',
        '/a,/b',
        '-H',
        'Authorization: Bearer top-secret',
        '--dry-run',
      ],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);

    const [runName] = await readdir(join(workdir, 'out'));
    assert.match(runName, /^127\.0\.0\.1-9_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z$/);
    const settingsText = await readFile(
      join(workdir, 'out', runName, 'perf', 'settings.json'),
      'utf8',
    );
    const settings = JSON.parse(settingsText);
    assert.deepEqual(settings.routes, ['http://127.0.0.1:9/a', 'http://127.0.0.1:9/b']);
    assert.deepEqual(settings.headers, { authorization: '[redacted]' });
    assert.doesNotMatch(settingsText, /top-secret/);
    assert.match(result.stderr, /Dry run: settings resolved/);
  });
});
