import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf --stress-replay', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-replay-'));
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  /** @param {string[]} extra */
  const run = (extra) =>
    runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/search',
        '--runs',
        '1',
        '--stress',
        '--stress-stages',
        '1,3',
        '--stress-duration',
        '1s',
        '--json',
        '-o',
        'out',
        ...extra,
      ],
      { cwd: workdir },
    );

  it('replays only GET requests by default', async () => {
    server.writes.length = 0;
    const result = await run([]);
    assert.equal(result.code, 0, result.stderr);
    const searches = server.writes.filter((write) => write.path === '/api/search');
    assert.equal(searches.length, 1, 'only the measured page load posted');
    const hops = JSON.parse(result.stdout).stress.stages[0].hops.map(
      (/** @type {{ label: string }} */ h) => h.label,
    );
    assert.deepEqual(hops, ['GET /search']);
  });

  it('replays allowlisted POSTs with their recorded body, and nothing else', async () => {
    server.writes.length = 0;
    const result = await run(['--stress-replay', '^/api/search$']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      /Replaying allowlisted writes with their recorded bodies: POST \/api\/search\. These can create data/,
    );

    const searches = server.writes.filter((write) => write.path === '/api/search');
    assert.ok(searches.length > 5, `search posts: ${searches.length}`);
    assert.ok(
      searches.every((write) => write.method === 'POST' && write.body === '{"q":"launch-shoes"}'),
    );
    const tracks = server.writes.filter((write) => write.path === '/api/track');
    assert.equal(tracks.length, 1, 'non-allowlisted POST only came from the measured load');

    const summary = JSON.parse(result.stdout);
    const hop = summary.stress.stages[1].hops.find(
      (/** @type {{ label: string }} */ h) => h.label === 'POST /api/search',
    );
    assert.ok(hop && hop.requests > 0 && hop.errors === 0);

    const [runName] = (await readdir(join(workdir, 'out'))).sort().reverse();
    const loads = await readFile(
      join(workdir, 'out', runName, 'perf', 'routes', 'search', 'loads.json'),
      'utf8',
    );
    assert.doesNotMatch(loads, /launch-shoes/, 'request bodies are never written to disk');
  });
});
