import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runCli } from './helpers/run-cli.js';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

describe('launchscope CLI', () => {
  /** @type {string} */
  let workdir;

  before(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-cli-'));
  });

  after(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('prints the package version', async () => {
    const result = await runCli(['--version']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), version);
  });

  it('prints branded help with exit code 0', async () => {
    const result = await runCli(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /▲ launchscope v\d+\.\d+\.\d+/);
    assert.match(result.stdout, /Usage: launchscope \[options\] \[command\]/);
    assert.match(result.stdout, /modules \[options\]\s+list available and planned check modules/);
    assert.ok(!result.stdout.includes('\u001b['), 'NO_COLOR must strip ANSI codes');
  });

  it('exits with the usage code for an unknown command', async () => {
    const result = await runCli(['launch-rockets']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown command 'launch-rockets'/);
  });

  it('exits with the usage code for an unknown option', async () => {
    const result = await runCli(['modules', '--nope']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown option '--nope'/);
  });

  it('lists modules as a readable table on stderr, keeping stdout clean', async () => {
    const result = await runCli(['modules'], { cwd: workdir });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /perf\s+available\s+Trace every route/);
    assert.match(result.stderr, /security\s+planned/);
  });

  it('lists modules as JSON on stdout with --json', async () => {
    const result = await runCli(['modules', '--json'], { cwd: workdir });
    assert.equal(result.code, 0);
    const modules = JSON.parse(result.stdout);
    assert.ok(Array.isArray(modules));
    assert.deepEqual(modules[0], {
      id: 'perf',
      title: 'Performance',
      status: 'available',
      summary: modules[0].summary,
    });
  });

  it('prints only errors with --quiet', async () => {
    const result = await runCli(['--quiet', 'modules'], { cwd: workdir });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
  });

  it('rejects --quiet together with --verbose', async () => {
    const result = await runCli(['--quiet', '--verbose', 'modules'], { cwd: workdir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--quiet and --verbose cannot be used together/);
  });

  it('reports a missing explicit config file as a usage error', async () => {
    const result = await runCli(['--config', 'nope.json', 'modules'], { cwd: workdir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Could not read config file .*nope\.json/);
  });

  it('reports an invalid config file as a usage error', async () => {
    await writeFile(join(workdir, 'launchscope.config.json'), '{ not json', 'utf8');
    try {
      const result = await runCli(['modules'], { cwd: workdir });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /is not valid JSON/);
    } finally {
      await rm(join(workdir, 'launchscope.config.json'));
    }
  });
});
