import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf with WebSockets, event streams, and iframes', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;
  /** @type {any} */
  let summary;
  /** @type {string} */
  let perfDir;
  let elapsedMs = 0;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-realtime-'));
    const started = Date.now();
    const result = await runCli(
      ['perf', server.origin, '--routes', '/live', '--runs', '2', '--json', '--output-dir', 'out'],
      { cwd: workdir },
    );
    elapsedMs = Date.now() - started;
    assert.equal(result.code, 0, result.stderr);
    summary = JSON.parse(result.stdout);
    const [runName] = await readdir(join(workdir, 'out'));
    perfDir = join(workdir, 'out', runName, 'perf');
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  it('settles despite a never-ending event stream and an open WebSocket', async () => {
    const loads = JSON.parse(await readFile(join(perfDir, 'routes', 'live', 'loads.json'), 'utf8'));
    for (const load of loads) {
      assert.equal(load.networkIdle, true, 'streams must not block the idle check');
      assert.ok(load.wallTimeMs < 5000, `load took ${load.wallTimeMs} ms`);
    }
    assert.ok(elapsedMs < 30_000, `whole run took ${elapsedMs} ms`);
  });

  it('records WebSocket handshakes and frame counts without frame contents', async () => {
    const [route] = summary.routes;
    const sockets = route.realtime.websockets;
    const open = sockets.find((/** @type {{ url: string }} */ s) => s.url.endsWith('/ws'));
    assert.ok(open, 'open socket recorded');
    assert.equal(open.status, 101);
    assert.ok(open.framesReceived >= 1 && open.framesSent >= 1);
    assert.equal(open.bytesReceived, 7, 'size of "welcome"');
    const loads = await readFile(join(perfDir, 'routes', 'live', 'loads.json'), 'utf8');
    assert.doesNotMatch(loads, /welcome|subscribe/, 'frame payloads are not stored');
  });

  it('flags the rejected WebSocket', () => {
    const failed = summary.bottlenecks.filter(
      (/** @type {{ rule: string }} */ f) => f.rule === 'websocket-failed',
    );
    assert.equal(failed.length, 1);
    assert.match(failed[0].title, /ws-reject/);
  });

  it('treats the event stream as a stream, not a slow request', () => {
    const [route] = summary.routes;
    assert.equal(route.realtime.eventStreams.length, 1);
    assert.ok(route.realtime.eventStreams[0].url.endsWith('/events'));
    const events = summary.endpoints.find((/** @type {{ key: string }} */ e) =>
      e.key.endsWith('/events'),
    );
    assert.equal(events.streaming, true);
    assert.equal(events.durationMs, null, 'no timing statistics for streams');
    assert.ok(
      !summary.bottlenecks.some((/** @type {{ title: string }} */ f) => /\/events/.test(f.title)),
    );
  });

  it('counts iframe requests separately from the page', () => {
    const [route] = summary.routes;
    assert.equal(route.realtime.iframes.count, 1);
    assert.ok(route.realtime.iframes.requests >= 2, 'iframe document and its stylesheet');
  });

  it('shows live connections in the HTML report', async () => {
    const html = await readFile(join(perfDir, 'index.html'), 'utf8');
    assert.match(html, /Live connections and embedded frames/);
    assert.match(html, /WebSocket/);
    assert.match(html, /Event stream/);
  });
});
