import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REDACTED, redactHar, redactUrl } from './har.js';

describe('redactHar', () => {
  const har = () => ({
    log: {
      pages: [{ title: 'https://app.test/cb?code=abc123' }],
      entries: [
        {
          request: {
            url: 'https://app.test/api/me?access_token=t0k3n&page=2',
            headers: [
              { name: 'Authorization', value: 'Bearer secret' },
              { name: 'Cookie', value: 'session=abc' },
              { name: 'X-Custom-Session-Id', value: 's1' },
              { name: 'Accept', value: 'application/json' },
            ],
            cookies: [{ name: 'session', value: 'abc' }],
            queryString: [
              { name: 'access_token', value: 't0k3n' },
              { name: 'page', value: '2' },
            ],
            postData: { mimeType: 'application/json', text: '{"password":"hunter2"}' },
          },
          response: {
            headers: [
              { name: 'Set-Cookie', value: 'session=new; HttpOnly' },
              { name: 'Content-Type', value: 'application/json' },
            ],
            cookies: [{ name: 'session', value: 'new' }],
            redirectURL: 'https://app.test/next?token=zzz',
            content: { size: 10, mimeType: 'application/json', text: '{"secret":1}' },
          },
        },
      ],
    },
  });

  it('removes credentials, cookies, sensitive params, and bodies', () => {
    const redacted = redactHar(har());
    const text = JSON.stringify(redacted);
    for (const secret of [
      'Bearer secret',
      'session=abc',
      't0k3n',
      'hunter2',
      'session=new',
      'zzz',
      'abc123',
      '"secret":1',
      's1',
    ]) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
    const [entry] = redacted.log.entries;
    assert.deepEqual(
      entry.request.headers.map((/** @type {{ value: string }} */ header) => header.value),
      [REDACTED, REDACTED, REDACTED, 'application/json'],
    );
    assert.deepEqual(entry.request.cookies, []);
    assert.equal(entry.request.postData, undefined);
    assert.deepEqual(entry.request.queryString[1], { name: 'page', value: '2' });
    assert.equal(entry.response.content.text, undefined);
    assert.equal(entry.response.content.size, 10, 'sizes are kept');
  });
});

describe('redactUrl', () => {
  it('redacts sensitive query parameters and embedded credentials only', () => {
    assert.equal(
      redactUrl('https://u:p@app.test/x?sig=1&q=shoes'),
      `https://app.test/x?sig=${encodeURIComponent(REDACTED)}&q=shoes`,
    );
    assert.equal(redactUrl('not a url'), 'not a url');
  });
});
