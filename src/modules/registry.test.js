import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHECK_MODULES } from './registry.js';

const RESERVED_COMMANDS = new Set(['modules', 'login', 'doctor', 'help']);
const RESERVED_CONFIG_KEYS = new Set(['$schema', 'outputDir']);

describe('CHECK_MODULES', () => {
  it('has unique ids', () => {
    const ids = CHECK_MODULES.map((checkModule) => checkModule.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('uses ids that are valid subcommand names and do not clash with built-ins', () => {
    for (const { id } of CHECK_MODULES) {
      assert.match(id, /^[a-z][a-z0-9-]*$/);
      assert.ok(!RESERVED_COMMANDS.has(id), `${id} clashes with a built-in command`);
      assert.ok(!RESERVED_CONFIG_KEYS.has(id), `${id} clashes with a reserved config key`);
    }
  });

  it('only registers commands for modules that are not planned', () => {
    for (const checkModule of CHECK_MODULES) {
      if (checkModule.status === 'planned') {
        assert.equal(checkModule.register, undefined, `${checkModule.id} is planned`);
      }
    }
  });

  it('gives every module a title and summary', () => {
    for (const { id, title, summary } of CHECK_MODULES) {
      assert.ok(title.trim(), `${id} needs a title`);
      assert.ok(summary.trim(), `${id} needs a summary`);
    }
  });
});
