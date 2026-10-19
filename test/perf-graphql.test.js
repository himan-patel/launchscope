import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer } from './fixtures/app-server.js';
import { runCli } from './helpers/run-cli.js';

describe('launchscope perf GraphQL analysis (fixture app, real Chromium)', () => {
  /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
  let server;
  /** @type {string} */
  let workdir;
  /** @type {any} */
  let summary;

  before(async () => {
    server = await startFixtureServer();
    workdir = await mkdtemp(join(tmpdir(), 'launchscope-graphql-'));
    await writeFile(
      join(workdir, 'launchscope.config.json'),
      JSON.stringify({ perf: { budgets: { apiP95Ms: 200 } } }),
    );
    const result = await runCli(
      ['perf', server.origin, '--routes', '/gql', '--runs', '2', '--json', '--output-dir', 'out'],
      { cwd: workdir },
    );
    assert.equal(result.code, 0, result.stderr);
    summary = JSON.parse(result.stdout);
  });

  after(async () => {
    await server?.close();
    await rm(workdir, { recursive: true, force: true });
  });

  /** @param {string} key */
  const endpoint = (key) => {
    const found = summary.endpoints.find((/** @type {{ key: string }} */ e) => e.key === key);
    assert.ok(found, `missing endpoint ${key}`);
    return found;
  };

  it('splits one /graphql URL into an endpoint per operation', () => {
    const viewer = endpoint(`POST ${server.origin}/graphql GetViewer`);
    const search = endpoint(`POST ${server.origin}/graphql SearchProjects`);
    const feed = endpoint(`GET ${server.origin}/graphql Feed`);
    assert.equal(viewer.graphqlOperation, 'GetViewer');
    assert.equal(viewer.graphqlType, 'query');
    assert.equal(viewer.calls, 4);
    assert.equal(search.calls, 4);
    assert.equal(feed.calls, 2);
    assert.ok(search.durationMs.p50 >= 250, `SearchProjects p50 ${search.durationMs.p50}`);
    assert.ok(viewer.durationMs.p95 < 200, `GetViewer p95 ${viewer.durationMs.p95}`);
  });

  it('flags only the slow operation and names it', () => {
    const slow = summary.bottlenecks.filter(
      (/** @type {{ rule: string }} */ f) => f.rule === 'slow-endpoint',
    );
    assert.deepEqual(
      slow.map((/** @type {{ title: string }} */ f) => f.title.split(' is slow')[0]),
      ['POST /graphql (SearchProjects)'],
    );
  });

  it('treats identical bodies as duplicates but not calls with different variables', () => {
    assert.equal(endpoint(`POST ${server.origin}/graphql GetViewer`).maxIdenticalCallsPerLoad, 2);
    assert.equal(
      endpoint(`POST ${server.origin}/graphql SearchProjects`).maxIdenticalCallsPerLoad,
      1,
    );
    const duplicates = summary.bottlenecks.filter(
      (/** @type {{ rule: string }} */ f) => f.rule === 'duplicate-calls',
    );
    assert.equal(duplicates.length, 1);
    assert.match(duplicates[0].title, /GetViewer/);
  });

  it('labels GraphQL operations in the hop tree and never stores request bodies', async () => {
    const [runName] = await readdir(join(workdir, 'out'));
    const perfDir = join(workdir, 'out', runName, 'perf');
    const tree = await readFile(join(perfDir, 'routes', 'gql', 'trace.txt'), 'utf8');
    assert.match(tree, /POST \/graphql \(SearchProjects\) \[Fetch 200\]/);
    assert.match(tree, /\/graphql \(Feed\) \[Fetch 200\]/);
    const loads = await readFile(join(perfDir, 'routes', 'gql', 'loads.json'), 'utf8');
    assert.doesNotMatch(loads, /query SearchProjects|"variables"/);
  });
});
