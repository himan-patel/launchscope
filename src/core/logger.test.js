import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger, shouldUseColor } from './logger.js';

/** Collects everything written to it, standing in for process.stderr. */
function createMemoryStream() {
  const chunks = /** @type {string[]} */ ([]);
  return {
    write: (/** @type {string} */ chunk) => chunks.push(chunk),
    text: () => chunks.join(''),
  };
}

describe('shouldUseColor', () => {
  it('uses color on a TTY by default', () => {
    assert.equal(shouldUseColor({ isTTY: true }, {}), true);
  });

  it('does not use color when output is piped', () => {
    assert.equal(shouldUseColor({ isTTY: false }, {}), false);
  });

  it('honors NO_COLOR even on a TTY', () => {
    assert.equal(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' }), false);
  });

  it('ignores an empty NO_COLOR, per the convention', () => {
    assert.equal(shouldUseColor({ isTTY: true }, { NO_COLOR: '' }), true);
  });

  it('honors FORCE_COLOR when piped, unless it is 0', () => {
    assert.equal(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '1' }), true);
    assert.equal(shouldUseColor({ isTTY: true }, { FORCE_COLOR: '0' }), false);
  });

  it('disables color for dumb terminals', () => {
    assert.equal(shouldUseColor({ isTTY: true }, { TERM: 'dumb' }), false);
  });
});

describe('createLogger', () => {
  it('prints info, warnings, and errors at the normal level but hides debug', () => {
    const stream = createMemoryStream();
    const logger = createLogger({ stream });
    logger.info('hello');
    logger.warn('careful');
    logger.error('broken');
    logger.debug('internal');
    assert.equal(stream.text(), 'hello\n! careful\n✖ broken\n');
  });

  it('prints only errors when quiet', () => {
    const stream = createMemoryStream();
    const logger = createLogger({ stream, level: 'quiet' });
    logger.info('hello');
    logger.success('done');
    logger.banner();
    logger.error('broken');
    assert.equal(stream.text(), '✖ broken\n');
  });

  it('prints debug output when verbose', () => {
    const stream = createMemoryStream();
    createLogger({ stream, level: 'verbose' }).debug('internal');
    assert.equal(stream.text(), '· internal\n');
  });

  it('emits ANSI codes only when color is enabled', () => {
    const plain = createMemoryStream();
    createLogger({ stream: plain }).success('ok');
    assert.equal(plain.text(), '✔ ok\n');

    const colored = createMemoryStream();
    createLogger({ stream: colored, color: true }).success('ok');
    assert.equal(colored.text(), '\u001b[32m✔\u001b[39m ok\n');
  });
});
