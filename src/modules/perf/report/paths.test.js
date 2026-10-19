import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignRouteSlugs, slugifyRoute } from './paths.js';

describe('slugifyRoute', () => {
  it('names the root route "home"', () => {
    assert.equal(slugifyRoute('http://localhost:3000/'), 'home');
  });

  it('flattens paths and queries into safe names', () => {
    assert.equal(slugifyRoute('http://x.test/app/Settings'), 'app-settings');
    assert.equal(slugifyRoute('http://x.test/search?q=shoes&page=2'), 'search-q-shoes-page-2');
  });

  it('shortens long paths with a stable hash', () => {
    const url = `http://x.test/${'segment/'.repeat(20)}`;
    const slug = slugifyRoute(url);
    assert.ok(slug.length <= 60);
    assert.match(slug, /-[0-9a-f]{8}$/);
    assert.equal(slugifyRoute(url), slug);
  });
});

describe('assignRouteSlugs', () => {
  it('disambiguates routes that slugify to the same name', () => {
    const slugs = assignRouteSlugs(['http://x.test/a-b', 'http://x.test/a/b', 'http://x.test/']);
    assert.deepEqual([...slugs.values()], ['a-b', 'a-b-2', 'home']);
  });
});
