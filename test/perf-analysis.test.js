import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf analysis (fixture app, real Chromium)', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;
  /** @type {{ code: number, stdout: string, stderr: string }} */
  let result;
  /** @type {any} */
  let summary;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-analysis-'));
    result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/,/dashboard,/old-about',
        '--runs',
        '2',
        '--json',
        '--output-dir',
        'out',
      ],
      { cwd: workdir },
    );
    summary = JSON.parse(result.stdout);
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  /** @param {string} rule */
  const findingsFor = (rule) =>
    summary.bottlenecks.filter((/** @type {{ rule: string }} */ finding) => finding.rule === rule);

  it('prints the summary as JSON on stdout and progress on stderr', () => {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.tool.name, 'launchscope');
    assert.equal(summary.totals.routes, 3);
    assert.equal(summary.totals.pageLoads, 6);
    assert.match(result.stderr, /Bottlenecks · \d+ critical, \d+ warning, \d+ info/);
  });

  it('writes summary, endpoints, and bottlenecks files', async () => {
    const [runName] = await readdir(join(workdir, 'out'));
    const files = await readdir(join(workdir, 'out', runName, 'perf'));
    for (const file of ['summary.json', 'endpoints.json', 'bottlenecks.json', 'routes.json']) {
      assert.ok(files.includes(file), file);
    }
    const onDisk = JSON.parse(
      await readFile(join(workdir, 'out', runName, 'perf', 'bottlenecks.json'), 'utf8'),
    );
    assert.deepEqual(onDisk, summary.bottlenecks);
  });

  it('summarizes routes with cold-run distributions', () => {
    const dashboard = summary.routes.find(
      (/** @type {{ slug: string }} */ r) => r.slug === 'dashboard',
    );
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.runs.cold, 2);
    assert.equal(dashboard.metrics.lcpMs.count, 2);
    assert.equal(dashboard.metrics.apiCalls.p50, 5);
    assert.ok(
      dashboard.resourceTypes.some((/** @type {{ type: string }} */ t) => t.type === 'Fetch'),
    );
  });

  it('aggregates endpoints with templated paths', () => {
    const keys = summary.endpoints.map((/** @type {{ key: string }} */ e) => e.key);
    assert.ok(keys.includes(`GET ${server.origin}/api/items/:id`));
    const projects = summary.endpoints.find(
      (/** @type {{ key: string }} */ e) => e.key === `GET ${server.origin}/api/projects`,
    );
    assert.equal(projects.calls, 2);
    assert.equal(projects.largestJsonArray, 2000);
  });

  it('detects the sequential API chain on the dashboard', () => {
    const [chain] = findingsFor('api-chain');
    assert.ok(chain, 'api-chain finding');
    assert.equal(chain.subject.route, 'dashboard');
    assert.equal(chain.evidence.calls, 3);
  });

  it('detects the oversized, uncompressed projects payload', () => {
    assert.equal(findingsFor('oversized-collection')[0]?.severity, 'critical');
    assert.ok(
      findingsFor('uncompressed').some((/** @type {{ subject: { endpoint: string } }} */ f) =>
        f.subject.endpoint.endsWith('/api/projects'),
      ),
    );
  });

  it('detects the duplicate /api/me call', () => {
    const [duplicate] = findingsFor('duplicate-calls');
    assert.ok(duplicate.subject.endpoint.endsWith('/api/me'));
    assert.equal(duplicate.evidence.identicalCalls, 2);
  });

  it('detects the redirect and missing static cache headers', () => {
    assert.ok(
      findingsFor('redirect').some(
        (/** @type {{ subject: { route: string } }} */ f) => f.subject.route === 'old-about',
      ),
    );
    assert.ok(findingsFor('static-cache').length > 0);
  });

  it('orders findings by severity', () => {
    const order = { critical: 0, warning: 1, info: 2 };
    const severities = summary.bottlenecks.map(
      (/** @type {{ severity: 'critical' | 'warning' | 'info' }} */ f) => order[f.severity],
    );
    assert.deepEqual(
      severities,
      [...severities].sort((a, b) => a - b),
    );
  });

  it('exits 1 with --fail-on when findings reach the level, after writing reports', async () => {
    const failing = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/dashboard',
        '--runs',
        '1',
        '--fail-on',
        'critical',
        '--output-dir',
        'fail',
      ],
      { cwd: workdir },
    );
    assert.equal(failing.code, 1, failing.stderr);
    assert.match(failing.stderr, /bottleneck\(s\) at or above "critical" \(--fail-on critical\)/);
    const [runName] = await readdir(join(workdir, 'fail'));
    assert.ok((await readdir(join(workdir, 'fail', runName, 'perf'))).includes('summary.json'));
  });

  it('flags the slow endpoint with its Server-Timing breakdown when budgets are tightened', async () => {
    const config = join(workdir, 'tight.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      config,
      JSON.stringify({ perf: { budgets: { apiP95Ms: 200, serverWaitMs: 150 } } }),
    );
    const tight = await runCli(
      [
        '--config',
        config,
        'perf',
        server.origin,
        '--routes',
        '/dashboard',
        '--runs',
        '1',
        '--json',
        '--output-dir',
        'tight',
      ],
      { cwd: workdir },
    );
    assert.equal(tight.code, 0, tight.stderr);
    const slow = JSON.parse(tight.stdout).bottlenecks.find(
      (/** @type {{ rule: string, subject: { endpoint?: string } }} */ f) =>
        f.rule === 'slow-endpoint' && f.subject.endpoint?.endsWith('/api/slow'),
    );
    assert.ok(slow, 'slow-endpoint finding for /api/slow');
    assert.match(slow.detail, /Server-Timing: "db" averages/);
    assert.match(slow.recommendation, /Start with "db"/);
  });
});
