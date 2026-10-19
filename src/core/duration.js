import { UsageError } from './errors.js';

const UNIT_MS = /** @type {const} */ ({ ms: 1, s: 1000, m: 60_000 });

/**
 * Parses a human duration into milliseconds: `250ms`, `10s`, `1.5m`, or a bare number of ms.
 *
 * @param {string | number} input
 * @param {string} label Name used in error messages, e.g. `--timeout`.
 * @returns {number}
 */
export function parseDuration(input, label) {
  if (typeof input === 'number') {
    if (Number.isFinite(input) && input > 0) return input;
    throw new UsageError(`${label} must be a positive duration.`);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/i.exec(input);
  if (!match) {
    throw new UsageError(`${label} must be a duration like 500ms, 10s, or 2m (got "${input}").`);
  }
  const unit = /** @type {keyof typeof UNIT_MS} */ ((match[2] ?? 'ms').toLowerCase());
  const value = Number(match[1]) * UNIT_MS[unit];
  if (value <= 0) throw new UsageError(`${label} must be greater than zero.`);
  return Math.round(value);
}

/**
 * Formats milliseconds for people: `850 ms`, `1.24 s`, `2m 05s`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Formats a byte count with binary units: `512 B`, `14.2 KB`, `3.10 MB`.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
