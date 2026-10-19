/**
 * Turns Ctrl+C (SIGINT) and SIGTERM (CI cancellation, `kill`) into a graceful stop: the first
 * signal aborts `signal` so work in progress can wind down and partial results can be written;
 * a second signal exits immediately.
 *
 * @typedef {object} InterruptController
 * @property {AbortSignal} signal Aborted on the first SIGINT or SIGTERM.
 * @property {() => void} dispose Removes the signal handlers.
 */

export const INTERRUPTED_EXIT_CODE = 130;

/**
 * @param {object} options
 * @param {() => void} options.onFirst Called once, on the first signal.
 * @param {NodeJS.EventEmitter} [options.processRef] Injectable for tests.
 * @param {(code: number) => void} [options.exit] Injectable for tests.
 * @returns {InterruptController}
 */
export function createInterruptController({
  onFirst,
  processRef = process,
  exit = (code) => process.exit(code),
}) {
  const controller = new AbortController();
  const handler = () => {
    if (controller.signal.aborted) {
      exit(INTERRUPTED_EXIT_CODE);
      return;
    }
    controller.abort();
    onFirst();
  };
  processRef.on('SIGINT', handler);
  processRef.on('SIGTERM', handler);
  return {
    signal: controller.signal,
    dispose: () => {
      processRef.removeListener('SIGINT', handler);
      processRef.removeListener('SIGTERM', handler);
    },
  };
}
