import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repoVerificationFindings, verifyRepoRoutes } from './repo-verification.js';

const targetUrl = new URL('https://app.test/');

/** @param {Record<string, unknown>} fields */
const route = (fields) =>
  /** @type {import('./routes.js').RouteSummary} */ (
    /** @type {unknown} */ ({ status: 200, error: null, finalUrl: null, ...fields })
  );

/** @param {string} path @param {Record<string, number>} statusCounts */
const endpoint = (path, statusCounts) =>
  /** @type {import('./endpoints.js').EndpointSummary} */ (
    /** @type {unknown} */ ({
      key: `GET https://app.test${path}`,
      discoveredBy: ['repo'],
      statusCounts,
    })
  );

describe('verifyRepoRoutes', () => {
  const verification = verifyRepoRoutes({
    repo: {
      pages: ['/', '/account', '/gone', '/broken', '/admin/secret', '/not-reached'],
      apis: ['/api/items/7', '/api/missing', '/api/down', '/api/skipped'],
    },
    routes: [
      route({ url: 'https://app.test/', finalUrl: 'https://app.test/' }),
      route({ url: 'https://app.test/account', finalUrl: 'https://app.test/login?next=/account' }),
      route({ url: 'https://app.test/gone', status: 404 }),
      route({ url: 'https://app.test/broken', status: null, error: 'net::ERR_CONNECTION_RESET' }),
    ],
    endpoints: [
      endpoint('/api/items/:id', { 200: 3 }),
      endpoint('/api/missing', { 404: 3 }),
      endpoint('/api/down', { 503: 2, 200: 1 }),
    ],
    targetUrl,
    exclude: [/\/admin\//],
  });

  it('classifies pages by the HTTP outcome of their measured load', () => {
    assert.deepEqual(
      verification.pages.map(({ route, result, status, redirectedTo, reason }) => [
        route,
        result,
        status,
        redirectedTo,
        reason,
      ]),
      [
        ['/', 'ok', 200, null, null],
        ['/account', 'ok', 200, '/login?next=/account', null],
        ['/gone', 'not-found', 404, null, null],
        ['/broken', 'error', null, null, 'net::ERR_CONNECTION_RESET'],
        ['/admin/secret', 'not-measured', null, null, 'skipped as excluded'],
        [
          '/not-reached',
          'not-measured',
          null,
          null,
          'not measured (route limit or interrupted run)',
        ],
      ],
    );
  });

  it('classifies APIs by their most frequent status, matching templated endpoints', () => {
    assert.deepEqual(
      verification.apis.map(({ route, result, status }) => [route, result, status]),
      [
        ['/api/items/7', 'ok', 200],
        ['/api/missing', 'not-found', 404],
        ['/api/down', 'error', 503],
        ['/api/skipped', 'not-measured', null],
      ],
    );
    assert.deepEqual(verification.counts, { ok: 3, 'not-found': 2, error: 2, 'not-measured': 3 });
  });

  it('turns each not-found route into a warning finding', () => {
    const findings = repoVerificationFindings(verification);
    assert.deepEqual(
      findings.map((finding) => [finding.id, finding.severity]),
      [
        ['repo-route-not-found:/gone', 'warning'],
        ['repo-route-not-found:/api/missing', 'warning'],
      ],
    );
  });
});
