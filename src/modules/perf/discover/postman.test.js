import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadImports } from './imports.js';
import { isPostmanCollection } from './postman.js';

const TARGET = new URL('http://localhost:3000/');

const COLLECTION = {
  info: {
    _postman_id: '1b0c7d2e',
    name: 'Shop API',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: 'saved-secret-token' }] },
  variable: [
    { key: 'itemId', value: '42' },
    { key: 'disabled', value: 'x', disabled: true },
  ],
  item: [
    {
      name: 'Items',
      item: [
        {
          name: 'Get item',
          request: {
            method: 'GET',
            header: [{ key: 'Authorization', value: 'Bearer saved-secret-header' }],
            url: { raw: '{{baseUrl}}/api/items/{{itemId}}?expand=true' },
          },
        },
        {
          name: 'Nested',
          item: [
            {
              name: 'List items (url parts)',
              request: {
                method: 'GET',
                url: {
                  host: ['{{baseUrl}}'],
                  path: ['api', 'items'],
                  query: [
                    { key: 'page', value: '2' },
                    { key: 'debug', value: '1', disabled: true },
                  ],
                },
              },
            },
          ],
        },
        {
          name: 'Search',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/api/search',
            body: {
              mode: 'raw',
              raw: '{"id":"{{itemId}}"}',
              options: { raw: { language: 'json' } },
            },
          },
        },
        {
          name: 'Login form',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/api/login',
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'user', value: 'demo' },
                { key: 'skip', value: 'x', disabled: true },
              ],
            },
          },
        },
        {
          name: 'GraphQL',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/graphql',
            body: {
              mode: 'graphql',
              graphql: {
                query: 'query Item($id: ID!) { item(id: $id) { id } }',
                variables: '{"id":"{{itemId}}"}',
              },
            },
          },
        },
        {
          name: 'Upload',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/api/upload',
            body: { mode: 'formdata', formdata: [] },
          },
        },
        {
          name: 'Unknown var',
          request: { method: 'GET', url: '{{baseUrl}}/api/users/{{userId}}' },
        },
        { name: 'Delete', request: { method: 'DELETE', url: '{{baseUrl}}/api/items/{{itemId}}' } },
        { name: 'Elsewhere', request: 'https://other.test/api/ping' },
        { name: 'Shorthand', request: 'localhost:3000/api/health' },
      ],
    },
  ],
};

describe('loadImports (Postman)', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let file;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'launchscope-postman-'));
    file = join(dir, 'shop.postman_collection.json');
    await writeFile(file, JSON.stringify(COLLECTION));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('recognizes v2 collections', () => {
    assert.equal(isPostmanCollection(COLLECTION), true);
    assert.equal(isPostmanCollection({ log: { entries: [] } }), false);
  });

  it('imports GET requests with variables filled and {{baseUrl}} pointed at the target', async () => {
    const plan = await loadImports({
      files: [file],
      targetUrl: TARGET,
      includeWrites: false,
      limit: 100,
    });
    assert.deepEqual(plan.sources, [{ file, format: 'postman', operations: 3 }]);
    assert.deepEqual(
      plan.operations.map((operation) => operation.url),
      [
        'http://localhost:3000/api/items/42?expand=true',
        'http://localhost:3000/api/items?page=2',
        'http://localhost:3000/api/health',
      ],
    );
    const reasons = Object.fromEntries(plan.skipped.map((skip) => [skip.path, skip.reason]));
    assert.equal(reasons['Items/Unknown var'], 'unresolved variable {{userId}}');
    assert.equal(reasons['https://other.test/api/ping'], 'not on the target origin');
    assert.equal(reasons['/api/search'], 'writes are imported only with --import-writes');
    assert.equal(reasons['/api/items/42'], 'DELETE is never sent');
  });

  it('imports raw, form, and GraphQL bodies with --import-writes, never saved credentials', async () => {
    const plan = await loadImports({
      files: [file],
      targetUrl: TARGET,
      includeWrites: true,
      limit: 100,
    });
    /** @param {string} path */
    const find = (path) => plan.operations.find((operation) => operation.path === path);
    assert.deepEqual(
      { body: find('/api/search')?.body, contentType: find('/api/search')?.contentType },
      { body: '{"id":"42"}', contentType: 'application/json' },
    );
    assert.equal(find('/api/login')?.body, 'user=demo');
    assert.equal(find('/api/login')?.contentType, 'application/x-www-form-urlencoded');
    assert.deepEqual(JSON.parse(find('/graphql')?.body ?? '{}'), {
      query: 'query Item($id: ID!) { item(id: $id) { id } }',
      variables: { id: '42' },
    });
    assert.ok(plan.skipped.some((skip) => skip.reason === 'formdata bodies are not supported'));
    assert.doesNotMatch(JSON.stringify(plan), /saved-secret/);
  });
});
