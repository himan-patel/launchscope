import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { UsageError } from '../../../core/errors.js';
import { classifyHost } from '../../../core/target.js';

/**
 * Stress tests generate real load, so by default they only run against hosts that resolve
 * exclusively to loopback or private-network addresses (your laptop, a dev container, a staging
 * box on the VPN). The resolved addresses are checked, not just the hostname, so a public name
 * cannot be used to aim load at someone else's server by accident.
 *
 * @typedef {(hostname: string, options: { all: true }) => Promise<Array<{ address: string, family: number }>>} LookupFn
 */

/**
 * @param {object} options
 * @param {URL} options.targetUrl
 * @param {boolean} options.allowRemote
 * @param {LookupFn} [options.lookup]
 * @returns {Promise<{ addresses: string[], remote: boolean }>}
 */
export async function assertStressAllowed({ targetUrl, allowRemote, lookup = dnsLookup }) {
  const hostname = targetUrl.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses;
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = (await lookup(hostname, { all: true })).map((entry) => entry.address);
    } catch (error) {
      throw new UsageError(`Could not resolve ${hostname} to check it is safe to stress test.`, {
        cause: error,
      });
    }
  }

  const publicAddresses = addresses.filter((address) => classifyHost(address) === 'public');
  if (publicAddresses.length > 0 && !allowRemote) {
    throw new UsageError(
      `Refusing to stress test ${targetUrl.host}: it resolves to a public address (${publicAddresses.join(', ')}).`,
      {
        hint:
          'Stress tests only target local or private hosts by default. If you own this host and ' +
          'are allowed to load test it, re-run with --allow-remote.',
      },
    );
  }
  return { addresses, remote: publicAddresses.length > 0 };
}
