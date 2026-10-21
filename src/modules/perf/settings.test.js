import assert from 'node:assert/strict';
import { resolve } from 'node:path';
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
      resolve('/work', '.auth/state.json'),
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
      mode: 'closed',
      rates: [1, 5, 10, 25, 50],
      maxInFlight: 1000,
      replay: [],
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

describe('open-model stress settings', () => {
  it('parses mode, rates, and the in-flight cap', () => {
    const settings = resolveWith({
      cli: { stressMode: 'open', stressRates: '0.5, 2, 8' },
      config: { stress: { maxInFlight: 50 } },
    });
    assert.equal(settings.stress.mode, 'open');
    assert.deepEqual(settings.stress.rates, [0.5, 2, 8]);
    assert.equal(settings.stress.maxInFlight, 50);
  });

  it('rejects bad rates', () => {
    assert.throws(() => resolveWith({ cli: { stressRates: '5,2' } }), /strictly increasing/);
    assert.throws(() => resolveWith({ cli: { stressRates: '0' } }), /above 0/);
    assert.throws(
      () => resolveWith({ config: { stress: { mode: 'burst' } } }),
      /--stress-mode must be one of/,
    );
  });
});

describe('endpoint settings', () => {
  it('resolves listed endpoints against the target, GET by default, without duplicates', () => {
    const settings = resolveWith({
      cli: {
        endpoint: ['/api/health', 'get /api/items?page=1', 'http://localhost:3000/api/health'],
      },
    });
    assert.deepEqual(settings.endpoints, [
      { url: 'http://localhost:3000/api/health', path: '/api/health', operationId: null },
      { url: 'http://localhost:3000/api/items?page=1', path: '/api/items', operationId: null },
    ]);
    assert.equal(resolveWith({ config: { endpoints: ['/api/me'] } }).endpoints.length, 1);
  });

  it('refuses writes, other origins, and malformed entries', () => {
    assert.throws(() => resolveWith({ cli: { endpoint: ['POST /api/orders'] } }), /only GET/);
    assert.throws(
      () => resolveWith({ cli: { endpoint: ['https://other.test/api'] } }),
      /not on the target origin/,
    );
    assert.throws(() => resolveWith({ cli: { endpoint: ['GET /a /b'] } }), /must look like/);
    assert.throws(() => resolveWith({ config: { endpoints: [42] } }), /must be strings/);
  });
});

describe('api mode', () => {
  it('turns off page-only features and looks for a spec when nothing is listed', () => {
    const settings = resolveWith({
      mode: 'api',
      config: { routes: ['/about'], spa: true, lighthouse: true, browsers: 'chromium,firefox' },
    });
    assert.equal(settings.mode, 'api');
    assert.deepEqual(settings.routes, []);
    assert.equal(settings.sitemap, false);
    assert.equal(settings.spa, false);
    assert.equal(settings.lighthouse, false);
    assert.deepEqual(settings.browsers, ['chromium']);
    assert.equal(settings.openapi, 'auto');
  });

  it('does not guess a spec when endpoints are listed', () => {
    const settings = resolveWith({ mode: 'api', cli: { endpoint: ['/api/me'] } });
    assert.equal(settings.openapi, undefined);
    assert.equal(resolveWith().mode, 'pages');
    assert.equal(resolveWith().openapi, undefined);
  });
});

describe('toReportableSettings', () => {
  it('redacts query values of listed endpoints', () => {
    const settings = resolveWith({ cli: { endpoint: ['/api/items?api_key=secret&page=2', '/x'] } });
    assert.deepEqual(toReportableSettings(settings).endpoints, [
      'http://localhost:3000/api/items?api_key=[redacted]&page=[redacted]',
      'http://localhost:3000/x',
    ]);
  });

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
