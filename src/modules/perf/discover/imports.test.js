import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { UsageError } from '../../../core/errors.js';
import { loadImports } from './imports.js';

const TARGET = new URL('https://app.test/');

/**
 * @param {string} method
 * @param {string} url
 * @param {{ type?: string | null, mime?: string, postData?: object }} [options]
 */
const entry = (method, url, { type = 'fetch', mime = 'application/json', postData } = {}) => ({
  ...(type === null ? {} : { _resourceType: type }),
  request: {
    method,
    url,
    headers: [{ name: 'Authorization', value: 'Bearer recorded-secret' }],
    cookies: [{ name: 'sid', value: 'recorded-cookie' }],
    ...(postData ? { postData } : {}),
  },
  response: { status: 200, content: { mimeType: mime } },
});

describe('loadImports (HAR)', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let har;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'launchscope-import-'));
    har = join(dir, 'recording.har');
    await writeFile(
      har,
      JSON.stringify({
        log: {
          version: '1.2',
          entries: [
            entry('GET', 'https://app.test/', { type: 'document', mime: 'text/html' }),
            entry('GET', 'https://app.test/api/me'),
            entry('GET', 'https://app.test/api/me'),
            entry('GET', 'https://app.test/api/items?page=2#top'),
            entry('GET', 'https://app.test/static/app.js', { type: 'script' }),
            entry('GET', 'https://cdn.test/api/flags'),
            entry('POST', 'https://app.test/api/search', {
              postData: { mimeType: 'application/json', text: '{"q":"shoes"}' },
            }),
            entry('POST', 'https://app.test/api/login', {
              postData: {
                mimeType: 'application/x-www-form-urlencoded',
                params: [
                  { name: 'user', value: 'a' },
                  { name: 'next', value: '/home' },
                ],
              },
            }),
            entry('DELETE', 'https://app.test/api/items/1'),
            entry('GET', 'https://app.test/api/firefox', { type: null }),
            entry('GET', 'https://app.test/firefox.png', { type: null, mime: 'image/png' }),
          ],
        },
      }),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('imports GET API calls on the target origin, once each', async () => {
    const plan = await loadImports({
      files: [har],
      targetUrl: TARGET,
      includeWrites: false,
      limit: 100,
    });
    assert.deepEqual(
      plan.operations.map((operation) => operation.url),
      [
        'https://app.test/api/me',
        'https://app.test/api/items?page=2',
        'https://app.test/api/firefox',
      ],
    );
    assert.deepEqual(plan.sources, [{ file: har, format: 'har', operations: 3 }]);
    const reasons = Object.fromEntries(
      plan.skipped.map((skip) => [`${skip.method} ${skip.path}`, skip.reason]),
    );
    assert.equal(reasons['GET /'], 'not an API call (document)');
    assert.equal(reasons['GET /static/app.js'], 'not an API call (script)');
    assert.equal(reasons['GET /firefox.png'], 'not an API call (image/png)');
    assert.equal(reasons['GET https://cdn.test/api/flags'], 'not on the target origin');
    assert.equal(reasons['POST /api/search'], 'writes are imported only with --import-writes');
    assert.equal(reasons['DELETE /api/items/1'], 'DELETE is never sent');
  });

  it('imports writes with their bodies only when asked, and never recorded credentials', async () => {
    const plan = await loadImports({
      files: [har],
      targetUrl: TARGET,
      includeWrites: true,
      limit: 100,
    });
    const search = plan.operations.find((operation) => operation.path === '/api/search');
    assert.deepEqual(search, {
      url: 'https://app.test/api/search',
      path: '/api/search',
      operationId: null,
      method: 'POST',
      body: '{"q":"shoes"}',
      contentType: 'application/json',
    });
    const login = plan.operations.find((operation) => operation.path === '/api/login');
    assert.equal(login?.body, 'user=a&next=%2Fhome');
    assert.doesNotMatch(JSON.stringify(plan), /recorded-secret|recorded-cookie/);
  });

  it('honors the operation limit', async () => {
    const plan = await loadImports({
      files: [har],
      targetUrl: TARGET,
      includeWrites: false,
      limit: 1,
    });
    assert.equal(plan.operations.length, 1);
    assert.ok(plan.skipped.some((skip) => /limit of 1/.test(skip.reason)));
  });

  it('rejects files that are not HAR', async () => {
    const notJson = join(dir, 'notes.txt');
    await writeFile(notJson, 'hello');
    await assert.rejects(
      loadImports({ files: [notJson], targetUrl: TARGET, includeWrites: false, limit: 10 }),
      /is not JSON/,
    );
    const other = join(dir, 'other.json');
    await writeFile(other, '{"hello":1}');
    await assert.rejects(
      loadImports({ files: [other], targetUrl: TARGET, includeWrites: false, limit: 10 }),
      (error) => error instanceof UsageError && /not a HAR file/.test(error.message),
    );
    await assert.rejects(
      loadImports({
        files: [join(dir, 'missing.har')],
        targetUrl: TARGET,
        includeWrites: false,
        limit: 10,
      }),
      /Could not read import file/,
    );
  });
});
