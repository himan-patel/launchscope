import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const DEFAULT_OUTPUT_DIR = 'launchscope-reports';

const MAX_COLLISION_SUFFIX = 100;

/**
 * Formats a run timestamp in UTC so directory names sort chronologically and are unambiguous
 * across time zones, e.g. `2026-10-19_03-29-04Z`.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatRunTimestamp(date) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '_')
    .replaceAll(':', '-');
}

/**
 * Turns a target URL into a filesystem-safe directory prefix, e.g. `localhost-4200`.
 *
 * @param {URL} url
 * @returns {string}
 */
export function slugifyHost(url) {
  const host = url.port === '' ? url.hostname : `${url.hostname}-${url.port}`;
  return (
    host
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'target'
  );
}

/**
 * Creates a fresh directory for one run: `<outputDir>/<host>_<timestamp>[-n]`.
 * Never reuses an existing directory, so earlier reports are not overwritten.
 *
 * @param {object} options
 * @param {string} options.outputDir Base directory, relative to `cwd` or absolute.
 * @param {string} options.cwd
 * @param {URL} options.targetUrl
 * @param {Date} [options.now]
 * @returns {Promise<string>} Absolute path of the created directory.
 */
export async function createRunDirectory({ outputDir, cwd, targetUrl, now = new Date() }) {
  const base = resolve(cwd, outputDir);
  await mkdir(base, { recursive: true });

  const stem = `${slugifyHost(targetUrl)}_${formatRunTimestamp(now)}`;
  for (let attempt = 1; attempt <= MAX_COLLISION_SUFFIX; attempt += 1) {
    const candidate = join(base, attempt === 1 ? stem : `${stem}-${attempt}`);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  throw new Error(`Could not create a unique run directory under ${base}.`);
}

/**
 * Writes JSON atomically (temp file + rename) so a crash never leaves a half-written report.
 *
 * @param {string} path
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJsonFile(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}
