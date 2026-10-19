import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { createInterruptController, INTERRUPTED_EXIT_CODE } from './interrupt.js';

describe('createInterruptController', () => {
  it('aborts on the first signal and exits on the second', () => {
    const fakeProcess = new EventEmitter();
    /** @type {number[]} */
    const exits = [];
    let notified = 0;
    const interrupt = createInterruptController({
      onFirst: () => {
        notified += 1;
      },
      processRef: fakeProcess,
      exit: (code) => exits.push(code),
    });

    assert.equal(interrupt.signal.aborted, false);
    fakeProcess.emit('SIGTERM');
    assert.equal(interrupt.signal.aborted, true);
    assert.equal(notified, 1);
    assert.deepEqual(exits, []);

    fakeProcess.emit('SIGINT');
    assert.deepEqual(exits, [INTERRUPTED_EXIT_CODE]);
    assert.equal(notified, 1);
  });

  it('removes its handlers on dispose', () => {
    const fakeProcess = new EventEmitter();
    const interrupt = createInterruptController({ onFirst: () => {}, processRef: fakeProcess });
    assert.equal(fakeProcess.listenerCount('SIGINT'), 1);
    interrupt.dispose();
    assert.equal(fakeProcess.listenerCount('SIGINT'), 0);
    assert.equal(fakeProcess.listenerCount('SIGTERM'), 0);
  });
});
