/**
 * Joins the in-page request tracker's observations with the network recorder's records.
 *
 * Each tracked call (in the order the page made them) is matched to the earliest unmatched
 * fetch/XHR record with the same method and URL (the URL the page requested, before redirects).
 * When a call was made while another tracked request's response handler was running, the
 * matched record gets `causedBy` set to that request's record id. Unmatched calls (for example
 * requests answered from a cache that never reached the network) simply have no link.
 */

const API_TYPES = new Set(['Fetch', 'XHR']);

/**
 * @typedef {object} TrackedCall
 * @property {number} id
 * @property {string} url
 * @property {string} method
 * @property {number | null} causeId
 */

/**
 * @param {import('./network-recorder.js').RequestRecord[]} requests Mutated: `causedBy` is set.
 * @param {TrackedCall[]} calls
 * @returns {{ matched: number, linked: number }}
 */
export function applyObservedCauses(requests, calls) {
  const candidates = requests
    .filter((request) => API_TYPES.has(request.resourceType))
    .sort((a, b) => a.startMs - b.startMs);
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {Map<number, import('./network-recorder.js').RequestRecord>} */
  const byCall = new Map();

  for (const call of calls) {
    const match = candidates.find(
      (request) =>
        !used.has(request.id) &&
        request.method === call.method &&
        requestedUrl(request) === call.url,
    );
    if (!match) continue;
    used.add(match.id);
    byCall.set(call.id, match);
  }

  let linked = 0;
  for (const call of calls) {
    if (call.causeId === null) continue;
    const request = byCall.get(call.id);
    const cause = byCall.get(call.causeId);
    if (request && cause && request !== cause) {
      request.causedBy = cause.id;
      linked += 1;
    }
  }
  return { matched: byCall.size, linked };
}

/**
 * @param {import('./network-recorder.js').RequestRecord} request
 * @returns {string}
 */
function requestedUrl(request) {
  const url = request.redirects[0]?.url ?? request.url;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}
