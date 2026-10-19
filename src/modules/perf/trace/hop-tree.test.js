import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTrace, pickRepresentativeLoad, renderTraceTree } from './hop-tree.js';

const ORIGIN = 'https://app.test';

/**
 * Builds a request record with sensible defaults.
 *
 * @param {Partial<import('../capture/network-recorder.js').RequestRecord> & { id: string, url: string }} fields
 * @returns {import('../capture/network-recorder.js').RequestRecord}
 */
function request(fields) {
  const startMs = fields.startMs ?? 0;
  const endMs = fields.endMs ?? startMs + 10;
  return {
    method: 'GET',
    resourceType: 'Other',
    isNavigation: false,
    initiator: { type: 'other', url: null, stackUrls: [], requestId: null },
    startMs,
    endMs,
    durationMs: endMs - startMs,
    responseStartMs: null,
    phases: null,
    status: 200,
    mimeType: null,
    protocol: 'h2',
    fromCache: false,
    fromServiceWorker: false,
    connectionReused: false,
    transferBytes: 100,
    bodyBytes: 100,
    headers: {},
    redirects: [],
    failure: null,
    pending: false,
    jsonShape: null,
    graphql: null,
    frameId: null,
    isMainFrame: true,
    streaming: false,
    ...fields,
  };
}

const parser = (/** @type {string} */ url) => ({
  type: 'parser',
  url,
  stackUrls: [],
  requestId: null,
});
const script = (/** @type {string[]} */ stackUrls) => ({
  type: 'script',
  url: stackUrls[0],
  stackUrls,
  requestId: null,
});

/** A dashboard: document → app.js → /api/me → /api/projects → (/api/slow ‖ /api/items). */
const DASHBOARD = [
  request({
    id: 'doc',
    url: `${ORIGIN}/dashboard`,
    resourceType: 'Document',
    isNavigation: true,
    startMs: 0,
    endMs: 50,
  }),
  request({
    id: 'js',
    url: `${ORIGIN}/app.js`,
    resourceType: 'Script',
    initiator: parser(`${ORIGIN}/dashboard`),
    startMs: 40,
    endMs: 90,
  }),
  request({
    id: 'font',
    url: 'https://fonts.cdn.test/inter.woff2',
    resourceType: 'Font',
    initiator: parser(`${ORIGIN}/dashboard`),
    startMs: 45,
    endMs: 70,
  }),
  request({
    id: 'me',
    url: `${ORIGIN}/api/me`,
    resourceType: 'Fetch',
    initiator: script([`${ORIGIN}/app.js`]),
    startMs: 100,
    endMs: 150,
  }),
  request({
    id: 'projects',
    url: `${ORIGIN}/api/projects`,
    resourceType: 'Fetch',
    initiator: script([`${ORIGIN}/app.js`]),
    startMs: 160,
    endMs: 400,
    headers: { 'server-timing': 'db;dur=200' },
  }),
  request({
    id: 'slow',
    url: `${ORIGIN}/api/slow`,
    resourceType: 'Fetch',
    initiator: script([`${ORIGIN}/app.js`]),
    startMs: 410,
    endMs: 700,
  }),
  request({
    id: 'items',
    url: `${ORIGIN}/api/items/1`,
    resourceType: 'Fetch',
    initiator: script([`${ORIGIN}/app.js`]),
    startMs: 411,
    endMs: 450,
  }),
  request({
    id: 'beacon',
    url: 'https://analytics.test/collect',
    resourceType: 'Ping',
    initiator: script([`${ORIGIN}/app.js`]),
    startMs: 420,
    endMs: 900,
  }),
];

describe('buildTrace', () => {
  const trace = buildTrace(DASHBOARD, `${ORIGIN}/dashboard`);
  const node = (/** @type {string} */ id) => {
    const found = trace.nodes.find((candidate) => candidate.id === id);
    assert.ok(found, id);
    return found;
  };

  it('roots the tree at the navigation request', () => {
    assert.equal(trace.rootId, 'doc');
    assert.equal(node('doc').parentId, null);
    assert.equal(node('doc').depth, 0);
  });

  it('links parser-initiated requests to the referencing document', () => {
    assert.equal(node('js').parentId, 'doc');
    assert.equal(node('font').parentId, 'doc');
    assert.equal(node('js').depth, 1);
  });

  it('links script-initiated requests to the script on the call stack', () => {
    assert.equal(node('me').parentId, 'js');
    assert.equal(node('projects').parentId, 'js');
    assert.equal(node('me').depth, 2);
    assert.deepEqual(node('js').childIds, ['me', 'projects', 'slow', 'items', 'beacon']);
  });

  it('marks third-party requests', () => {
    assert.equal(node('font').thirdParty, true);
    assert.equal(node('me').thirdParty, false);
  });

  it('infers API calls that waited for a previous API call', () => {
    assert.equal(node('me').dependsOnId, null);
    assert.equal(node('projects').dependsOnId, 'me');
    assert.equal(node('slow').dependsOnId, 'projects');
    assert.equal(node('items').dependsOnId, 'projects');
  });

  it('reports the longest sequential API chains first', () => {
    assert.deepEqual(trace.chains[0], {
      ids: ['me', 'projects', 'slow'],
      totalMs: 600,
      networkMs: 580,
      idleMs: 20,
    });
    assert.deepEqual(trace.chains[1].ids, ['me', 'projects', 'items']);
  });

  it('finds the critical path, ignoring beacons, through parents and dependencies', () => {
    const path = trace.criticalPath;
    assert.ok(path);
    assert.deepEqual(
      path.segments.map((segment) => [segment.id, segment.via]),
      [
        ['doc', 'root'],
        ['js', 'parent'],
        ['me', 'parent'],
        ['projects', 'dependsOn'],
        ['slow', 'dependsOn'],
      ],
    );
    assert.equal(path.totalMs, 700);
    assert.equal(path.segments[2].gapMs, 10, 'script ran 10 ms before calling /api/me');
  });

  it('parses Server-Timing onto nodes', () => {
    assert.deepEqual(node('projects').serverTiming, [
      { name: 'db', durationMs: 200, description: null },
    ]);
  });

  it('attaches requests to the root when the initiator is unknown', () => {
    const orphanTrace = buildTrace(
      [
        DASHBOARD[0],
        request({ id: 'x', url: `${ORIGIN}/x.png`, resourceType: 'Image', startMs: 60 }),
      ],
      `${ORIGIN}/dashboard`,
    );
    assert.equal(orphanTrace.nodes[1].parentId, 'doc');
  });

  it('resolves initiators that point at a redirected URL', () => {
    const redirected = buildTrace(
      [
        request({
          id: 'doc',
          url: `${ORIGIN}/new`,
          resourceType: 'Document',
          isNavigation: true,
          redirects: [{ url: `${ORIGIN}/old`, status: 301, startMs: 0, endMs: 5 }],
        }),
        request({
          id: 'css',
          url: `${ORIGIN}/a.css`,
          resourceType: 'Stylesheet',
          initiator: parser(`${ORIGIN}/old`),
          startMs: 20,
        }),
      ],
      `${ORIGIN}/old`,
    );
    assert.equal(redirected.nodes[1].parentId, 'doc');
    assert.equal(redirected.nodes[0].redirectCount, 1);
  });

  it('handles an empty load', () => {
    assert.deepEqual(buildTrace([], `${ORIGIN}/`), {
      rootId: null,
      nodes: [],
      chains: [],
      criticalPath: null,
    });
  });
});

describe('renderTraceTree', () => {
  it('draws the tree and marks the critical path', () => {
    const lines = renderTraceTree(buildTrace(DASHBOARD, `${ORIGIN}/dashboard`));
    assert.equal(lines[0], '/dashboard [Document 200] 50 ms ◆');
    assert.equal(lines[1], '├─ /app.js [Script 200] 50 ms ◆');
    assert.ok(lines.includes('│  ├─ /api/projects [Fetch 200] 240 ms (after previous API call) ◆'));
    assert.ok(lines.includes('└─ fonts.cdn.test/inter.woff2 [Font 200] 25 ms'));
  });

  it('limits output size', () => {
    const lines = renderTraceTree(buildTrace(DASHBOARD, `${ORIGIN}/dashboard`), { maxNodes: 3 });
    assert.equal(lines.length, 4);
    assert.equal(lines[3], '… 5 more requests');
  });
});

describe('pickRepresentativeLoad', () => {
  it('picks the median cold load, skipping failures and warm loads', () => {
    const loads = [
      { id: 'a', cache: 'cold', error: null, wallTimeMs: 900 },
      { id: 'b', cache: 'cold', error: null, wallTimeMs: 300 },
      { id: 'c', cache: 'cold', error: 'timeout', wallTimeMs: 50 },
      { id: 'd', cache: 'cold', error: null, wallTimeMs: 500 },
      { id: 'e', cache: 'warm', error: null, wallTimeMs: 100 },
    ];
    assert.equal(pickRepresentativeLoad(loads)?.id, 'd');
    assert.equal(pickRepresentativeLoad([]), null);
  });
});
