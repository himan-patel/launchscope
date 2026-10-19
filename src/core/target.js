import { isIP } from 'node:net';
import { UsageError } from './errors.js';

/** @typedef {'loopback' | 'private' | 'public'} HostScope */

/**
 * @typedef {object} Target
 * @property {URL} url Normalized http(s) URL.
 * @property {HostScope} scope Where the host lives, judged from the literal hostname.
 */

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Parses a user-supplied target into a normalized URL.
 *
 * Bare hosts are accepted: local hosts default to http, everything else to https.
 * Credentials embedded in the URL are rejected so they never end up in shell history,
 * logs, or reports.
 *
 * @param {string} input
 * @returns {Target}
 */
export function parseTarget(input) {
  const raw = input.trim();
  if (raw === '') {
    throw new UsageError('Target is empty.', { hint: 'Pass a URL, e.g. http://localhost:3000' });
  }

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
  const url = tryParseUrl(hasScheme ? raw : `http://${raw}`);
  if (!url) {
    throw new UsageError(`"${raw}" is not a valid URL.`, {
      hint: 'Pass a URL, e.g. https://example.com or http://localhost:3000',
    });
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new UsageError(
      `Unsupported protocol "${url.protocol}". Only http and https are supported.`,
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new UsageError('Credentials in the target URL are not allowed.', {
      hint: 'Remove "user:password@" from the URL. Authenticated checks will use a session file instead.',
    });
  }

  const scope = classifyHost(url.hostname);
  if (!hasScheme && scope === 'public') {
    url.protocol = 'https:';
  }

  return { url, scope };
}

/**
 * Classifies a hostname as loopback, private network, or public, from the literal value only.
 * A public name can still resolve to a private address; callers that need a hard guarantee
 * (for example stress testing) must also check the resolved address.
 *
 * @param {string} hostname URL hostname; IPv6 may be wrapped in brackets.
 * @returns {HostScope}
 */
export function classifyHost(hostname) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (host.endsWith('.local') || host.endsWith('.internal')) return 'private';

  const version = isIP(host);
  if (version === 4) return classifyIPv4(host);
  if (version === 6) return classifyIPv6(host);
  return 'public';
}

/**
 * @param {string} address
 * @returns {HostScope}
 */
function classifyIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  if (a === 127 || a === 0) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  return 'public';
}

/**
 * @param {string} address
 * @returns {HostScope}
 */
function classifyIPv6(address) {
  if (address === '::1' || address === '::') return 'loopback';
  const mappedIPv4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIPv4) return classifyIPv4(mappedIPv4[1]);
  const firstHextet = parseInt(address.split(':')[0] || '0', 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((firstHextet & 0xffc0) === 0xfe80) return 'private'; // fe80::/10 link local
  return 'public';
}

/**
 * @param {string} value
 * @returns {URL | null}
 */
function tryParseUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === '' ? null : url;
  } catch {
    return null;
  }
}
