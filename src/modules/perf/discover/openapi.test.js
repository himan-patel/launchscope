import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UsageError } from '../../../core/errors.js';
import { loadOpenApi, parseSpec, planOperations } from './openapi.js';

const TARGET = new URL('https://app.test/');

describe('parseSpec', () => {
  it('accepts OpenAPI 3 and Swagger 2 JSON', () => {
    assert.equal(parseSpec(JSON.stringify({ openapi: '3.1.0', paths: {} }), 'x').openapi, '3.1.0');
    assert.equal(parseSpec(JSON.stringify({ swagger: '2.0', paths: {} }), 'x').swagger, '2.0');
  });

  it('accepts YAML, using the core schema only', () => {
    const document = parseSpec(
      [
        'openapi: 3.0.3',
        'info: { title: Shop }',
        'paths:',
        '  /api/items/{id}:',
        '    get:',
        '      parameters:',
        '        - &id { name: id, in: path, required: true, example: 42 }',
        '  /api/other/{id}:',
        '    get:',
        '      parameters: [*id]',
        '      x-when: 2026-01-01',
      ].join('\n'),
      'spec.yaml',
    );
    assert.equal(document.openapi, '3.0.3');
    assert.equal(document.paths['/api/other/{id}'].get.parameters[0].example, 42);
    assert.equal(document.paths['/api/other/{id}'].get['x-when'], '2026-01-01', 'no date objects');
  });

  it('rejects alias bombs, broken YAML, and other documents', () => {
    const bomb = [
      'a: &a [x, x, x, x, x, x, x, x, x, x]',
      ...Array.from({ length: 12 }, (_, index) => {
        const name = String.fromCharCode(98 + index);
        const previous = String.fromCharCode(97 + index);
        return `${name}: &${name} [${Array(10).fill(`*${previous}`).join(', ')}]`;
      }),
    ].join('\n');
    assert.throws(() => parseSpec(bomb, 'bomb.yaml'), UsageError);
    assert.throws(
      () => parseSpec('openapi: [unclosed', 'broken.yaml'),
      /neither JSON nor valid YAML/,
    );
    assert.throws(
      () => parseSpec(JSON.stringify({ hello: 1 }), 'x'),
      /not an OpenAPI 3\.x or Swagger 2\.0/,
    );
    assert.throws(() => parseSpec('<html>not found</html>', 'x'), /not an OpenAPI/);
  });
});

describe('planOperations', () => {
  const document = {
    openapi: '3.0.3',
    servers: [{ url: '/v1' }],
    components: { parameters: { Id: { name: 'id', in: 'path', schema: { example: 5 } } } },
    paths: {
      '/items': { get: { parameters: [{ name: 'limit', in: 'query', schema: { default: 20 } }] } },
      '/items/{id}': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        get: { operationId: 'getItem' },
      },
      '/search': { get: { parameters: [{ name: 'q', in: 'query', required: true }] } },
      '/users/{userId}': { get: { parameters: [{ name: 'userId', in: 'path', required: true }] } },
      '/orders': {
        post: {},
        get: {
          parameters: [{ name: 'status', in: 'query', schema: { enum: ['open', 'closed'] } }],
        },
      },
      '/old': { get: { deprecated: true } },
      '/undeclared/{x}': { get: {} },
    },
  };
  const plan = planOperations({
    document,
    source: 'https://app.test/openapi.json',
    targetUrl: TARGET,
    limit: 50,
  });

  it('builds concrete GET URLs from examples, defaults, enums, and $refs', () => {
    assert.deepEqual(
      plan.operations.map((operation) => operation.url),
      [
        'https://app.test/v1/items?limit=20',
        'https://app.test/v1/items/5',
        'https://app.test/v1/orders?status=open',
      ],
    );
    assert.equal(plan.operations[1].operationId, 'getItem');
  });

  it('skips operations it cannot call safely, with reasons', () => {
    const reasons = Object.fromEntries(
      plan.skipped.map((entry) => [`${entry.method} ${entry.path}`, entry.reason]),
    );
    assert.deepEqual(reasons, {
      'GET /search': 'required query parameter "q" has no example or default',
      'GET /users/{userId}': 'path parameter "userId" has no example or default',
      'POST /orders': 'only GET operations are called',
      'GET /old': 'deprecated',
      'GET /undeclared/{x}': 'path has undeclared parameters',
    });
  });

  it('only calls operations on the target origin', () => {
    const remote = planOperations({
      document: {
        openapi: '3.0.0',
        servers: [{ url: 'https://api.other.test' }],
        paths: { '/a': { get: {} } },
      },
      source: 'spec.json',
      targetUrl: TARGET,
      limit: 10,
    });
    assert.deepEqual(remote.operations, []);
    assert.match(remote.skipped[0].reason, /is not the target origin/);
  });

  it('honors Swagger 2 basePath and the operation limit', () => {
    const swagger = planOperations({
      document: {
        swagger: '2.0',
        basePath: '/api',
        paths: { '/a': { get: {} }, '/b': { get: {} } },
      },
      source: 'spec.json',
      targetUrl: TARGET,
      limit: 1,
    });
    assert.deepEqual(
      swagger.operations.map((operation) => operation.url),
      ['https://app.test/api/a'],
    );
    assert.match(swagger.skipped[0].reason, /limit of 1/);
  });
});

describe('loadOpenApi', () => {
  /** @param {Record<string, unknown>} routes */
  const fakeFetch = (routes) =>
    /** @type {typeof fetch} */ (
      async (input) => {
        const body = routes[String(input)];
        return body === undefined
          ? new Response('not found', { status: 404 })
          : new Response(JSON.stringify(body), { status: 200 });
      }
    );

  it('finds a spec at a well-known path with auto', async () => {
    const spec = { openapi: '3.0.0', paths: {} };
    const loaded = await loadOpenApi({
      reference: 'auto',
      targetUrl: TARGET,
      headers: {},
      timeoutMs: 1000,
      fetchImpl: fakeFetch({ 'https://app.test/v3/api-docs': spec }),
    });
    assert.equal(loaded?.source, 'https://app.test/v3/api-docs');
  });

  it('finds a YAML spec at a well-known path', async () => {
    const loaded = await loadOpenApi({
      reference: 'auto',
      targetUrl: TARGET,
      headers: {},
      timeoutMs: 1000,
      fetchImpl: /** @type {typeof fetch} */ (
        async (input) =>
          String(input) === 'https://app.test/openapi.yaml'
            ? new Response('openapi: 3.1.0\npaths: {}\n', { status: 200 })
            : new Response('not found', { status: 404 })
      ),
    });
    assert.equal(loaded?.source, 'https://app.test/openapi.yaml');
    assert.equal(loaded?.document.openapi, '3.1.0');
  });

  it('returns null when auto finds nothing, and fails for an explicit URL', async () => {
    assert.equal(
      await loadOpenApi({
        reference: 'auto',
        targetUrl: TARGET,
        headers: {},
        timeoutMs: 1000,
        fetchImpl: fakeFetch({}),
      }),
      null,
    );
    await assert.rejects(
      loadOpenApi({
        reference: 'https://app.test/spec.json',
        targetUrl: TARGET,
        headers: {},
        timeoutMs: 1000,
        fetchImpl: fakeFetch({}),
      }),
      /returned HTTP 404/,
    );
  });
});
