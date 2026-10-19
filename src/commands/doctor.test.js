import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkNode } from './doctor.js';

describe('checkNode', () => {
  it('compares versions numerically, not as strings', () => {
    assert.equal(checkNode('22.23.3', '>=22.19.0', 'Node.js', true).status, 'ok');
    assert.equal(checkNode('22.19.0', '>=22.19.0', 'Node.js', true).status, 'ok');
    assert.equal(checkNode('24.1.0', '>=22.19.0', 'Node.js', true).status, 'ok');
    assert.equal(checkNode('22.9.0', '>=22.19.0', 'Node.js', true).status, 'fail');
    assert.equal(checkNode('22.18.9', '>=22.19.0', 'Lighthouse', false).status, 'warn');
    assert.equal(checkNode('22.23.3', '>=22.19', 'Lighthouse', false).status, 'ok');
    assert.equal(checkNode('22.18.0', '>=22.19', 'Lighthouse', false).status, 'warn');
  });

  it('explains how to switch versions on every OS', () => {
    assert.match(
      checkNode('20.0.0', '>=22.19.0', 'Node.js', true).fix ?? '',
      /nvm-windows.*fnm use/,
    );
  });
});
