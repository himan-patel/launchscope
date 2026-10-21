import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createConnectionAgent, timedRequest } from './http-request.js';

describe('timedRequest', () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {string} */
  let origin;
  /** @type {Array<{ method: string, url: string, body: string, headers: import('node:http').IncomingHttpHeaders }>} */
  const received = [];

  before(async () => {
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body,
        headers: request.headers,
      });
      switch (request.url) {
        case '/json':
          await new Promise((resolve) => setTimeout(resolve, 30));
          response.writeHead(200, { 'content-type': 'application/json' });
          return response.end('{"ok":true}');
        case '/gzip':
          response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
          return response.end(gzipSync('hello '.repeat(100)));
        case '/moved':
          response.writeHead(302, { location: '/json' });
          return response.end();
        case '/see-other':
          response.writeHead(303, { location: '/json' });
          return response.end();
        case '/away':
          response.writeHead(302, { location: 'https://elsewhere.test/steal' });
          return response.end();
        case '/hang':
          return; // never answers
        default:
          response.writeHead(404);
          return response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  /**
   * @param {string} path
   * @param {Partial<Parameters<typeof timedRequest>[0]>} [options]
   */
  const call = (path, options = {}) =>
    timedRequest({
      url: `${origin}${path}`,
      headers: { 'x-test': '1' },
      timeoutMs: 5000,
      agent: options.agent ?? createConnectionAgent(origin),
      allowedOrigin: origin,
      ...options,
    });

  it('times a new connection, then reuses it on the same agent', async () => {
    const agent = createConnectionAgent(origin);
    try {
      const first = await call('/json', { agent });
      const second = await call('/json', { agent });
      assert.equal(first.status, 200);
      assert.equal(first.body.toString(), '{"ok":true}');
      assert.equal(first.reused, false);
      assert.equal(second.reused, true);
      assert.ok(first.phases.connectMs > 0, `connect ${first.phases.connectMs}`);
      assert.equal(second.phases.connectMs, 0);
      assert.equal(second.phases.dnsMs, 0);
      assert.ok(first.phases.waitMs >= 25, `wait ${first.phases.waitMs}`);
      assert.ok(first.durationMs >= first.phases.waitMs);
    } finally {
      agent.destroy();
    }
  });

  it('decodes compressed bodies and reports bytes on the wire', async () => {
    const response = await call('/gzip');
    assert.equal(response.body.toString(), 'hello '.repeat(100));
    assert.ok(response.transferBytes < response.body.length);
    assert.equal(received.at(-1)?.headers['accept-encoding'], 'gzip, deflate, br');
  });

  it('sends the method, body, and headers it is given', async () => {
    await call('/json', {
      method: 'POST',
      body: '{"q":1}',
      headers: { 'content-type': 'application/json' },
    });
    const request = received.at(-1);
    assert.equal(request?.method, 'POST');
    assert.equal(request?.body, '{"q":1}');
    assert.equal(request?.headers['content-type'], 'application/json');
  });

  it('follows same-origin redirects, turning a POST into a GET on 303', async () => {
    const moved = await call('/moved');
    assert.equal(moved.status, 200);
    assert.equal(moved.url, `${origin}/json`);
    assert.deepEqual(
      moved.redirects.map(({ url, status }) => ({ url, status })),
      [{ url: `${origin}/moved`, status: 302 }],
    );

    await call('/see-other', { method: 'POST', body: 'x' });
    const followed = received.at(-1);
    assert.equal(followed?.method, 'GET');
    assert.equal(followed?.body, '');
  });

  it('does not follow redirects to another origin', async () => {
    const away = await call('/away');
    assert.equal(away.status, 302);
    assert.equal(away.redirects.length, 0);
    assert.equal(away.url, `${origin}/away`);
  });

  it('times out', async () => {
    await assert.rejects(call('/hang', { timeoutMs: 100 }), { name: 'TimeoutError' });
  });
});
