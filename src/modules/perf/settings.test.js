import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UsageError } from '../../core/errors.js';
import {
  ALWAYS_EXCLUDED,
  PERF_DEFAULTS,
  resolvePerfSettings,
  toReportableSettings,
} from './settings.js';

/**
 * @param {Partial<Parameters<typeof resolvePerfSettings>[0]>} [overrides]
 */
const resolveWith = (overrides = {}) =>
  resolvePerfSettings({
    target: 'http://localhost:3000',
    cli: {},
    config: undefined,
    cwd: '/work',
    ...overrides,
  });

describe('resolvePerfSettings', () => {
  it('applies defaults when nothing is configured', () => {
    const settings = resolveWith();
    assert.equal(settings.targetUrl.href, 'http://localhost:3000/');
    assert.equal(settings.scope, 'loopback');
    assert.deepEqual(settings.routes, []);
    assert.equal(settings.runs, PERF_DEFAULTS.runs);
    assert.equal(settings.depth, PERF_DEFAULTS.depth);
    assert.equal(settings.sitemap, true);
    assert.equal(settings.device, 'desktop');
    assert.equal(settings.timeoutMs, 30_000);
    assert.equal(settings.failOn, 'none');
    assert.deepEqual(settings.headers, {});
    assert.equal(settings.stress.enabled, false);
    assert.deepEqual(settings.stress.stages, [1, 5, 10, 25, 50]);
  });

  it('lets CLI options override config, and config override defaults', () => {
    const settings = resolveWith({
      cli: { runs: '7', device: 'mobile' },
      config: { runs: 2, throttle: '4g', timeout: '45s' },
    });
    assert.equal(settings.runs, 7);
    assert.equal(settings.device, 'mobile');
    assert.equal(settings.throttle, '4g');
    assert.equal(settings.timeoutMs, 45_000);
  });

  it('resolves explicit routes against the target and disables crawling by default', () => {
    const settings = resolveWith({ cli: { routes: '/, /pricing,/app#tab, /pricing' } });
    assert.deepEqual(settings.routes, [
      'http://localhost:3000/',
      'http://localhost:3000/pricing',
      'http://localhost:3000/app',
    ]);
    assert.equal(settings.depth, 0);
    assert.equal(settings.sitemap, false);
  });

  it('still crawls with explicit routes when depth is set', () => {
    const settings = resolveWith({ cli: { routes: '/', depth: '2' } });
    assert.equal(settings.depth, 2);
  });

  it('rejects routes on another origin', () => {
    assert.throws(
      () => resolveWith({ config: { routes: ['https://evil.example/'] } }),
      /not on the target origin http:\/\/localhost:3000/,
    );
  });

  it('validates integer ranges with the option name', () => {
    assert.throws(() => resolveWith({ cli: { runs: '0' } }), /--runs must be a whole number/);
    assert.throws(() => resolveWith({ cli: { runs: '2.5' } }), UsageError);
    assert.throws(() => resolveWith({ cli: { depth: '9' } }), /--depth .* from 0 to 5/);
  });

  it('validates choices', () => {
    assert.throws(() => resolveWith({ config: { device: 'tablet' } }), /--device must be one of/);
    assert.throws(() => resolveWith({ cli: { failOn: 'sometimes' } }), /--fail-on/);
  });

  it('rejects unknown config keys to catch typos', () => {
    assert.throws(
      () => resolveWith({ config: { rnus: 3 } }),
      /Unknown key\(s\) in config "perf": rnus/,
    );
    assert.throws(
      () => resolveWith({ config: { stress: { stage: [1] } } }),
      /Unknown key\(s\) in config "perf.stress": stage/,
    );
  });

  it('merges headers from config and CLI, lowercasing names', () => {
    const settings = resolveWith({
      cli: { header: ['X-Trace: abc', 'Authorization: Bearer cli-token'] },
      config: { headers: { Authorization: 'Bearer config-token', 'X-Env': 'staging' } },
    });
    assert.deepEqual(settings.headers, {
      authorization: 'Bearer cli-token',
      'x-env': 'staging',
      'x-trace': 'abc',
    });
  });

  it('rejects malformed and browser-managed headers', () => {
    assert.throws(() => resolveWith({ cli: { header: ['no-colon'] } }), /Name: value/);
    assert.throws(() => resolveWith({ cli: { header: ['Host: x'] } }), /managed by the browser/);
    assert.throws(() => resolveWith({ cli: { header: ['Bad Name: x'] } }), /not a valid header/);
    assert.throws(
      () => resolveWith({ config: { headers: { 'x-a': 'one\r\nx-b: two' } } }),
      /must not contain line breaks/,
    );
  });

  it('compiles exclude patterns case-insensitively and rejects invalid ones', () => {
    const settings = resolveWith({ cli: { exclude: ['/admin', '\\.pdf$'] } });
    assert.ok(settings.exclude[0].test('http://localhost:3000/ADMIN/users'));
    assert.throws(() => resolveWith({ cli: { exclude: ['('] } }), /not a valid regular expression/);
  });

  it('resolves the storage state path against cwd', () => {
    assert.equal(
      resolveWith({ cli: { storageState: '.auth/state.json' } }).storageStatePath,
      '/work/.auth/state.json',
    );
  });

  it('parses stress options and enforces increasing stages', () => {
    const settings = resolveWith({
      cli: { stress: true, stressStages: '2, 4, 8', stressDuration: '5s' },
      config: { stress: { maxErrorRate: 0.2, includeAssets: true } },
    });
    assert.deepEqual(settings.stress, {
      enabled: true,
      stages: [2, 4, 8],
      stageDurationMs: 5000,
      requestTimeoutMs: 10_000,
      includeAssets: true,
      allowRemote: false,
      maxErrorRate: 0.2,
    });
    assert.throws(() => resolveWith({ cli: { stressStages: '10,5' } }), /strictly increasing/);
    assert.throws(() => resolveWith({ cli: { stressStages: '1,5000' } }), /from 1 to 1000/);
    assert.throws(() => resolveWith({ config: { stress: { maxErrorRate: 2 } } }), /maxErrorRate/);
  });
});

describe('trace context settings', () => {
  it('is off by default and enabled by flag, config, or a URL template', () => {
    assert.deepEqual(resolveWith().traceContext, { enabled: false, urlTemplate: undefined });
    assert.equal(resolveWith({ cli: { traceContext: true } }).traceContext.enabled, true);
    assert.equal(resolveWith({ config: { traceContext: true } }).traceContext.enabled, true);
    assert.deepEqual(
      resolveWith({ config: { traceContext: { urlTemplate: 'https://t.test/{traceId}' } } })
        .traceContext,
      { enabled: true, urlTemplate: 'https://t.test/{traceId}' },
    );
    assert.deepEqual(
      resolveWith({ cli: { traceUrl: 'https://t.test/x/{traceId}' } }).traceContext,
      {
        enabled: true,
        urlTemplate: 'https://t.test/x/{traceId}',
      },
    );
  });

  it('validates the template and config shape', () => {
    assert.throws(
      () => resolveWith({ cli: { traceUrl: 'ftp://t.test/{traceId}' } }),
      /http\(s\) URL/,
    );
    assert.throws(() => resolveWith({ cli: { traceUrl: 'https://t.test/trace' } }), /\{traceId\}/);
    assert.throws(() => resolveWith({ config: { traceContext: { url: 'x' } } }), /Unknown key/);
    assert.throws(() => resolveWith({ config: { traceContext: 'yes' } }), /true\/false/);
  });
});

describe('toReportableSettings', () => {
  it('redacts header values so secrets never reach report files', () => {
    const settings = resolveWith({ cli: { header: ['Authorization: Bearer secret-token'] } });
    const reportable = toReportableSettings(settings);
    assert.deepEqual(reportable.headers, { authorization: '[redacted]' });
    assert.doesNotMatch(JSON.stringify(reportable), /secret-token/);
    assert.equal(reportable.targetUrl, 'http://localhost:3000/');
  });
});

describe('ALWAYS_EXCLUDED', () => {
  it('matches common logout routes but not lookalikes', () => {
    for (const url of ['/logout', '/auth/sign-out', '/account/signout?next=/', '/log-off']) {
      assert.ok(ALWAYS_EXCLUDED.test(url), url);
    }
    for (const url of ['/logouts-history', '/blog/outline', '/catalog']) {
      assert.ok(!ALWAYS_EXCLUDED.test(url), url);
    }
  });
});
