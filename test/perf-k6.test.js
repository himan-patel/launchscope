import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

const execFileAsync = promisify(execFile);

describe('launchscope perf --export-k6', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-k6-e2e-'));
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  it('writes a k6 script from the measured routes without running a stress test', async () => {
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/dashboard',
        '--runs',
        '1',
        '--export-k6',
        '-H',
        'X-Api-Key: k6-secret',
        '-o',
        'out',
      ],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /k6 script: .*stress[\\/]k6-script\.js/);

    const [runName] = await readdir(join(workdir, 'out'));
    const file = join(workdir, 'out', runName, 'perf', 'stress', 'k6-script.js');
    const script = await readFile(file, 'utf8');
    assert.doesNotMatch(script, /k6-secret/);
    assert.match(script, /LAUNCHSCOPE_HEADER_X_API_KEY/);
    for (const path of ['/dashboard', '/api/me', '/api/projects?owner=7', '/api/slow']) {
      assert.ok(script.includes(`"path": "${path}"`), path);
    }
    const copy = join(workdir, 'k6-script.mjs');
    await copyFile(file, copy);
    await execFileAsync(process.execPath, ['--check', copy]);
  });
});
