import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf --spa (client-side navigations)', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;
  /** @type {any} */
  let summary;
  /** @type {string} */
  let stderr;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-spa-'));
    await writeFile(
      join(workdir, 'launchscope.config.json'),
      JSON.stringify({ perf: { budgets: { navigationMs: 200, chainLength: 2 } } }),
    );
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/spa,/spa/a,/spa/b,/about',
        '--runs',
        '2',
        '--spa',
        '--spa-max',
        '3',
        '--json',
        '-o',
        'out',
      ],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    stderr = result.stderr;
    summary = JSON.parse(result.stdout);
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  /** @param {string} to */
  const navigation = (to) =>
    summary.navigations.find((/** @type {{ to: string }} */ n) => new URL(n.to).pathname === to);

  it('measures links between measured routes, up to --spa-max', () => {
    assert.equal(summary.navigations.length, 3);
    assert.deepEqual(
      summary.navigations.map((/** @type {{ from: string, to: string }} */ n) => [
        new URL(n.from).pathname,
        new URL(n.to).pathname,
      ]),
      [
        ['/spa', '/spa/a'],
        ['/spa', '/spa/b'],
        ['/spa', '/about'],
      ],
    );
    assert.match(stderr, /Navigations · 3 link\(s\) between measured routes, 2 run\(s\) each/);
  });

  it('measures a client-side transition from click until data and DOM settle', () => {
    const toB = navigation('/spa/b');
    assert.equal(toB.kind, 'soft');
    assert.equal(toB.runs, 2);
    assert.ok(toB.durationMs.p50 >= 250, `duration ${toB.durationMs.p50}`);
    assert.ok(toB.renderMs.p50 >= 250, 'render finishes after the slow API returns');
    assert.equal(toB.apiCalls.p50, 2);
    assert.deepEqual(
      toB.requests.map((/** @type {{ label: string }} */ r) => r.label),
      ['GET /api/me', 'GET /api/slow?user=7'],
    );
    assert.equal(toB.longestChain.ids.length, 2, 'me → slow chain');
  });

  it('detects a link that reloads the whole page', () => {
    const toAbout = navigation('/about');
    assert.equal(toAbout.kind, 'full');
    assert.ok(
      summary.bottlenecks.some(
        (/** @type {{ rule: string }} */ f) => f.rule === 'full-reload-navigation',
      ),
    );
  });

  it('raises navigation findings against budgets', () => {
    const rules = summary.bottlenecks.map(
      (/** @type {{ rule: string, title: string }} */ f) => `${f.rule}: ${f.title}`,
    );
    assert.ok(
      rules.some((/** @type {string} */ rule) =>
        /^slow-navigation: Navigating \/spa → \/spa\/b takes/.test(rule),
      ),
      rules.join('\n'),
    );
    assert.ok(
      rules.some((/** @type {string} */ rule) =>
        /^navigation-api-chain: Navigating \/spa → \/spa\/b waits on 2 sequential API calls/.test(
          rule,
        ),
      ),
    );
  });

  it('writes navigations.json and a report section', async () => {
    const [runName] = await readdir(join(workdir, 'out'));
    const perfDir = join(workdir, 'out', runName, 'perf');
    const saved = JSON.parse(await readFile(join(perfDir, 'navigations.json'), 'utf8'));
    assert.equal(saved.length, 3);
    const html = await readFile(join(perfDir, 'index.html'), 'utf8');
    assert.match(html, /id="navigations"/);
    assert.match(html, /client-side/);
    assert.match(html, /full page load/);
    const markdown = await readFile(join(perfDir, 'summary.md'), 'utf8');
    assert.match(markdown, /## Client-side navigations/);
  });
});
