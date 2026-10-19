import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runCli } from './helpers/run-cli.js';

describe('launchscope doctor', () => {
  /** @type {string} */
  let workdir;

  before(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-doctor-'));
  });

  after(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('verifies the environment by launching browsers and loading Lighthouse', async () => {
    const result = await runCli(['doctor', '--json'], { cwd: workdir });
    assert.equal(result.code, 0, result.stderr);
    const checks = Object.fromEntries(
      JSON.parse(result.stdout).map((/** @type {{ name: string, status: string }} */ c) => [
        c.name,
        c.status,
      ]),
    );
    assert.deepEqual(checks, {
      'Node.js': 'ok',
      Playwright: 'ok',
      Chromium: 'ok',
      Firefox: 'ok',
      WebKit: 'ok',
      Lighthouse: 'ok',
      'Output directory': 'ok',
    });
  });

  it('prints a readable checklist', async () => {
    const result = await runCli(['doctor'], { cwd: workdir });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /LaunchScope doctor/);
    assert.match(result.stderr, /✔ Chromium +launches/);
  });
});
