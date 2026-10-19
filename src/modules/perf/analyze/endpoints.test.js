import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregateEndpoints, templatePath } from './endpoints.js';

/**
 * @param {Partial<import('../capture/network-recorder.js').RequestRecord> & { url: string }} fields
 * @returns {import('../capture/network-recorder.js').RequestRecord}
 */
function api(fields) {
  const durationMs = fields.durationMs ?? 100;
  return {
    id: Math.random().toString(36).slice(2),
    method: 'GET',
    resourceType: 'Fetch',
    isNavigation: false,
    initiator: { type: 'script', url: null, stackUrls: [], requestId: null },
    startMs: 0,
    endMs: durationMs,
    durationMs,
    responseStartMs: null,
    phases: {
      queueMs: 0,
      dnsMs: 0,
      connectMs: 0,
      tlsMs: 0,
      sendMs: 0,
      waitMs: durationMs * 0.8,
      downloadMs: durationMs * 0.2,
    },
    status: 200,
    mimeType: 'application/json',
    protocol: 'h2',
    fromCache: false,
    fromServiceWorker: false,
    connectionReused: true,
    transferBytes: 500,
    bodyBytes: 2000,
    headers: { 'content-type': 'application/json' },
    redirects: [],
    failure: null,
    pending: false,
    jsonShape: null,
    graphql: null,
    causedBy: null,
    frameId: null,
    isMainFrame: true,
    streaming: false,
    ...fields,
  };
}

describe('templatePath', () => {
  it('replaces identifiers with placeholders', () => {
    assert.equal(templatePath('/api/items/42'), '/api/items/:id');
    assert.equal(
      templatePath('/api/users/3f2b1c9a-5d4e-4f6a-9b8c-7d6e5f4a3b2c/orders'),
      '/api/users/:uuid/orders',
    );
    assert.equal(
      templatePath('/assets/9f86d081884c7d659a2feaa0c55ad015.js'),
      '/assets/9f86d081884c7d659a2feaa0c55ad015.js',
    );
    assert.equal(templatePath('/blobs/9f86d081884c7d65'), '/blobs/:hash');
    assert.equal(templatePath('/share/aZ3kP9qL2mN8xR4tV6wY1bC7'), '/share/:token');
    assert.equal(templatePath('/api/v2/projects'), '/api/v2/projects');
  });
});

describe('aggregateEndpoints', () => {
  const ORIGIN = 'https://app.test';
  const loads = [
    {
      routeSlug: 'dashboard',
      pageOrigin: ORIGIN,
      requests: [
        api({ url: `${ORIGIN}/api/items/1`, durationMs: 100 }),
        api({ url: `${ORIGIN}/api/items/2`, durationMs: 300 }),
        api({ url: `${ORIGIN}/api/me`, durationMs: 50 }),
        api({ url: `${ORIGIN}/api/me`, durationMs: 60 }),
        api({
          url: `${ORIGIN}/api/slow`,
          durationMs: 900,
          headers: { 'server-timing': 'db;dur=700, app;dur=50', 'content-encoding': 'br' },
        }),
        api({ url: 'https://cdn.test/lib.js', resourceType: 'Script' }),
        api({ url: 'https://analytics.test/collect', status: 503 }),
      ],
    },
    {
      routeSlug: 'home',
      pageOrigin: ORIGIN,
      requests: [
        api({
          url: `${ORIGIN}/api/items/3?expand=1`,
          durationMs: 200,
          jsonShape: { rootType: 'array', largestArrayLength: 1500, keyCount: 1, depth: 2 },
        }),
        api({
          url: `${ORIGIN}/api/me`,
          durationMs: 70,
          failure: { errorText: 'net::ERR_FAILED', canceled: false },
          status: null,
        }),
      ],
    },
  ];
  const endpoints = aggregateEndpoints(loads);
  const find = (/** @type {string} */ key) => {
    const endpoint = endpoints.find((candidate) => candidate.key === key);
    assert.ok(endpoint, key);
    return endpoint;
  };

  it('groups calls by method and path template across routes, ignoring assets', () => {
    const items = find(`GET ${ORIGIN}/api/items/:id`);
    assert.equal(items.calls, 3);
    assert.deepEqual(items.routes.sort(), ['dashboard', 'home']);
    assert.equal(items.durationMs?.p50, 200);
    assert.equal(items.largestJsonArray, 1500);
    assert.ok(!endpoints.some((endpoint) => endpoint.resourceType === 'Script'));
  });

  it('sorts by p95 duration, slowest first', () => {
    assert.equal(endpoints[0].key, `GET ${ORIGIN}/api/slow`);
  });

  it('counts identical calls within a single load and failures', () => {
    const me = find(`GET ${ORIGIN}/api/me`);
    assert.equal(me.maxIdenticalCallsPerLoad, 2);
    assert.equal(me.maxCallsPerLoad, 2);
    assert.equal(me.failures, 1);
    assert.equal(me.durationMs?.count, 2, 'failed calls are excluded from timing stats');
  });

  it('summarizes server timing and compression', () => {
    const slow = find(`GET ${ORIGIN}/api/slow`);
    assert.equal(slow.compressed, true);
    assert.deepEqual(slow.serverTiming, [
      { name: 'db', samples: 1, meanMs: 700, maxMs: 700 },
      { name: 'app', samples: 1, meanMs: 50, maxMs: 50 },
    ]);
    assert.equal(slow.waitMs?.p50, 720);
  });

  it('marks third-party endpoints and records status codes', () => {
    const collect = find('GET https://analytics.test/collect');
    assert.equal(collect.thirdParty, true);
    assert.deepEqual(collect.statusCounts, { 503: 1 });
    assert.equal(collect.failures, 1);
  });
});
