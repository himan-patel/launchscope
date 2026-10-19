import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf --repo', () => {
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
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-repo-e2e-'));
    // A Next.js-style app whose routes match the fixture server.
    const files = {
      'web/app/page.tsx': '',
      'web/app/(site)/about/page.tsx': '',
      'web/app/live/page.tsx': '',
      'web/app/blog/[slug]/page.tsx': '',
      'web/app/api/unlinked/route.ts': 'export async function GET() { return Response.json({}) }',
    };
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(workdir, path)), { recursive: true });
      await writeFile(join(workdir, path), contents);
    }
    const result = await runCli(
      [
        'perf',
        server.origin,
        '--routes',
        '/',
        '--runs',
        '1',
        '--repo',
        'web',
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

  it('reports what it found in the repository', () => {
    assert.match(
      stderr,
      /Repo {5}3 page route\(s\), 1 GET API route\(s\) \(next-app\) · 1 need routeParams/,
    );
    assert.deepEqual(summary.repo.frameworks, ['next-app']);
    assert.equal(summary.repo.skipped[0].route, '/blog/[slug]');
  });

  it('measures pages that only the repository knows about', () => {
    const measured = summary.routes.map((/** @type {{ url: string, source: string }} */ r) => [
      new URL(r.url).pathname,
      r.source,
    ]);
    assert.deepEqual(measured, [
      ['/', 'seed'],
      ['/about', 'repo'],
      ['/live', 'repo'],
    ]);
  });

  it('measures repository API routes directly', async () => {
    const unlinked = summary.endpoints.find((/** @type {{ key: string }} */ e) =>
      e.key.endsWith('/api/unlinked'),
    );
    assert.ok(unlinked);
    assert.deepEqual(unlinked.discoveredBy, ['repo']);
    const [runName] = await readdir(join(workdir, 'out'));
    const repo = JSON.parse(
      await readFile(join(workdir, 'out', runName, 'perf', 'repo.json'), 'utf8'),
    );
    assert.deepEqual(repo.apis, ['/api/unlinked']);
  });
});
