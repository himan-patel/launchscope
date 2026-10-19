import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';

const BIN = fileURLToPath(new URL('../bin/launchscope.js', import.meta.url));

describe('launchscope perf interruption', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-interrupt-'));
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  /**
   * Starts a run, sends `signal` once the first route is reported, and resolves on exit.
   *
   * @param {NodeJS.Signals} signal
   * @param {string} outDir
   * @returns {Promise<{ code: number | null, stderr: string }>}
   */
  const runAndInterrupt = (signal, outDir) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          BIN,
          'perf',
          server.origin,
          '--routes',
          '/,/about,/dashboard,/deep,/deeper',
          '--runs',
          '3',
          '--output-dir',
          outDir,
        ],
        {
          cwd: workdir,
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1' },
        },
      );
      let stderr = '';
      let sent = false;
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (!sent && /✔ \/ {2}200/.test(stderr)) {
          sent = true;
          child.kill(signal);
        }
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stderr }));
    });

  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    it(`stops on ${signal}, writes a partial report, and exits 130`, async () => {
      const outDir = `out-${signal}`;
      const { code, stderr } = await runAndInterrupt(signal, outDir);
      assert.equal(code, 130, stderr);
      assert.match(stderr, /Stopping… finishing up and writing a partial report/);
      assert.match(stderr, /Stopped early: \d+ route\(s\) were measured completely/);
      assert.match(stderr, /Interrupted\. The partial report above covers what was measured\./);

      const [runName] = await readdir(join(workdir, outDir));
      const perfDir = join(workdir, outDir, runName, 'perf');
      const summary = JSON.parse(await readFile(join(perfDir, 'summary.json'), 'utf8'));
      assert.equal(summary.interrupted, true);
      assert.ok(
        summary.routes.length >= 1 && summary.routes.length < 5,
        `${summary.routes.length} routes`,
      );
      assert.ok((await readdir(perfDir)).includes('index.html'));
    });
  }
});
