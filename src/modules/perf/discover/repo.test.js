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

  it('follows Angular routes through children, lazy route files, and NgModules', async () => {
    const root = await makeRepo({
      'src/main.ts': `import { bootstrapApplication } from '@angular/platform-browser';
        import { provideRouter } from '@angular/router';
        import { routes } from './app/app.routes';
        bootstrapApplication(App, { providers: [provideRouter(routes)] });`,
      'src/app/app.routes.ts': `import { Routes } from '@angular/router';
        import { Home } from './home';
        const accountRoutes: Routes = [{ path: 'profile', component: Profile }];
        export const routes: Routes = [
          { path: '', component: Home },
          { path: 'old', redirectTo: '' },
          { path: 'users/:id', component: User },
          {
            path: 'account',
            component: AccountShell,
            children: [{ path: '', component: Overview }, ...accountRoutes],
          },
          { path: 'admin', loadChildren: () => import('./admin/admin.routes').then((m) => m.ADMIN_ROUTES) },
          { path: 'legacy', loadChildren: () => import('./legacy/legacy.module').then((m) => m.LegacyModule) },
          { path: 'lib', loadChildren: () => import('@acme/lib').then((m) => m.ROUTES) },
          { path: '**', component: NotFound },
        ];`,
      'src/app/admin/admin.routes.ts': `import { Route } from '@angular/router';
        export const ADMIN_ROUTES: Route[] = [
          { path: '', loadComponent: () => import('./dashboard').then((m) => m.Dashboard) },
          { path: 'audit', component: Audit },
        ];`,
      'src/app/legacy/legacy.module.ts': `import { NgModule } from '@angular/core';
        import { LegacyRoutingModule } from './legacy-routing.module';
        @NgModule({ imports: [LegacyRoutingModule] })
        export class LegacyModule {}`,
      'src/app/legacy/legacy-routing.module.ts': `import { NgModule } from '@angular/core';
        import { RouterModule, Routes } from '@angular/router';
        const routes: Routes = [{ path: 'reports', component: Reports }];
        @NgModule({ imports: [RouterModule.forChild(routes)], exports: [RouterModule] })
        export class LegacyRoutingModule {}`,
    });
    const result = await discoverRepoRoutes({ root, routeParams: { id: '7' } });
    assert.deepEqual(result.frameworks, ['angular']);
    assert.deepEqual(result.pages, [
      '/',
      '/account',
      '/account/profile',
      '/admin',
      '/admin/audit',
      '/legacy/reports',
      '/users/7',
    ]);
    assert.deepEqual(
      result.skipped.map(({ route, reason }) => [route, reason]),
      [['/lib (lazy children)', 'loadChildren target could not be resolved']],
    );
  });

  it('follows React Router objects, nested <Route> trees, and descendant <Routes>', async () => {
    const root = await makeRepo({
      'web/router.jsx': `import { createBrowserRouter } from 'react-router-dom';
        import { settingsRoutes } from './settings';
        export const router = createBrowserRouter([
          {
            path: '/',
            element: <Layout />,
            children: [
              { index: true, element: <Home /> },
              { path: 'pricing', element: <Pricing /> },
              { path: 'settings', children: settingsRoutes },
              { path: '*', element: <NotFound /> },
            ],
          },
        ]);`,
      'web/settings.js': `export const settingsRoutes = [{ path: 'billing', lazy: () => import('./billing') }];`,
      'admin/App.tsx': `import { Routes, Route } from 'react-router';
        import { Reports } from './Reports';
        export function App() {
          return (
            <Routes>
              <Route path="/admin" element={<Shell />}>
                <Route index element={<Overview />} />
                <Route path="users/:id" element={<User />} />
                <Route path="reports/*" element={<Reports />} />
              </Route>
            </Routes>
          );
        }`,
      'admin/Reports.tsx': `import { Routes, Route } from 'react-router';
        export const Reports = () => (
          <Routes>
            <Route path="daily" element={<Daily />} />
          </Routes>
        );`,
    });
    const result = await discoverRepoRoutes({ root, routeParams: { id: '7' } });
    assert.deepEqual(result.frameworks, ['react-router']);
    assert.deepEqual(result.pages, [
      '/',
      '/admin',
      '/admin/reports',
      '/admin/reports/daily',
      '/admin/users/7',
      '/pricing',
      '/settings/billing',
    ]);
  });

  it('follows Express routers through mount prefixes and modules', async () => {
    const root = await makeRepo({
      'server/index.js': `const express = require('express');
        const api = require('./api');
        const app = express();
        app.set('etag', false);
        app.get('env');
        app.use(express.json());
        app.get('/healthz', handler);
        app.post('/orders', handler);
        app.route('/status').post(h).get(h);
        app.use('/api', api);
        app.use('/ext', require('@acme/router'));`,
      'server/api/index.js': `import { Router } from 'express';
        import users from './users.js';
        const router = Router();
        router.get('/', h);
        router.use('/users', users);
        export default router;`,
      'server/api/users.ts': `import express from 'express';
        const users = express.Router();
        users.get('/:id', h);
        users.get('/' + 'computed', h);
        users.get('/files/*', h);
        export default users;`,
      'server/orphan.js': `const { Router } = require('express');
        const orphan = Router();
        orphan.get('/lost', h);
        module.exports = orphan;`,
    });
    const result = await discoverRepoRoutes({ root, routeParams: { id: '7' } });
    assert.deepEqual(result.frameworks, ['express']);
    assert.deepEqual(result.apis, ['/api', '/api/users/7', '/healthz', '/status']);
    assert.deepEqual(result.skipped.map(({ route, reason }) => [route, reason]).sort(), [
      ['', 'GET route path is not a string literal'],
      ['/ext/…', 'mounted router could not be resolved'],
      ['/lost', 'router is not mounted on an Express app that could be resolved'],
    ]);
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
