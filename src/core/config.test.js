import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CONFIG_FILENAME, loadConfig } from './config.js';
import { UsageError } from './errors.js';

describe('loadConfig', () => {
  /** @type {string} */
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'launchscope-config-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * @param {string} name
   * @param {string} contents
   */
  const writeConfig = async (name, contents) => {
    const path = join(dir, name);
    await writeFile(path, contents, 'utf8');
    return path;
  };

  it('returns empty values when no default config file exists', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'launchscope-empty-'));
    try {
      assert.deepEqual(await loadConfig({ cwd: empty, env: {} }), { path: null, values: {} });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('loads the default config file from cwd', async () => {
    const path = await writeConfig(CONFIG_FILENAME, '{ "outputDir": "reports", "perf": {} }');
    const config = await loadConfig({ cwd: dir, env: {} });
    assert.equal(config.path, path);
    assert.deepEqual(config.values, { outputDir: 'reports', perf: {} });
  });

  it('fails when an explicit config path does not exist', async () => {
    await assert.rejects(
      loadConfig({ cwd: dir, env: {}, explicitPath: 'missing.json' }),
      (error) => error instanceof UsageError && /Could not read config file/.test(error.message),
    );
  });

  it('reports invalid JSON with the file path', async () => {
    const path = await writeConfig('broken.json', '{ "outputDir": ');
    await assert.rejects(
      loadConfig({ cwd: dir, env: {}, explicitPath: 'broken.json' }),
      (error) => error instanceof UsageError && error.message.includes(path),
    );
  });

  it('rejects a non-object top level', async () => {
    await writeConfig('array.json', '[1, 2]');
    await assert.rejects(
      loadConfig({ cwd: dir, env: {}, explicitPath: 'array.json' }),
      /must contain a JSON object/,
    );
  });

  it('rejects an empty outputDir', async () => {
    await writeConfig('empty-output.json', '{ "outputDir": "  " }');
    await assert.rejects(
      loadConfig({ cwd: dir, env: {}, explicitPath: 'empty-output.json' }),
      /"outputDir" .* must be a non-empty string/,
    );
  });

  it('rejects module sections that are not objects', async () => {
    await writeConfig('bad-section.json', '{ "perf": "fast" }');
    await assert.rejects(
      loadConfig({ cwd: dir, env: {}, explicitPath: 'bad-section.json' }),
      /"perf" .* must be an object/,
    );
  });

  it('resolves ${ENV} references in nested strings and arrays', async () => {
    await writeConfig(
      'env.json',
      JSON.stringify({
        perf: { headers: { Authorization: 'Bearer ${API_TOKEN}' }, routes: ['/${SECTION}'] },
      }),
    );
    const config = await loadConfig({
      cwd: dir,
      env: { API_TOKEN: 'secret-value', SECTION: 'dashboard' },
      explicitPath: 'env.json',
    });
    assert.deepEqual(config.values, {
      perf: { headers: { Authorization: 'Bearer secret-value' }, routes: ['/dashboard'] },
    });
  });

  it('fails on a missing env variable and names it without leaking other values', async () => {
    await writeConfig('missing-env.json', '{ "perf": { "token": "${NOT_SET}" } }');
    await assert.rejects(
      loadConfig({ cwd: dir, env: { OTHER: 'secret-value' }, explicitPath: 'missing-env.json' }),
      (error) => {
        assert.ok(error instanceof UsageError);
        assert.match(error.message, /\$\{NOT_SET\}, which is not set/);
        assert.doesNotMatch(error.message, /secret-value/);
        return true;
      },
    );
  });
});
