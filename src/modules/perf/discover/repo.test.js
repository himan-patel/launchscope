import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { discoverRepoRoutes, fillSegments } from './repo.js';

/** @type {string[]} */
const created = [];

/**
 * Creates a throwaway repository with the given files.
 *
 * @param {Record<string, string>} files
 * @returns {Promise<string>}
 */
async function makeRepo(files) {
  const root = await mkdtemp(join(tmpdir(), 'launchscope-repo-'));
  created.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

after(async () => {
  for (const root of created) await rm(root, { recursive: true, force: true });
});

describe('fillSegments', () => {
  it('fills dynamic, catch-all, and optional catch-all segments', () => {
    assert.deepEqual(fillSegments(['blog', '[slug]'], { slug: 'hello' }), {
      segments: ['blog', 'hello'],
    });
    assert.deepEqual(fillSegments(['docs', '[...path]'], { path: 'a/b' }), {
      segments: ['docs', 'a', 'b'],
    });
    assert.deepEqual(fillSegments(['shop', '[[...rest]]'], {}), { segments: ['shop'] });
    assert.deepEqual(fillSegments(['u', '[id]'], {}), { missing: 'id' });
  });
});

describe('discoverRepoRoutes', () => {
  it('reads Next.js App Router pages and GET route handlers', async () => {
    const root = await makeRepo({
      'app/page.tsx': '',
      'app/about/page.tsx': '',
      'app/(marketing)/pricing/page.tsx': '',
      'app/blog/[slug]/page.tsx': '',
      'app/_components/page.tsx': '',
      'app/@modal/(.)photo/page.tsx': '',
      'app/api/health/route.ts': 'export async function GET() {}',
      'app/api/orders/route.ts': 'export async function POST() {}',
      'node_modules/pkg/app/x/page.tsx': '',
    });
    const result = await discoverRepoRoutes({ root, routeParams: {} });
    assert.deepEqual(result.frameworks, ['next-app']);
    assert.deepEqual(result.pages, ['/', '/about', '/pricing']);
    assert.deepEqual(result.apis, ['/api/health']);
    assert.deepEqual(result.skipped, [
      {
        route: '/blog/[slug]',
        reason: 'no value for "slug" in routeParams',
        file: 'app/blog/[slug]/page.tsx',
      },
    ]);
  });

  it('fills dynamic segments from routeParams', async () => {
    const root = await makeRepo({ 'src/app/blog/[slug]/page.tsx': '' });
    const result = await discoverRepoRoutes({ root, routeParams: { slug: 'launch-day' } });
    assert.deepEqual(result.pages, ['/blog/launch-day']);
  });

  it('reads the Next.js Pages Router only in Next.js projects', async () => {
    const files = {
      'pages/index.tsx': '',
      'pages/team/index.tsx': '',
      'pages/_app.tsx': '',
      'pages/api/status.ts': '',
    };
    const next = await makeRepo({
      ...files,
      'package.json': JSON.stringify({ dependencies: { next: '15' } }),
    });
    assert.deepEqual(await discoverRepoRoutes({ root: next, routeParams: {} }), {
      frameworks: ['next-pages'],
      pages: ['/', '/team'],
      apis: ['/api/status'],
      skipped: [],
    });
    const other = await makeRepo({ ...files, 'package.json': '{}' });
    assert.deepEqual((await discoverRepoRoutes({ root: other, routeParams: {} })).pages, []);
  });

  it('reads SvelteKit, Nuxt, Astro, and Remix file routes', async () => {
    const root = await makeRepo({
      'src/routes/+page.svelte': '',
      'src/routes/(app)/settings/+page.svelte': '',
      'src/routes/api/ping/+server.ts': 'export const GET = () => new Response();',
      'pages/index.vue': '',
      'pages/contact.vue': '',
      'src/pages/docs/intro.md': '',
      'app/routes/_index.tsx': '',
      'app/routes/blog.$slug.tsx': '',
      'app/routes/_auth.login.tsx': '',
    });
    const result = await discoverRepoRoutes({ root, routeParams: { slug: 'x' } });
    assert.deepEqual(result.frameworks, ['astro', 'nuxt', 'remix', 'sveltekit']);
    assert.deepEqual(result.pages, [
      '/',
      '/blog/x',
      '/contact',
      '/docs/intro',
      '/login',
      '/settings',
    ]);
    assert.deepEqual(result.apis, ['/api/ping']);
  });

  it('reads Angular, React Router, and Express routes from code', async () => {
    const root = await makeRepo({
      'src/app/app.routes.ts': `export const routes: Routes = [
        { path: '', component: Home },
        { path: 'reports', component: Reports },
        { path: 'users/:id', component: User },
        { path: '**', component: NotFound },
      ];`,
      'web/router.jsx': `import { createBrowserRouter } from 'react-router-dom';
        <Route path="/checkout" element={<Checkout />} />`,
      'server/index.js': `const express = require('express'); const app = express();
        app.get('/healthz', handler); app.post('/orders', handler); router.get('/api/items/:id', h);`,
    });
    const result = await discoverRepoRoutes({ root, routeParams: { id: '7' } });
    assert.deepEqual(result.frameworks, ['angular', 'express', 'react-router']);
    assert.deepEqual(result.pages, ['/', '/checkout', '/reports', '/users/7']);
    assert.deepEqual(result.apis, ['/api/items/7', '/healthz']);
  });

  it('rejects a path that is not a directory', async () => {
    await assert.rejects(
      discoverRepoRoutes({
        root: join(tmpdir(), 'definitely-missing-launchscope'),
        routeParams: {},
      }),
      /is not a readable directory/,
    );
  });
});
