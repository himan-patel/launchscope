import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

describe('launchscope perf --trace-context', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-trace-'));
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  it('sends no traceparent by default', async () => {
    const result = await runCli(
      ['perf', server.origin, '--routes', '/about', '--runs', '1', '-o', 'off'],
      {
        cwd: workdir,
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(server.traceparents, []);
  });

  it('gives each page load its own trace and links it in the report', async () => {
    server.traceparents.length = 0;
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/dashboard',
        '--runs',
        '2',
        '--warm-runs',
        '1',
        '--trace-url',
        'https://tracing.example.com/trace/{traceId}',
        '--json',
        '-o',
        'on',
      ],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const traces = summary.routes[0].traces;
    assert.deepEqual(
      traces.map((/** @type {{ cache: string, run: number }} */ t) => `${t.cache}${t.run}`),
      ['cold1', 'cold2', 'warm1'],
    );
    const traceIds = new Set(traces.map((/** @type {{ traceId: string }} */ t) => t.traceId));
    assert.equal(traceIds.size, 3, 'one trace per load');

    const received = server.traceparents.map(({ path, traceparent }) => {
      const match = TRACEPARENT.exec(traceparent);
      assert.ok(match, traceparent);
      return { path, traceId: match[1], spanId: match[2] };
    });
    const apiCalls = received.filter((entry) => entry.path.startsWith('/api/'));
    assert.ok(apiCalls.length > 0, 'API calls carried traceparent');
    // Requests from the measured loads carry one of the reported trace IDs (the unrecorded warm
    // priming load gets its own trace, which is not reported).
    const reported = received.filter((entry) => traceIds.has(entry.traceId));
    assert.ok(reported.some((entry) => entry.path === '/dashboard'));
    assert.ok(reported.some((entry) => entry.path === '/api/slow'));
    const spans = new Set(received.map((entry) => entry.spanId));
    assert.equal(spans.size, received.length, 'each request has its own span ID');

    const [runName] = await readdir(join(workdir, 'on'));
    const html = await readFile(join(workdir, 'on', runName, 'perf', 'index.html'), 'utf8');
    for (const traceId of traceIds) {
      assert.ok(html.includes(`https://tracing.example.com/trace/${traceId}`), traceId);
    }
  });

  it('rejects a trace URL template without {traceId}', async () => {
    const result = await runCli(
      ['perf', server.origin, '--trace-url', 'https://tracing.example.com/trace', '--dry-run'],
      { cwd: workdir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--trace-url must be an http\(s\) URL containing \{traceId\}/);
  });
});
