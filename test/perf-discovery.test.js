import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { saveSession } from '../src/commands/login.js';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

/**
 * @param {string} outDir
 * @returns {Promise<{ perfDir: string, routes: { measured: Array<{ url: string, slug: string, depth: number, source: string }>, skipped: Record<string, number> } }>}
 */
async function readRun(outDir) {
  const [runName] = await readdir(outDir);
  const perfDir = join(outDir, runName, 'perf');
  const routes = JSON.parse(await readFile(join(perfDir, 'routes.json'), 'utf8'));
  return { perfDir, routes };
}

describe('launchscope perf route discovery (fixture app)', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
  });

  after(async () => {
    await server?.close();
  });

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-discovery-'));
    server.hits.clear();
  });

  /** @param {string} url */
  const pathOf = (url) => new URL(url).pathname;

  it('crawls links one level deep, adds sitemap routes, and never visits logout', async () => {
    const result = await runCli(['perf', server.origin, '--runs', '1', '--output-dir', 'out'], {
      cwd: workdir,
    });
    assert.equal(result.code, 0, result.stderr);

    const { routes } = await readRun(join(workdir, 'out'));
    const measured = routes.measured.map((route) => [pathOf(route.url), route.source, route.depth]);
    assert.deepEqual(measured, [
      ['/', 'seed', 0],
      ['/about', 'sitemap', 1],
      ['/dashboard', 'sitemap', 1],
      ['/old-about', 'link', 1],
    ]);
    assert.equal(server.hits.get('/logout'), undefined, 'logout must never be requested');
    assert.equal(server.hits.get('/files/report.pdf'), undefined);
    assert.equal(server.hits.get('/deep'), undefined, 'depth 1 stops before /deep');
    assert.ok((routes.skipped.logout ?? 0) >= 1);
    assert.ok((routes.skipped['off-origin'] ?? 0) >= 1);
    assert.ok((routes.skipped['not-a-page'] ?? 0) >= 1);
    assert.match(result.stderr, /Measured 4 route\(s\)/);
  });

  it('follows deeper links with --depth and honors --max-routes and --exclude', async () => {
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--runs',
        '1',
        '--depth',
        '2',
        '--no-sitemap',
        '--exclude',
        'dashboard',
        '--max-routes',
        '4',
        '--output-dir',
        'out',
      ],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    const { routes } = await readRun(join(workdir, 'out'));
    assert.deepEqual(
      routes.measured.map((route) => pathOf(route.url)),
      ['/', '/about', '/old-about', '/deep'],
    );
    assert.equal(server.hits.get('/dashboard'), undefined);
    assert.ok((routes.skipped.excluded ?? 0) >= 1);
  });

  it('measures only explicit routes by default when --routes is given', async () => {
    const result = await runCli(
      ['perf', server.origin, '--routes', '/about', '--runs', '1', '--output-dir', 'out'],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    const { routes, perfDir } = await readRun(join(workdir, 'out'));
    assert.deepEqual(
      routes.measured.map((route) => pathOf(route.url)),
      ['/about'],
    );
    assert.equal(server.hits.get('/sitemap.xml'), undefined);
    const files = await readdir(join(perfDir, 'routes', 'about'));
    assert.deepEqual(files.sort(), ['loads.json', 'screenshot.png', 'trace.json', 'trace.txt']);
  });
});

describe('authenticated measurement with a saved session', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-auth-'));
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  it('saves a session with owner-only permissions and reuses it with --storage-state', async () => {
    const savePath = join(workdir, '.auth', 'session.json');
    const browser = await chromium.launch();
    try {
      const saved = await saveSession({
        browser,
        url: `${server.origin}/`,
        savePath,
        // Stands in for the user signing in by hand.
        waitForUser: async (page) => {
          await page.goto(`${server.origin}/login`);
        },
      });
      assert.equal(saved.cookies, 1);
    } finally {
      await browser.close();
    }

    const mode = (await stat(savePath)).mode & 0o777;
    assert.equal(mode, 0o600, `session file mode ${mode.toString(8)}`);

    const unauthenticated = await runCli(
      ['perf', server.origin, '--routes', '/private', '--runs', '1', '--output-dir', 'anon'],
      { cwd: workdir },
    );
    assert.equal(unauthenticated.code, 0, unauthenticated.stderr);
    assert.match(unauthenticated.stderr, /\/private {2}401/);

    const authenticated = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/private',
        '--runs',
        '1',
        '--storage-state',
        savePath,
        '--output-dir',
        'signed-in',
      ],
      { cwd: workdir },
    );
    assert.equal(authenticated.code, 0, authenticated.stderr);
    assert.match(authenticated.stderr, /\/private {2}200/);

    const { perfDir } = await readRun(join(workdir, 'signed-in'));
    const settingsText = await readFile(join(perfDir, 'settings.json'), 'utf8');
    assert.doesNotMatch(settingsText, /session=valid|"value"/, 'cookies never reach reports');
  });

  it('fails clearly when the storage state file is missing', async () => {
    const result = await runCli(
      ['perf', server.origin, '--storage-state', 'nope.json', '--runs', '1'],
      { cwd: workdir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Storage state file .*nope\.json does not exist/);
  });
});
