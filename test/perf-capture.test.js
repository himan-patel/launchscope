import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createMeasurementContext, launchBrowser } from '../src/modules/perf/capture/browser.js';
import { capturePageLoad } from '../src/modules/perf/capture/page-capture.js';
import { resolvePerfSettings } from '../src/modules/perf/settings.js';
import { buildTrace } from '../src/modules/perf/trace/hop-tree.js';
import { startFixtureServer } from './fixtures/app-server.js';

/** @typedef {import('../src/modules/perf/capture/page-capture.js').PageLoad} PageLoad */

describe('capturePageLoad (real Chromium against the fixture app)', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let launched;

  before(async () => {
    server = await startFixtureServer();
    const settings = resolvePerfSettings({ target: server.origin, cli: {}, config: {}, cwd: '/' });
    launched = await launchBrowser(settings);
  });

  after(async () => {
    await launched?.browser.close();
    await server?.close();
  });

  /**
   * @param {string} path
   * @param {import('../src/modules/perf/settings.js').PerfCliOptions} [cli]
   */
  const capture = async (path, cli = {}) => {
    const settings = resolvePerfSettings({ target: server.origin, cli, config: {}, cwd: '/' });
    const context = await createMeasurementContext(launched.browser, launched.devices, settings);
    try {
      return await capturePageLoad({
        context,
        url: `${server.origin}${path}`,
        settings,
        cache: 'cold',
        run: 1,
        collectLinks: true,
        inspectJson: true,
        screenshot: true,
      });
    } finally {
      await context.close();
    }
  };

  /**
   * @param {PageLoad} load
   * @param {string} pathAndQuery
   */
  const findRequest = (load, pathAndQuery) => {
    const matches = load.requests.filter((request) => {
      const url = new URL(request.url);
      return `${url.pathname}${url.search}` === pathAndQuery;
    });
    assert.ok(matches.length > 0, `expected a request to ${pathAndQuery}`);
    return matches;
  };

  it('records the document, its subresources, and Web Vitals', async () => {
    const { load, screenshot } = await capture('/');
    assert.equal(load.error, null);
    assert.equal(load.status, 200);
    assert.equal(load.title, 'Fixture Home');
    assert.equal(load.networkIdle, true);

    const [document] = findRequest(load, '/');
    assert.equal(document.isNavigation, true);
    assert.equal(document.resourceType, 'Document');
    assert.equal(document.startMs, 0);
    assert.ok(document.phases, 'document has timing phases');
    assert.ok(document.transferBytes > 0);

    const [script] = findRequest(load, '/static/app.js');
    assert.equal(script.resourceType, 'Script');
    assert.equal(script.initiator.type, 'parser');
    assert.equal(script.initiator.url, `${server.origin}/`);
    assert.equal(script.headers['cache-control'], 'max-age=31536000');

    assert.ok(load.vitals, 'vitals collected');
    assert.ok((load.vitals?.ttfbMs ?? 0) > 0);
    assert.ok((load.vitals?.fcpMs ?? 0) > 0);
    assert.ok((load.vitals?.lcpMs ?? 0) > 0);
    assert.equal(typeof load.vitals?.cls, 'number');
    // The fixture page goes quiet right after loading, so TTI is observed and TBT is final.
    assert.equal(load.vitals?.tbtComplete, true);
    assert.ok((load.vitals?.ttiMs ?? 0) >= (load.vitals?.fcpMs ?? Infinity));
    assert.equal(typeof load.vitals?.tbtMs, 'number');

    assert.ok(screenshot && screenshot.length > 0, 'screenshot captured');
    assert.ok(load.links.includes(`${server.origin}/dashboard`));
  });

  it('captures API calls with script initiators, compressed and decoded sizes, and JSON shape', async () => {
    const { load } = await capture('/dashboard');

    const [projects] = findRequest(load, '/api/projects?owner=7');
    assert.equal(projects.resourceType, 'Fetch');
    assert.equal(projects.status, 200);
    assert.equal(projects.initiator.type, 'script');
    assert.ok(projects.initiator.stackUrls.includes(`${server.origin}/static/dashboard.js`));
    assert.ok(projects.bodyBytes > 200_000, `decoded body ${projects.bodyBytes}`);
    assert.deepEqual(projects.jsonShape, {
      rootType: 'array',
      largestArrayLength: 2000,
      keyCount: 10_000,
      depth: 3,
    });

    const [script] = findRequest(load, '/static/dashboard.js');
    assert.equal(script.headers['content-encoding'], 'gzip');
    assert.ok(script.bodyBytes > script.transferBytes - 400, 'decoded size reflects gzip');

    assert.equal(findRequest(load, '/api/me').length, 2, 'duplicate call recorded twice');

    const [slow] = findRequest(load, '/api/slow');
    assert.ok((slow.phases?.waitMs ?? 0) >= 200, `slow wait ${slow.phases?.waitMs}`);
    assert.equal(slow.headers['server-timing'], 'db;dur=230;desc="query", app;dur=15');
  });

  it('traces the dashboard hop tree, API chain, and critical path from a real load', async () => {
    const { load } = await capture('/dashboard');
    const trace = buildTrace(load.requests, load.finalUrl ?? `${server.origin}/dashboard`);
    const pathOf = (/** @type {string} */ id) => {
      const url = new URL(
        /** @type {{ url: string }} */ (trace.nodes.find((n) => n.id === id)).url,
      );
      return `${url.pathname}${url.search}`;
    };
    const byPath = (/** @type {string} */ path) =>
      trace.nodes.filter((node) => pathOf(node.id) === path);

    const [script] = byPath('/static/dashboard.js');
    assert.equal(script.parentId, trace.rootId);
    for (const api of ['/api/me', '/api/projects?owner=7', '/api/slow', '/api/items/42']) {
      for (const node of byPath(api)) assert.equal(node.parentId, script.id, api);
    }

    const [projects] = byPath('/api/projects?owner=7');
    assert.ok(projects.dependsOnId, 'projects waited for /api/me');
    assert.equal(pathOf(projects.dependsOnId), '/api/me');
    // The three parallel calls run in the continuation of the projects response, so all three
    // were observed as caused by it, never by the concurrently fired second /api/me.
    for (const api of ['/api/me', '/api/slow', '/api/items/42']) {
      const later = byPath(api).filter((node) => node.dependsOnId === projects.id);
      assert.equal(later.length, 1, `${api} caused by /api/projects`);
    }
    const [firstMe] = byPath('/api/me').filter((node) => node.dependsOnId === null);
    assert.ok(firstMe, 'the first /api/me was not caused by another request');
    const [slow] = byPath('/api/slow');
    assert.deepEqual(slow.serverTiming[0], { name: 'db', durationMs: 230, description: 'query' });

    assert.deepEqual(trace.chains[0].ids.map(pathOf), [
      '/api/me',
      '/api/projects?owner=7',
      '/api/slow',
    ]);
    const criticalPaths = trace.criticalPath?.segments.map((segment) => pathOf(segment.id)) ?? [];
    assert.deepEqual(criticalPaths.slice(0, 4), [
      '/dashboard',
      '/static/dashboard.js',
      '/api/me',
      '/api/projects?owner=7',
    ]);
    assert.equal(criticalPaths[criticalPaths.length - 1], '/api/slow');
  });

  it('observes causes through XMLHttpRequest handlers and ignores timers and independent calls', async () => {
    const { load } = await capture('/xhr');
    const trace = buildTrace(load.requests, load.finalUrl ?? `${server.origin}/xhr`);
    /** @param {string} path */
    const node = (path) => {
      const found = trace.nodes.find((n) => {
        const url = new URL(n.url);
        return `${url.pathname}${url.search}` === path;
      });
      assert.ok(found, `expected ${path}`);
      return found;
    };
    const me = node('/api/me');
    const projects = node('/api/projects?owner=7');
    const items = node('/api/items/42');
    const slow = node('/api/slow');
    assert.equal(me.dependsOnId, null);
    assert.equal(projects.dependsOnId, me.id, 'onloadend handler');
    assert.equal(items.dependsOnId, projects.id, 'addEventListener("load") handler');
    assert.equal(slow.dependsOnId, items.id, 'promise continuation of a readystatechange handler');
    assert.equal(node('/api/flags-independent').dependsOnId, null);
    assert.equal(node('/api/later').dependsOnId, null, 'a timer is not a dependency');
    assert.deepEqual(
      trace.chains[0].ids,
      [me.id, projects.id, items.id, slow.id],
      'longest observed chain',
    );
  });

  it('records redirect hops on the final request', async () => {
    const { load } = await capture('/old-about');
    const [document] = findRequest(load, '/about');
    assert.equal(document.redirects.length, 1);
    assert.equal(document.redirects[0].status, 301);
    assert.equal(new URL(document.redirects[0].url).pathname, '/old-about');
    assert.equal(load.finalUrl, `${server.origin}/about`);
  });

  it('reports navigation failures instead of throwing', async () => {
    const settings = resolvePerfSettings({
      target: 'http://127.0.0.1:9',
      cli: { timeout: '3s' },
      config: {},
      cwd: '/',
    });
    const context = await createMeasurementContext(launched.browser, launched.devices, settings);
    try {
      const { load } = await capturePageLoad({
        context,
        url: 'http://127.0.0.1:9/',
        settings,
        cache: 'cold',
        run: 1,
      });
      assert.match(load.error ?? '', /net::ERR_/);
      assert.equal(load.vitals, null);
    } finally {
      await context.close();
    }
  });

  it('sends extra headers to the target origin only', async () => {
    const { load } = await capture('/private', { header: ['Authorization: Bearer test-token'] });
    assert.equal(load.status, 200);
    assert.equal(load.title, 'Private');
  });

  it('emulates a mobile device', async () => {
    const { load } = await capture('/about', { device: 'mobile' });
    assert.equal(load.error, null);
    assert.ok(load.vitals);
  });
});
