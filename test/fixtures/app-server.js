import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

/**
 * A small web app with deliberate performance problems, used by integration tests:
 *
 * - `/dashboard` loads a script that calls `/api/me`, then `/api/projects` (a sequential chain),
 *   then `/api/me` again (a duplicate) and `/api/slow` and `/api/items/42` in parallel.
 * - `/api/projects` returns 2,000 items uncompressed (oversized payload).
 * - `/api/slow` takes ~250 ms and reports a `Server-Timing` breakdown dominated by `db`.
 *   It also only serves 4 requests at a time, so latency grows under concurrency.
 * - `/old-about` redirects to `/about`.
 * - `/logout` must never be visited; hits are counted so tests can assert that.
 * - `/private` requires `authorization: Bearer test-token` or the `session=valid` cookie.
 */

const HOME_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture Home</title>
<link rel="stylesheet" href="/static/app.css"></head>
<body><h1>Fixture</h1>
<nav><a href="/about">About</a> <a href="/dashboard">Dashboard</a> <a href="/old-about">Old</a>
<a href="/logout">Log out</a> <a href="https://external.invalid/">External</a>
<a href="/files/report.pdf">PDF</a> <a href="mailto:hi@example.com">Mail</a></nav>
<img src="/static/hero.svg" width="400" height="200" alt="">
<script src="/static/app.js"></script></body></html>`;

const ABOUT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>About</title>
<link rel="stylesheet" href="/static/app.css"></head>
<body><h1>About</h1><p>Plain page.</p><a href="/">Home</a> <a href="/deep">Deep</a></body></html>`;

const DEEP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Deep</title></head>
<body><p>Two levels down.</p><a href="/deeper">Deeper</a></body></html>`;

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dashboard</title>
<link rel="stylesheet" href="/static/app.css"></head>
<body><h1>Dashboard</h1><ul id="list"></ul>
<script src="/static/dashboard.js"></script></body></html>`;

const PRIVATE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Private</title></head>
<body><h1>Private area</h1></body></html>`;

const DASHBOARD_JS = `
(async () => {
  const me = await fetch('/api/me').then((r) => r.json());
  const projects = await fetch('/api/projects?owner=' + me.id).then((r) => r.json());
  await Promise.all([
    fetch('/api/me').then((r) => r.json()),
    fetch('/api/slow').then((r) => r.json()),
    fetch('/api/items/42').then((r) => r.json()),
  ]);
  const list = document.getElementById('list');
  for (const project of projects.slice(0, 20)) {
    const item = document.createElement('li');
    item.textContent = project.name;
    list.appendChild(item);
  }
})();
`;

const APP_JS = `document.body.dataset.ready = 'true';`;
const APP_CSS = `body { font-family: sans-serif; } h1 { color: #333; }`;
const HERO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#4F46E5"/></svg>`;

const PROJECTS = JSON.stringify(
  Array.from({ length: 2000 }, (_, index) => ({
    id: index + 1,
    name: `Project ${index + 1}`,
    owner: 7,
    tags: ['alpha', 'beta'],
    description: 'A fixture project with enough text to make the payload realistically heavy.',
  })),
);

const SLOW_CONCURRENCY = 4;

/**
 * @typedef {object} FixtureServer
 * @property {string} origin e.g. http://127.0.0.1:54321
 * @property {Map<string, number>} hits Request counts by pathname.
 * @property {() => Promise<void>} close
 */

/**
 * @returns {Promise<FixtureServer>}
 */
export async function startFixtureServer() {
  /** @type {Map<string, number>} */
  const hits = new Map();
  let slowActive = 0;
  /** @type {Array<() => void>} */
  const slowQueue = [];

  const acquireSlowSlot = () =>
    new Promise((resolve) => {
      if (slowActive < SLOW_CONCURRENCY) {
        slowActive += 1;
        resolve(undefined);
      } else {
        slowQueue.push(() => {
          slowActive += 1;
          resolve(undefined);
        });
      }
    });
  const releaseSlowSlot = () => {
    slowActive -= 1;
    slowQueue.shift()?.();
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);

    /**
     * @param {number} status
     * @param {string} type
     * @param {string | Buffer} body
     * @param {Record<string, string>} [headers]
     */
    const send = (status, type, body, headers = {}) => {
      response.writeHead(status, { 'content-type': type, ...headers });
      response.end(body);
    };
    const html = (/** @type {string} */ body) =>
      send(200, 'text/html; charset=utf-8', body, { 'cache-control': 'no-cache' });

    switch (url.pathname) {
      case '/':
        return html(HOME_HTML);
      case '/about':
        return html(ABOUT_HTML);
      case '/deep':
        return html(DEEP_HTML);
      case '/deeper':
        return html(DEEP_HTML);
      case '/dashboard':
        return html(DASHBOARD_HTML);
      case '/old-about':
        response.writeHead(301, { location: '/about' });
        return response.end();
      case '/logout':
        return html('<p>Logged out</p>');
      case '/private': {
        const authorized =
          request.headers.authorization === 'Bearer test-token' ||
          /(?:^|;\s*)session=valid(?:;|$)/.test(request.headers.cookie ?? '');
        return authorized ? html(PRIVATE_HTML) : send(401, 'text/plain', 'unauthorized');
      }
      case '/echo-headers':
        return send(200, 'application/json', JSON.stringify(request.headers));
      case '/sitemap.xml':
        return send(
          200,
          'application/xml',
          `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${originOf(request)}/</loc></url>
  <url><loc>${originOf(request)}/about</loc></url>
  <url><loc>${originOf(request)}/dashboard</loc></url>
  <url><loc>https://elsewhere.invalid/page</loc></url>
</urlset>`,
        );
      case '/static/app.js':
        return send(200, 'text/javascript', APP_JS, { 'cache-control': 'max-age=31536000' });
      case '/static/dashboard.js':
        return send(200, 'text/javascript', gzipSync(DASHBOARD_JS), {
          'content-encoding': 'gzip',
          'cache-control': 'max-age=31536000',
        });
      case '/static/app.css':
        return send(200, 'text/css', APP_CSS);
      case '/static/hero.svg':
        return send(200, 'image/svg+xml', HERO_SVG, { 'cache-control': 'max-age=3600' });
      case '/api/me':
        return send(200, 'application/json', JSON.stringify({ id: 7, name: 'Ada' }));
      case '/api/projects':
        return send(200, 'application/json', PROJECTS);
      case '/api/items/42':
        return send(200, 'application/json', JSON.stringify({ id: 42, title: 'Item' }));
      case '/api/slow': {
        await acquireSlowSlot();
        try {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return send(200, 'application/json', JSON.stringify({ ok: true }), {
            'server-timing': 'db;dur=230;desc="query", app;dur=15',
          });
        } finally {
          releaseSlowSlot();
        }
      }
      default:
        return send(404, 'text/plain', 'not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No server address');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {string}
 */
function originOf(request) {
  return `http://${request.headers.host}`;
}
