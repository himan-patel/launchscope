import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectGraphqlOperation, looksLikeGraphql } from './graphql.js';

describe('looksLikeGraphql', () => {
  it('matches GraphQL endpoints and GET documents', () => {
    assert.equal(looksLikeGraphql('https://api.test/graphql'), true);
    assert.equal(looksLikeGraphql('https://api.test/v1/GraphQL/'), true);
    assert.equal(looksLikeGraphql('https://api.test/gql'), true);
    assert.equal(looksLikeGraphql('https://api.test/api?query=%7B%20me%20%7D'), true);
    assert.equal(looksLikeGraphql('https://api.test/search?query=shoes'), false);
    assert.equal(looksLikeGraphql('https://api.test/api/graphql-docs'), false);
  });
});

describe('detectGraphqlOperation', () => {
  const post = (/** @type {unknown} */ body) => ({
    url: 'https://api.test/graphql',
    method: 'POST',
    postData: JSON.stringify(body),
  });

  it('prefers operationName and reads the type from the document', () => {
    assert.deepEqual(
      detectGraphqlOperation(
        post({ operationName: 'GetUser', query: 'query GetUser { me { id } }' }),
      ),
      { name: 'GetUser', type: 'query', persisted: false },
    );
  });

  it('reads the name from the document when operationName is missing', () => {
    assert.deepEqual(
      detectGraphqlOperation(
        post({ query: '# comment\nmutation SaveDraft($x: ID) { save(id: $x) }' }),
      ),
      { name: 'SaveDraft', type: 'mutation', persisted: false },
    );
  });

  it('labels anonymous and shorthand queries', () => {
    assert.deepEqual(detectGraphqlOperation(post({ query: '{ me { id } }' })), {
      name: '(anonymous)',
      type: 'query',
      persisted: false,
    });
  });

  it('handles persisted queries without query text', () => {
    assert.deepEqual(
      detectGraphqlOperation(
        post({
          operationName: 'Feed',
          extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } },
        }),
      ),
      { name: 'Feed', type: null, persisted: true },
    );
  });

  it('combines batched operations', () => {
    assert.deepEqual(
      detectGraphqlOperation(
        post([
          { operationName: 'GetUser', query: 'query GetUser { me { id } }' },
          { operationName: 'GetFlags', query: 'query GetFlags { flags }' },
        ]),
      ),
      { name: 'GetUser+GetFlags', type: 'query', persisted: false },
    );
  });

  it('reads GET requests from the query string', () => {
    const url = `https://api.test/graphql?operationName=Search&query=${encodeURIComponent('query Search($q: String) { search(q: $q) }')}`;
    assert.deepEqual(detectGraphqlOperation({ url, method: 'GET' }), {
      name: 'Search',
      type: 'query',
      persisted: false,
    });
  });

  it('rejects unsafe names and non-GraphQL bodies', () => {
    assert.equal(
      detectGraphqlOperation(post({ operationName: '<script>', query: 'query { a }' }))?.name,
      '(anonymous)',
    );
    assert.equal(detectGraphqlOperation(post({ hello: 'world' })), null);
    assert.equal(
      detectGraphqlOperation({
        url: 'https://api.test/graphql',
        method: 'POST',
        postData: 'not json',
      }),
      null,
    );
    assert.equal(detectGraphqlOperation({ url: 'https://api.test/graphql', method: 'GET' }), null);
  });
});
