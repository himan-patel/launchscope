import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import zlib from 'node:zlib';

/**
 * One timed HTTP/1.1 request with `node:http`, for direct API measurement. Unlike `fetch`, it
 * exposes the socket, so DNS, TCP connect, and TLS are timed separately and a request knows
 * whether it reused a kept-alive connection. Pass the same keep-alive `agent` to two calls to
 * measure a new connection and then a reused one.
 *
 * Redirects are followed (at most 5) only within `allowedOrigin`, so headers and cookies never
 * reach another host; a cross-origin redirect is returned as the 3xx response itself.
 * Certificates are validated as usual.
 */

const MAX_REDIRECTS = 5;
const ACCEPT_ENCODING = 'gzip, deflate, br';

/**
 * @typedef {object} RequestPhases
 * @property {number} dnsMs
 * @property {number} connectMs TCP connect.
 * @property {number} tlsMs
 * @property {number} sendMs Writing the request.
 * @property {number} waitMs Server wait: request sent until response headers.
 * @property {number} downloadMs
 */

/**
 * @typedef {object} TimedResponse
 * @property {string} url Final URL.
 * @property {number} status
 * @property {Record<string, string>} headers Lowercased names; repeated headers joined with ", ".
 * @property {Buffer} body Decoded body.
 * @property {number} transferBytes Body bytes on the wire (before decoding).
 * @property {boolean} reused The final request was sent on a reused connection.
 * @property {number} durationMs From the first request's start to the last byte, redirects included.
 * @property {number} responseStartMs First byte of the final response, from the start.
 * @property {RequestPhases} phases Of the final request.
 * @property {Array<{ url: string, status: number, startMs: number, endMs: number }>} redirects
 */

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.method]
 * @param {Record<string, string>} options.headers
 * @param {string | null} [options.body]
 * @param {number} options.timeoutMs For the whole exchange, redirects included.
 * @param {http.Agent} options.agent An `http.Agent` or `https.Agent` matching the URL's protocol.
 * @param {string} options.allowedOrigin Redirects outside this origin are not followed.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<TimedResponse>}
 */
export async function timedRequest({
  url,
  method = 'GET',
  headers,
  body = null,
  timeoutMs,
  agent,
  allowedOrigin,
  signal,
}) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  /** @type {TimedResponse['redirects']} */
  const redirects = [];
  let current = { url, method, body };

  for (let hop = 0; ; hop += 1) {
    const hopStart = performance.now();
    const response = await requestOnce({
      ...current,
      headers,
      timeoutMs: Math.max(1, deadline - hopStart),
      agent,
      signal,
    });
    const location = response.headers.location;
    const next = location ? new URL(location, current.url) : null;
    if (
      !next ||
      response.status < 300 ||
      response.status > 399 ||
      response.status === 304 ||
      next.origin !== allowedOrigin ||
      hop >= MAX_REDIRECTS
    ) {
      return {
        url: current.url,
        status: response.status,
        headers: response.headers,
        body: response.body,
        transferBytes: response.transferBytes,
        reused: response.reused,
        durationMs: round(response.endedAt - started),
        responseStartMs: round(response.responseAt - started),
        phases: response.phases,
        redirects,
      };
    }
    redirects.push({
      url: current.url,
      status: response.status,
      startMs: round(hopStart - started),
      endMs: round(response.endedAt - started),
    });
    // Like fetch: 303, and 301/302 after a POST, continue as a GET without the body.
    const asGet =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && current.method === 'POST');
    current = {
      url: next.href,
      method: asGet ? 'GET' : current.method,
      body: asGet ? null : current.body,
    };
  }
}

/**
 * @param {{ url: string, method: string, body: string | null, headers: Record<string, string>, timeoutMs: number, agent: http.Agent, signal?: AbortSignal }} options
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer, transferBytes: number, reused: boolean, phases: RequestPhases, responseAt: number, endedAt: number }>}
 */
function requestOnce({ url, method, body, headers, timeoutMs, agent, signal }) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const payload = body === null ? null : Buffer.from(body);
  /** @type {Record<string, string>} */
  const requestHeaders = { 'accept-encoding': ACCEPT_ENCODING, ...headers };
  if (payload) requestHeaders['content-length'] = String(payload.length);

  return new Promise((resolve, reject) => {
    const start = performance.now();
    /** @type {{ lookup?: number, connect?: number, secure?: number, sent?: number, response?: number }} */
    const at = {};
    let reused = false;
    let settled = false;
    /** @param {Error} error */
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      request.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      const error = new Error(`Timed out after ${Math.round(timeoutMs)} ms`);
      error.name = 'TimeoutError';
      fail(error);
    }, timeoutMs);
    const onAbort = () => fail(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });

    const request = transport.request(target, { method, headers: requestHeaders, agent });
    request.on('socket', (socket) => {
      reused = request.reusedSocket;
      if (reused) return;
      socket.once('lookup', () => (at.lookup = performance.now()));
      socket.once('connect', () => (at.connect = performance.now()));
      socket.once('secureConnect', () => (at.secure = performance.now()));
    });
    request.on('finish', () => (at.sent = performance.now()));
    request.on('error', fail);
    request.on('response', (response) => {
      at.response = performance.now();
      /** @type {Buffer[]} */
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const endedAt = performance.now();
        const raw = Buffer.concat(chunks);
        /** @type {Record<string, string>} */
        const flat = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(', ') : value;
        }
        const responseAt = /** @type {number} */ (at.response);
        const sent = at.sent ?? responseAt;
        const connected = at.secure ?? at.connect ?? at.lookup ?? start;
        resolve({
          status: response.statusCode ?? 0,
          headers: flat,
          body: decode(raw, flat['content-encoding']),
          transferBytes: raw.length,
          reused,
          responseAt,
          endedAt,
          phases: {
            dnsMs: round(at.lookup === undefined ? 0 : at.lookup - start),
            connectMs: round(at.connect === undefined ? 0 : at.connect - (at.lookup ?? start)),
            tlsMs: round(
              at.secure === undefined || at.connect === undefined ? 0 : at.secure - at.connect,
            ),
            sendMs: round(Math.max(0, sent - connected)),
            waitMs: round(Math.max(0, responseAt - sent)),
            downloadMs: round(endedAt - responseAt),
          },
        });
      });
    });
    request.end(payload ?? undefined);
  });
}

/**
 * @param {Buffer} raw
 * @param {string | undefined} encoding
 * @returns {Buffer} The decoded body, or the raw bytes when the encoding is unknown or broken.
 */
function decode(raw, encoding) {
  if (raw.length === 0 || !encoding) return raw;
  try {
    switch (encoding.trim().toLowerCase()) {
      case 'gzip':
      case 'x-gzip':
        return zlib.gunzipSync(raw);
      case 'deflate':
        try {
          return zlib.inflateSync(raw);
        } catch {
          return zlib.inflateRawSync(raw);
        }
      case 'br':
        return zlib.brotliDecompressSync(raw);
      default:
        return raw;
    }
  } catch {
    return raw;
  }
}

/**
 * Keep-alive agent with one socket, so a second request on it reuses the first one's connection.
 *
 * @param {string} url
 * @returns {http.Agent}
 */
export function createConnectionAgent(url) {
  const options = { keepAlive: true, maxSockets: 1 };
  return new URL(url).protocol === 'https:' ? new https.Agent(options) : new http.Agent(options);
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
