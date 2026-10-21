import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Ajv } from 'ajv';
import { DEFAULT_BUDGETS } from '../src/modules/perf/analyze/budgets.js';
import { CONFIG_KEYS, STRESS_CONFIG_KEYS } from '../src/modules/perf/settings.js';

const schema = JSON.parse(
  await readFile(new URL('../schema/launchscope.config.schema.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

describe('launchscope.config.schema.json', () => {
  it('is in sync with every config key the code accepts', () => {
    assert.deepEqual(
      Object.keys(schema.definitions.perf.properties).sort(),
      [...CONFIG_KEYS].sort(),
    );
    assert.deepEqual(
      Object.keys(schema.definitions.stress.properties).sort(),
      [...STRESS_CONFIG_KEYS].sort(),
    );
    assert.deepEqual(
      Object.keys(schema.definitions.budgets.properties).sort(),
      Object.keys(DEFAULT_BUDGETS).sort(),
    );
  });

  it('accepts the documented example config', async () => {
    const example = JSON.parse(
      await readFile(new URL('../examples/launchscope.config.json', import.meta.url), 'utf8'),
    );
    assert.equal(validate(example), true, JSON.stringify(validate.errors, null, 2));
  });

  it('rejects typos, wrong types, and out-of-range values', () => {
    for (const config of [
      { perf: { rnus: 3 } },
      { perf: { runs: 0 } },
      { perf: { device: 'tablet' } },
      { perf: { stress: { mode: 'burst' } } },
      { perf: { budgets: { lpc: 1 } } },
      { perf: { endpoints: [{ method: 'DELETE', path: '/api/items/1' }] } },
      { perf: { endpoints: [{ url: '/api/me' }] } },
      { perf: { traceContext: { urlTemplate: 'https://t.test/no-placeholder' } } },
      { outputDir: '' },
    ]) {
      assert.equal(validate(config), false, JSON.stringify(config));
    }
  });
});
