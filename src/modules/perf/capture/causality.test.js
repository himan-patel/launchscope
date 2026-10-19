import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyObservedCauses } from './causality.js';

/** @param {string} id @param {string} url @param {Record<string, unknown>} [extra] */
const record = (id, url, extra = {}) =>
  /** @type {import('./network-recorder.js').RequestRecord} */ (
    /** @type {unknown} */ ({
      id,
      url,
      method: 'GET',
      resourceType: 'Fetch',
      startMs: Number(id.replace(/\D/g, '')),
      redirects: [],
      causedBy: null,
      ...extra,
    })
  );

describe('applyObservedCauses', () => {
  it('matches calls to records in order and links observed causes', () => {
    const requests = [
      record('r1', 'https://a.test/api/me'),
      record('r2', 'https://a.test/api/me'),
      record('r3', 'https://a.test/api/list?u=7'),
      record('r4', 'https://a.test/style.css', { resourceType: 'Stylesheet' }),
    ];
    const result = applyObservedCauses(requests, [
      { id: 1, url: 'https://a.test/api/me', method: 'GET', causeId: null },
      { id: 2, url: 'https://a.test/api/list?u=7', method: 'GET', causeId: 1 },
      { id: 3, url: 'https://a.test/api/me', method: 'GET', causeId: 2 },
    ]);
    assert.deepEqual(result, { matched: 3, linked: 2 });
    assert.equal(requests[0].causedBy, null);
    assert.equal(requests[2].causedBy, 'r1');
    assert.equal(requests[1].causedBy, 'r3', 'second /api/me matched to the second record');
  });

  it('matches the URL the page requested, before redirects, and respects the method', () => {
    const requests = [
      record('r1', 'https://a.test/api/me'),
      record('r2', 'https://a.test/api/v2/items', {
        redirects: [{ url: 'https://a.test/api/items', status: 301, startMs: 0, endMs: 1 }],
      }),
      record('r3', 'https://a.test/api/items', { method: 'POST' }),
    ];
    applyObservedCauses(requests, [
      { id: 1, url: 'https://a.test/api/me', method: 'GET', causeId: null },
      { id: 2, url: 'https://a.test/api/items', method: 'POST', causeId: 1 },
      { id: 3, url: 'https://a.test/api/items', method: 'GET', causeId: 1 },
    ]);
    assert.equal(requests[2].causedBy, 'r1');
    assert.equal(requests[1].causedBy, 'r1');
  });

  it('leaves calls without a network record unlinked', () => {
    const requests = [record('r1', 'https://a.test/api/b')];
    const result = applyObservedCauses(requests, [
      { id: 1, url: 'https://a.test/api/cached', method: 'GET', causeId: null },
      { id: 2, url: 'https://a.test/api/b', method: 'GET', causeId: 1 },
    ]);
    assert.deepEqual(result, { matched: 1, linked: 0 });
    assert.equal(requests[0].causedBy, null);
  });
});
