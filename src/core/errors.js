/**
 * Process exit codes. Kept stable so CI pipelines can rely on them.
 */
export const ExitCode = Object.freeze({
  /** Everything ran and no check crossed a failure threshold. */
  OK: 0,
  /** Checks ran, but at least one result crossed a configured failure threshold. */
  CHECK_FAILED: 1,
  /** Invalid command, option, argument, target, or configuration. */
  USAGE: 2,
  /** Unexpected internal failure (EX_SOFTWARE). */
  INTERNAL: 70,
});

/**
 * An expected, user-facing error. Its message is safe to print without a stack trace.
 */
export class LaunchScopeError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number, hint?: string, cause?: unknown }} [options]
   */
  constructor(message, { exitCode = ExitCode.INTERNAL, hint, cause } = {}) {
    super(message, { cause });
    this.name = 'LaunchScopeError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

/** The user asked for something invalid: bad input, missing file, malformed config. */
export class UsageError extends LaunchScopeError {
  /**
   * @param {string} message
   * @param {{ hint?: string, cause?: unknown }} [options]
   */
  constructor(message, { hint, cause } = {}) {
    super(message, { exitCode: ExitCode.USAGE, hint, cause });
    this.name = 'UsageError';
  }
}
