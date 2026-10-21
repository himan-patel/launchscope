import { createHash } from 'node:crypto';
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

const GQL_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GraphQL</title></head>
<body><h1>GraphQL</h1><script src="/static/gql.js"></script></body></html>`;

const GQL_JS = `
(async () => {
  const gql = (body) => fetch('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  const viewer = { operationName: 'GetViewer', query: 'query GetViewer { viewer { id } }' };
  await Promise.all([
    gql(viewer),
    gql(viewer),
    gql({ operationName: 'SearchProjects', query: 'query SearchProjects($q: String) { search(q: $q) { id } }', variables: { q: 'a' } }),
    gql({ operationName: 'SearchProjects', query: 'query SearchProjects($q: String) { search(q: $q) { id } }', variables: { q: 'b' } }),
    fetch('/graphql?operationName=Feed&extensions=' + encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: 'abc' } }))).then((r) => r.json()),
  ]);
})();
`;

const LIVE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Live</title></head>
<body><h1>Live</h1><iframe src="/about" width="300" height="150" title="About"></iframe>
<script>
  const socket = new WebSocket('ws://' + location.host + '/ws');
  socket.onopen = () => socket.send('subscribe');
  new WebSocket('ws://' + location.host + '/ws-reject');
  new EventSource('/events');
  fetch('/api/me');
</script></body></html>`;

const OPENAPI = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Fixture API', version: '1.0.0' },
  servers: [{ url: '/' }],
  components: {
    parameters: {
      ItemId: { name: 'id', in: 'path', required: true, schema: { type: 'integer', example: 42 } },
    },
  },
  paths: {
    '/api/me': { get: { operationId: 'getMe' } },
    '/api/items/{id}': {
      parameters: [{ $ref: '#/components/parameters/ItemId' }],
      get: { operationId: 'getItem' },
    },
    '/api/projects': {
      get: { parameters: [{ name: 'owner', in: 'query', required: true, example: 7 }] },
    },
    '/api/unlinked': { get: { operationId: 'unlinked' } },
    '/api/orders/{orderId}': {
      get: {
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/api/orders': { post: { operationId: 'createOrder' } },
    '/api/legacy': { get: { deprecated: true } },
  },
});

const SPA_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SPA</title></head>
<body><nav><a href="/spa" data-spa>Home</a> <a href="/spa/a" data-spa>A</a> <a href="/spa/b" data-spa>B</a> <a href="/about">About (full page)</a></nav>
<main id="view"></main><script src="/static/spa.js"></script></body></html>`;

const SPA_JS = `
const view = document.getElementById('view');
async function render(path) {
  if (path === '/spa/a') {
    const item = await fetch('/api/items/42').then((r) => r.json());
    view.textContent = 'Item ' + item.id;
  } else if (path === '/spa/b') {
    const me = await fetch('/api/me').then((r) => r.json());
    await fetch('/api/slow?user=' + me.id).then((r) => r.json());
    view.innerHTML = '<ul>' + Array.from({ length: 20 }, (_, i) => '<li>Row ' + i + '</li>').join('') + '</ul>';
  } else {
    view.textContent = 'Home';
  }
}
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-spa]');
  if (!link) return;
  event.preventDefault();
  history.pushState({}, '', link.href);
  render(location.pathname);
});
render(location.pathname);
`;

const SEARCH_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Search</title></head>
<body><h1>Search</h1><ul id="results"></ul><script>
(async () => {
  const response = await fetch('/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: 'launch-shoes' }),
  });
  const results = await response.json();
  document.getElementById('results').innerHTML = results.map((r) => '<li>' + r + '</li>').join('');
  fetch('/api/track', { method: 'POST', body: 'viewed=search' });
})();
</script></body></html>`;

const XHR_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>XHR</title></head>
<body><h1>XHR</h1><script src="/static/xhr.js"></script></body></html>`;

// Mirrors how axios and older code use XMLHttpRequest, plus requests that must NOT be linked.
const XHR_JS = `
function get(url, handlerStyle, done) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  if (handlerStyle === 'onloadend') xhr.onloadend = () => done(JSON.parse(xhr.responseText));
  else if (handlerStyle === 'listener') xhr.addEventListener('load', () => done(JSON.parse(xhr.responseText)));
  else xhr.onreadystatechange = () => { if (xhr.readyState === 4) done(JSON.parse(xhr.responseText)); };
  xhr.send();
}
get('/api/me', 'onloadend', (me) => {
  // Keeps this response task busy past the 50 ms timer below, so the timer task is already due
  // when it ends: whichever task the browser runs next, the timer must not inherit this cause.
  const until = performance.now() + 120;
  while (performance.now() < until) {}
  get('/api/projects?owner=' + me.id, 'listener', () => {
    get('/api/items/42', 'readystatechange', () => {
      new Promise((resolve) => resolve()).then(() => fetch('/api/slow'));
    });
  });
});
fetch('/api/flags-independent');
// Fires while the chain is in flight: running concurrently is not a dependency.
setTimeout(() => fetch('/api/later'), 50);
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
 * @property {Array<{ method: string, path: string, body: string, contentType: string | undefined }>} writes Every POST/PUT/PATCH body received.
 * @property {Array<{ path: string, traceparent: string }>} traceparents Every traceparent header received.
 * @property {(ms: number) => void} setSlowDelay Changes how long /api/slow takes (default 250 ms).
 * @property {() => Promise<void>} close
 */

/**
 * @returns {Promise<FixtureServer>}
 */
export async function startFixtureServer() {
  /** @type {Map<string, number>} */
  const hits = new Map();
  let slowActive = 0;
  let slowDelayMs = 250;
  /** @type {Array<{ path: string, traceparent: string }>} */
  const traceparents = [];
  /** @type {Array<{ method: string, path: string, body: string, contentType: string | undefined }>} */
  const writes = [];
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
    const traceparent = request.headers.traceparent;
    if (typeof traceparent === 'string') traceparents.push({ path: url.pathname, traceparent });

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
      case '/login':
        return send(200, 'text/html; charset=utf-8', '<p>Signed in</p>', {
          'set-cookie': 'session=valid; Path=/; HttpOnly; SameSite=Lax',
        });
      case '/private': {
        const authorized =
          request.headers.authorization === 'Bearer test-token' ||
          /(?:^|;\s*)session=valid(?:;|$)/.test(request.headers.cookie ?? '');
        return authorized ? html(PRIVATE_HTML) : send(401, 'text/plain', 'unauthorized');
      }
      case '/search':
        return html(SEARCH_HTML);
      case '/api/search':
      case '/api/track': {
        if (request.method === 'GET') return send(405, 'text/plain', 'use POST');
        let body = '';
        for await (const chunk of request) body += chunk;
        writes.push({
          method: request.method ?? '',
          path: url.pathname,
          body,
          contentType: request.headers['content-type'],
        });
        if (url.pathname === '/api/track') {
          response.writeHead(204);
          return response.end();
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
        return send(200, 'application/json', JSON.stringify(['a', 'b', 'c']));
      }
      case '/xhr':
        return html(XHR_HTML);
      case '/static/xhr.js':
        return send(200, 'text/javascript', XHR_JS, { 'cache-control': 'max-age=31536000' });
      case '/api/flags-independent':
      case '/api/later':
        return send(200, 'application/json', JSON.stringify({ ok: true }));
      case '/spa':
      case '/spa/a':
      case '/spa/b':
        return html(SPA_HTML);
      case '/static/spa.js':
        return send(200, 'text/javascript', SPA_JS, { 'cache-control': 'max-age=31536000' });
      case '/openapi.json':
        return send(200, 'application/json', OPENAPI);
      case '/api/unlinked':
        await new Promise((resolve) => setTimeout(resolve, 120));
        return send(200, 'application/json', JSON.stringify({ ok: true }));
      case '/live':
        return html(LIVE_HTML);
      case '/events': {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        response.write('data: hello\n\n');
        const timer = setInterval(() => response.write('data: tick\n\n'), 200);
        request.on('close', () => clearInterval(timer));
        return undefined;
      }
      case '/gql':
        return html(GQL_HTML);
      case '/static/gql.js':
        return send(200, 'text/javascript', GQL_JS, { 'cache-control': 'max-age=31536000' });
      case '/graphql': {
        let operation = url.searchParams.get('operationName') ?? '';
        if (request.method === 'POST') {
          let raw = '';
          for await (const chunk of request) raw += chunk;
          operation = JSON.parse(raw).operationName ?? '';
        }
        if (operation === 'SearchProjects')
          await new Promise((resolve) => setTimeout(resolve, 300));
        return send(200, 'application/json', JSON.stringify({ data: { operation } }));
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
          await new Promise((resolve) => setTimeout(resolve, slowDelayMs));
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

  /** @type {Set<import('node:stream').Duplex>} */
  const upgraded = new Set();
  server.on('upgrade', (request, socket) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path !== '/ws') {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    const message = Buffer.from('welcome');
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    socket.on('error', () => upgraded.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No server address');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits,
    traceparents,
    writes,
    setSlowDelay: (ms) => {
      slowDelayMs = ms;
    },
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of upgraded) socket.destroy();
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
