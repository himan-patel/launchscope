import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UsageError } from './errors.js';
import { classifyHost, parseTarget } from './target.js';

describe('parseTarget', () => {
  it('keeps an explicit http(s) URL as given', () => {
    const { url, scope } = parseTarget('https://example.com/pricing?plan=pro');
    assert.equal(url.href, 'https://example.com/pricing?plan=pro');
    assert.equal(scope, 'public');
  });

  it('defaults bare local hosts to http', () => {
    assert.equal(parseTarget('localhost:4200').url.href, 'http://localhost:4200/');
    assert.equal(parseTarget('127.0.0.1:3000/app').url.href, 'http://127.0.0.1:3000/app');
    assert.equal(parseTarget('192.168.1.20').url.protocol, 'http:');
  });

  it('defaults bare public hosts to https', () => {
    assert.equal(parseTarget('example.com').url.href, 'https://example.com/');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(parseTarget('  http://localhost:3000  ').url.port, '3000');
  });

  it('rejects an empty target', () => {
    assert.throws(() => parseTarget('   '), UsageError);
  });

  it('rejects unsupported protocols', () => {
    assert.throws(() => parseTarget('ftp://example.com'), /Unsupported protocol "ftp:"/);
    assert.throws(() => parseTarget('file:///etc/passwd'), UsageError);
  });

  it('rejects malformed URLs', () => {
    assert.throws(() => parseTarget('http://'), UsageError);
    assert.throws(() => parseTarget('http://exa mple.com'), UsageError);
  });

  it('rejects credentials embedded in the URL without echoing them', () => {
    assert.throws(
      () => parseTarget('https://admin:hunter2@example.com'),
      (error) => {
        assert.ok(error instanceof UsageError);
        assert.match(error.message, /Credentials in the target URL are not allowed/);
        assert.doesNotMatch(error.message, /hunter2/);
        return true;
      },
    );
  });
});

describe('classifyHost', () => {
  const cases = /** @type {const} */ ([
    ['localhost', 'loopback'],
    ['LOCALHOST', 'loopback'],
    ['app.localhost', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['0.0.0.0', 'loopback'],
    ['[::1]', 'loopback'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.10', 'private'],
    ['169.254.10.10', 'private'],
    ['100.64.0.1', 'private'],
    ['[fd12:3456::1]', 'private'],
    ['[fe80::1]', 'private'],
    ['[::ffff:10.0.0.1]', 'private'],
    ['printer.local', 'private'],
    ['api.internal', 'private'],
    ['172.15.0.1', 'public'],
    ['172.32.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['[2606:4700::1111]', 'public'],
    ['example.com', 'public'],
    ['localhost.example.com', 'public'],
  ]);

  for (const [hostname, expected] of cases) {
    it(`classifies ${hostname} as ${expected}`, () => {
      assert.equal(classifyHost(hostname), expected);
    });
  }
});
