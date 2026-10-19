import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractLocs, normalizeRoute, readSitemap, RouteQueue } from './routes.js';

const TARGET = new URL('https://app.test/');

describe('normalizeRoute', () => {
  it('accepts same-origin pages and strips the hash', () => {
    assert.deepEqual(normalizeRoute('/pricing#plans', TARGET, []), {
      url: 'https://app.test/pricing',
    });
  });

  it('skips other origins, schemes, logout links, files, and excluded patterns', () => {
    assert.deepEqual(normalizeRoute('https://other.test/', TARGET, []), { skip: 'off-origin' });
    assert.deepEqual(normalizeRoute('mailto:hi@app.test', TARGET, []), { skip: 'invalid' });
    assert.deepEqual(normalizeRoute('/account/logout', TARGET, []), { skip: 'logout' });
    assert.deepEqual(normalizeRoute('/files/report.PDF', TARGET, []), { skip: 'not-a-page' });
    assert.deepEqual(normalizeRoute('/admin/users', TARGET, [/\/admin/i]), { skip: 'excluded' });
    assert.deepEqual(normalizeRoute('https://u:p@app.test/', TARGET, []), { skip: 'invalid' });
  });
});

describe('RouteQueue', () => {
  it('queues in breadth-first order and de-duplicates', () => {
    const queue = new RouteQueue({ targetUrl: TARGET, exclude: [], maxRoutes: 10 });
    assert.equal(queue.add('/', 0, 'seed'), true);
    assert.equal(queue.add('/a', 1, 'link'), true);
    assert.equal(queue.add('/a#top', 1, 'link'), false);
    assert.deepEqual(queue.next(), { url: 'https://app.test/', depth: 0, source: 'seed' });
    assert.deepEqual(queue.next(), { url: 'https://app.test/a', depth: 1, source: 'link' });
    assert.equal(queue.next(), undefined);
    assert.deepEqual(queue.skipped, { duplicate: 1 });
  });

  it('stops accepting routes at the limit', () => {
    const queue = new RouteQueue({ targetUrl: TARGET, exclude: [], maxRoutes: 2 });
    queue.add('/1', 0, 'seed');
    queue.add('/2', 0, 'seed');
    assert.equal(queue.add('/3', 0, 'seed'), false);
    assert.equal(queue.acceptedCount, 2);
    assert.deepEqual(queue.skipped, { limit: 1 });
  });

  it('caps query-string variants of the same path', () => {
    const queue = new RouteQueue({ targetUrl: TARGET, exclude: [], maxRoutes: 50 });
    const accepted = ['a', 'b', 'c', 'd', 'e'].map((q) => queue.add(`/search?q=${q}`, 1, 'link'));
    assert.deepEqual(accepted, [true, true, true, false, false]);
    assert.deepEqual(queue.skipped, { 'query-variants': 2 });
  });
});

describe('extractLocs', () => {
  it('reads <loc> entries and decodes XML entities', () => {
    const xml = `<urlset><url><loc> https://app.test/a?x=1&amp;y=2 </loc></url><url><loc>https://app.test/b</loc></url></urlset>`;
    assert.deepEqual(extractLocs(xml), ['https://app.test/a?x=1&y=2', 'https://app.test/b']);
  });
});

describe('readSitemap', () => {
  /**
   * @param {Record<string, { status?: number, body?: string }>} routes
   * @returns {{ fetchImpl: typeof fetch, calls: Array<{ url: string, headers: Record<string, string> }> }}
   */
  const fakeFetch = (routes) => {
    /** @type {Array<{ url: string, headers: Record<string, string> }>} */
    const calls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: /** @type {Record<string, string>} */ (init?.headers ?? {}) });
      const route = routes[url] ?? { status: 404 };
      return new Response(route.body ?? '', { status: route.status ?? 200 });
    };
    return { fetchImpl, calls };
  };

  it('returns URLs from a plain sitemap and sends configured headers', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://app.test/sitemap.xml': {
        body: '<urlset><url><loc>https://app.test/a</loc></url></urlset>',
      },
    });
    const result = await readSitemap({
      targetUrl: TARGET,
      headers: { authorization: 'Bearer t' },
      timeoutMs: 1000,
      fetchImpl,
    });
    assert.deepEqual(result, { urls: ['https://app.test/a'], error: null });
    assert.equal(calls[0].headers.authorization, 'Bearer t');
  });

  it('follows same-origin child sitemaps of a sitemap index only', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://app.test/sitemap.xml': {
        body: `<sitemapindex><sitemap><loc>https://app.test/s1.xml</loc></sitemap><sitemap><loc>https://evil.test/s2.xml</loc></sitemap></sitemapindex>`,
      },
      'https://app.test/s1.xml': {
        body: '<urlset><url><loc>https://app.test/x</loc></url></urlset>',
      },
    });
    const result = await readSitemap({
      targetUrl: TARGET,
      headers: {},
      timeoutMs: 1000,
      fetchImpl,
    });
    assert.deepEqual(result.urls, ['https://app.test/x']);
    assert.ok(calls.every((call) => call.url.startsWith('https://app.test/')));
  });

  it('treats a missing sitemap as empty and other failures as non-fatal errors', async () => {
    const missing = await readSitemap({
      targetUrl: TARGET,
      headers: {},
      timeoutMs: 1000,
      fetchImpl: fakeFetch({}).fetchImpl,
    });
    assert.deepEqual(missing, { urls: [], error: null });

    const broken = await readSitemap({
      targetUrl: TARGET,
      headers: {},
      timeoutMs: 1000,
      fetchImpl: fakeFetch({ 'https://app.test/sitemap.xml': { status: 500 } }).fetchImpl,
    });
    assert.deepEqual(broken, { urls: [], error: 'sitemap returned HTTP 500' });
  });
});
