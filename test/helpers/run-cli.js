import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL('../../bin/launchscope.js', import.meta.url));

/**
 * Runs the real CLI entry point as a child process with a minimal, colorless environment.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string>, timeout?: number }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runCli(args, { cwd, env = {}, timeout = 120_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      cwd,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NO_COLOR: '1',
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = /** @type {{ code: number, stdout: string, stderr: string }} */ (error);
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}
