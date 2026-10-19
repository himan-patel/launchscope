/**
 * Records every network request of one page load from Chrome DevTools Protocol events.
 *
 * CDP is used instead of Playwright's request events because it exposes what the analysis
 * needs: per-phase timing (DNS, connect, TLS, wait, download), compressed vs. decoded sizes,
 * redirect hops, and the initiator (which document or script triggered each request).
 */

import { createHash } from 'node:crypto';
import { detectGraphqlOperation, looksLikeGraphql } from './graphql.js';

/** Response headers kept on records. Everything else (cookies included) is dropped. */
const KEPT_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-encoding',
  'content-length',
  'cache-control',
  'expires',
  'etag',
  'last-modified',
  'vary',
  'age',
  'server-timing',
  'x-cache',
  'cf-cache-status',
  'x-vercel-cache',
  'x-response-time',
]);

const MAX_JSON_INSPECT_BYTES = 5 * 1024 * 1024;

/**
 * @typedef {object} Initiator
 * @property {string} type CDP initiator type: parser, script, preload, preflight, other, ...
 * @property {string | null} url Document or script URL that caused the request.
 * @property {string[]} stackUrls Script URLs on the initiating call stack, innermost first.
 * @property {string | null} requestId For preflights and similar, the related request.
 */

/**
 * @typedef {object} TimingPhases
 * @property {number} queueMs Waiting before the request could be sent.
 * @property {number} dnsMs
 * @property {number} connectMs TCP connect, excluding TLS.
 * @property {number} tlsMs
 * @property {number} sendMs
 * @property {number} waitMs Time to first byte after sending (server think time + latency).
 * @property {number} downloadMs
 */

/**
 * @typedef {object} RedirectHop
 * @property {string} url
 * @property {number} status
 * @property {number} startMs
 * @property {number} endMs
 */

/**
 * @typedef {object} JsonShape
 * @property {'object' | 'array' | 'scalar'} rootType
 * @property {number} largestArrayLength Longest array anywhere in the document.
 * @property {number} keyCount Total object keys across the document.
 * @property {number} depth Maximum nesting depth.
 */

/**
 * @typedef {object} RequestRecord
 * @property {string} id
 * @property {string} url Final URL after redirects.
 * @property {string} method
 * @property {string} resourceType CDP resource type: Document, Script, Fetch, XHR, Image, ...
 * @property {boolean} isNavigation True for the page's main document request.
 * @property {Initiator} initiator
 * @property {number} startMs Relative to the navigation request.
 * @property {number} endMs
 * @property {number} durationMs Total, including redirect hops.
 * @property {number | null} responseStartMs When response headers arrived.
 * @property {TimingPhases | null} phases Phases of the final hop; null when served from cache.
 * @property {number | null} status
 * @property {string | null} mimeType
 * @property {string | null} protocol
 * @property {boolean} fromCache
 * @property {boolean} fromServiceWorker
 * @property {boolean} connectionReused
 * @property {number} transferBytes Bytes on the wire (compressed, including headers).
 * @property {number} bodyBytes Decoded body size.
 * @property {Record<string, string>} headers Allow-listed response headers only.
 * @property {RedirectHop[]} redirects
 * @property {{ errorText: string, canceled: boolean } | null} failure
 * @property {boolean} pending True when still in flight when capture ended.
 * @property {JsonShape | null} jsonShape
 * @property {import('./graphql.js').GraphqlOperation | null} graphql Operation, for GraphQL calls.
 * @property {string | null} causedBy Record id of the API request whose response handler issued
 *   this request, as observed in the page (fetch/XHR only).
 * @property {string | null} frameId
 * @property {boolean} isMainFrame False for requests made by iframes.
 * @property {boolean} streaming A long-lived stream (server-sent events), not a request/response.
 */

/**
 * @typedef {object} ReplayBody
 * @property {string} method
 * @property {string | null} contentType
 * @property {string | null} body
 */

/**
 * @typedef {object} SocketRecord
 * @property {string} id
 * @property {string} url
 * @property {string | null} initiatorUrl
 * @property {number | null} status Handshake status (101 on success).
 * @property {number | null} handshakeMs
 * @property {number} framesSent
 * @property {number} framesReceived
 * @property {number} bytesSent
 * @property {number} bytesReceived
 * @property {number} errors
 * @property {boolean} closed Closed before capture ended.
 * @property {number | null} openMs How long the socket was open (until close or capture end).
 */

/**
 * @typedef {object} CdpSession
 * @property {(method: any, params?: any) => Promise<any>} send
 * @property {(event: any, handler: (params: any) => void) => unknown} on
 */

export class NetworkRecorder {
  /** @type {Map<string, RequestRecord & { hopStartMs: number }>} */
  #records = new Map();
  /** @type {Set<string>} */
  #inflight = new Set();
  /** Long-lived responses (server-sent events) that never "finish" and must not block idle. */
  /** @type {Set<string>} */
  #streaming = new Set();
  /** @type {Map<string, SocketRecord & { openedMs: number }>} */
  #sockets = new Map();
  /** @type {string | null} */
  #mainFrameId = null;
  /** @type {Promise<void>[]} */
  #bodyInspections = [];
  /** @type {number | null} */
  #originSeconds = null;
  /** @type {number | null} */
  #originWallMs = null;
  #lastActivity = Date.now();
  #inspectJson;
  /** @type {((record: { url: string, method: string }) => boolean) | undefined} */
  #captureBody;
  /** @type {Map<string, ReplayBody>} */
  #replayBodies = new Map();
  /** @type {CdpSession} */
  #session;

  /**
   * @param {CdpSession} session
   * @param {{ inspectJson?: boolean, captureBody?: (record: { url: string, method: string }) => boolean }} [options]
   *   `captureBody` selects non-GET requests whose bodies are kept in memory for stress replay.
   */
  constructor(session, { inspectJson = false, captureBody } = {}) {
    this.#session = session;
    this.#inspectJson = inspectJson;
    this.#captureBody = captureBody;
    session.on('Network.requestWillBeSent', (event) => this.#onRequest(event));
    session.on('Network.responseReceived', (event) => this.#onResponse(event));
    session.on('Network.dataReceived', (event) => this.#onData(event));
    session.on('Network.loadingFinished', (event) => this.#onFinished(event));
    session.on('Network.loadingFailed', (event) => this.#onFailed(event));
    session.on('Network.requestServedFromCache', (event) => this.#onServedFromCache(event));
    session.on('Network.webSocketCreated', (event) => this.#onSocketCreated(event));
    session.on('Network.webSocketWillSendHandshakeRequest', (event) =>
      this.#onSocketHandshakeRequest(event),
    );
    session.on('Network.webSocketHandshakeResponseReceived', (event) =>
      this.#onSocketHandshake(event),
    );
    session.on('Network.webSocketFrameSent', (event) => this.#onSocketFrame(event, 'sent'));
    session.on('Network.webSocketFrameReceived', (event) => this.#onSocketFrame(event, 'received'));
    session.on('Network.webSocketFrameError', (event) => this.#onSocketError(event));
    session.on('Network.webSocketClosed', (event) => this.#onSocketClosed(event));
  }

  /**
   * WebSocket connections opened during the load. Frame contents are never kept, only counts
   * and sizes.
   *
   * @param {number} captureEndMs
   * @returns {SocketRecord[]}
   */
  sockets(captureEndMs) {
    return [...this.#sockets.values()].map(({ openedMs, ...socket }) => ({
      ...socket,
      openMs: round((socket.closed ? socket.openMs : captureEndMs - openedMs) ?? 0),
    }));
  }

  /** @param {any} event */
  #onSocketHandshakeRequest(event) {
    const socket = this.#sockets.get(event.requestId);
    if (socket) socket.openedMs = this.#relative(event.timestamp);
  }

  /** @param {any} event */
  #onSocketCreated(event) {
    this.#sockets.set(event.requestId, {
      id: event.requestId,
      url: String(event.url),
      initiatorUrl: simplifyInitiator(event.initiator).url,
      status: null,
      handshakeMs: null,
      framesSent: 0,
      framesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      errors: 0,
      closed: false,
      openMs: null,
      openedMs: 0,
    });
  }

  /** @param {any} event */
  #onSocketHandshake(event) {
    const socket = this.#sockets.get(event.requestId);
    if (!socket) return;
    socket.status = event.response?.status ?? null;
    socket.handshakeMs = round(Math.max(0, this.#relative(event.timestamp) - socket.openedMs));
  }

  /**
   * @param {any} event
   * @param {'sent' | 'received'} direction
   */
  #onSocketFrame(event, direction) {
    const socket = this.#sockets.get(event.requestId);
    if (!socket) return;
    const payload = String(event.response?.payloadData ?? '');
    // Opcode 1 is text; anything else arrives base64-encoded.
    const bytes =
      event.response?.opcode === 1
        ? Buffer.byteLength(payload)
        : Math.floor((payload.length * 3) / 4);
    if (direction === 'sent') {
      socket.framesSent += 1;
      socket.bytesSent += bytes;
    } else {
      socket.framesReceived += 1;
      socket.bytesReceived += bytes;
    }
  }

  /** @param {any} event */
  #onSocketError(event) {
    const socket = this.#sockets.get(event.requestId);
    if (socket) socket.errors += 1;
  }

  /** @param {any} event */
  #onSocketClosed(event) {
    const socket = this.#sockets.get(event.requestId);
    if (!socket) return;
    socket.closed = true;
    socket.openMs = round(Math.max(0, this.#relative(event.timestamp) - socket.openedMs));
  }

  /**
   * Request bodies captured for stress replay, by request id. Held in memory only; never part of
   * the records written to disk.
   *
   * @returns {Map<string, ReplayBody>}
   */
  replayBodies() {
    return this.#replayBodies;
  }

  /** Monotonic time origin (seconds) of the first request, or null before any request. */
  get originSeconds() {
    return this.#originSeconds;
  }

  /**
   * Wall-clock time (epoch ms) of the time origin, from the first request. One constant offset
   * converts every record's relative times to wall-clock times without disturbing their order.
   */
  get originWallMs() {
    return this.#originWallMs;
  }

  /**
   * GET requests that count toward Time to Interactive's network quiet window, as Lighthouse
   * counts them: not failed, status below 400, and not streaming responses (WebSockets are not
   * request records). `endMs` is null while the request is in flight.
   *
   * @returns {Array<{ startMs: number, endMs: number | null }>}
   */
  quietWindowRequests() {
    /** @type {Array<{ startMs: number, endMs: number | null }>} */
    const requests = [];
    for (const record of this.#records.values()) {
      if (record.method !== 'GET' || record.failure || this.#streaming.has(record.id)) continue;
      if (record.status !== null && record.status >= 400) continue;
      const inFlight = this.#inflight.has(record.id);
      requests.push({ startMs: record.startMs, endMs: inFlight ? null : record.endMs });
    }
    return requests;
  }

  /**
   * Resolves once no request has been in flight for `idleMs`, or after `timeoutMs`.
   *
   * @param {{ idleMs: number, timeoutMs: number }} options
   * @returns {Promise<boolean>} True if the network went idle before the timeout.
   */
  async waitForIdle({ idleMs, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const blocking = [...this.#inflight].filter((id) => !this.#streaming.has(id)).length;
      if (blocking === 0 && Date.now() - this.#lastActivity >= idleMs) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  /**
   * Finalizes and returns all records, sorted by start time.
   *
   * @param {number} captureEndMs Used as the end time of requests still in flight.
   * @returns {Promise<RequestRecord[]>}
   */
  async finish(captureEndMs) {
    await Promise.allSettled(this.#bodyInspections);
    return [...this.#records.values()]
      .map(({ hopStartMs: _hopStartMs, ...entry }) => {
        const record = {
          ...entry,
          isMainFrame: this.#mainFrameId === null || entry.frameId === this.#mainFrameId,
        };
        if (!this.#inflight.has(record.id)) return record;
        return {
          ...record,
          pending: true,
          endMs: captureEndMs,
          durationMs: captureEndMs - record.startMs,
        };
      })
      .sort((a, b) => a.startMs - b.startMs);
  }

  /** @param {number} seconds */
  #relative(seconds) {
    this.#originSeconds ??= seconds;
    return round((seconds - this.#originSeconds) * 1000);
  }

  /** @param {any} event */
  #onRequest(event) {
    const url = String(event.request.url);
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    this.#lastActivity = Date.now();
    if (this.#originSeconds === null && typeof event.wallTime === 'number') {
      this.#originWallMs = event.wallTime * 1000;
    }
    const at = this.#relative(event.timestamp);
    const existing = this.#records.get(event.requestId);

    if (existing && event.redirectResponse) {
      existing.redirects.push({
        url: existing.url,
        status: event.redirectResponse.status,
        startMs: existing.hopStartMs,
        endMs: at,
      });
      existing.url = url;
      existing.hopStartMs = at;
      return;
    }

    const isNavigation = event.type === 'Document' && event.requestId === event.loaderId;
    if (isNavigation && this.#mainFrameId === null) this.#mainFrameId = event.frameId ?? null;
    this.#inflight.add(event.requestId);
    if (event.type === 'EventSource') this.#streaming.add(event.requestId);
    this.#records.set(event.requestId, {
      id: event.requestId,
      url,
      method: event.request.method,
      resourceType: event.type ?? 'Other',
      isNavigation,
      frameId: event.frameId ?? null,
      isMainFrame: true,
      streaming: event.type === 'EventSource',
      initiator: simplifyInitiator(event.initiator),
      startMs: at,
      hopStartMs: at,
      endMs: at,
      durationMs: 0,
      responseStartMs: null,
      phases: null,
      status: null,
      mimeType: null,
      protocol: null,
      fromCache: false,
      fromServiceWorker: false,
      connectionReused: false,
      transferBytes: 0,
      bodyBytes: 0,
      headers: {},
      redirects: [],
      failure: null,
      pending: false,
      jsonShape: null,
      graphql: null,
      causedBy: null,
    });
    this.#identifyGraphql(event);
    this.#keepReplayBody(event);
  }

  /** @param {any} event */
  #keepReplayBody(event) {
    const record = this.#records.get(event.requestId);
    if (!record || record.method === 'GET' || !this.#captureBody?.(record)) return;
    const headers = /** @type {Record<string, string>} */ (event.request.headers ?? {});
    const contentType =
      Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? null;
    if (!event.request.hasPostData && !event.request.postData) {
      this.#replayBodies.set(record.id, { method: record.method, contentType, body: null });
      return;
    }
    this.#bodyInspections.push(
      (async () => {
        try {
          const body =
            event.request.postData ??
            (await this.#session.send('Network.getRequestPostData', { requestId: record.id }))
              .postData;
          this.#replayBodies.set(record.id, {
            method: record.method,
            contentType,
            body: body ?? null,
          });
        } catch {
          // Body no longer available; the request is not replayed.
        }
      })(),
    );
  }

  /**
   * Records the GraphQL operation behind a request. POST bodies are fetched on demand (only for
   * GraphQL-looking URLs), read for the operation name and type, and discarded.
   *
   * @param {any} event
   */
  #identifyGraphql(event) {
    const record = this.#records.get(event.requestId);
    if (!record || !looksLikeGraphql(record.url)) return;
    if (record.method === 'GET') {
      record.graphql = detectGraphqlOperation({ url: record.url, method: 'GET' });
      return;
    }
    if (!event.request.hasPostData && !event.request.postData) return;
    this.#bodyInspections.push(
      (async () => {
        try {
          const postData =
            event.request.postData ??
            (await this.#session.send('Network.getRequestPostData', { requestId: record.id }))
              .postData;
          const operation = detectGraphqlOperation({
            url: record.url,
            method: record.method,
            postData,
          });
          record.graphql = operation
            ? {
                ...operation,
                bodyHash: createHash('sha256')
                  .update(postData ?? '')
                  .digest('hex')
                  .slice(0, 16),
              }
            : null;
        } catch {
          // The body is no longer available; the request is grouped by URL instead.
        }
      })(),
    );
  }

  /** @param {any} event */
  #onResponse(event) {
    const record = this.#records.get(event.requestId);
    if (!record) return;
    this.#lastActivity = Date.now();
    const response = event.response;
    record.status = response.status;
    record.mimeType = response.mimeType ?? null;
    record.protocol = response.protocol ?? null;
    record.fromCache = Boolean(
      record.fromCache || response.fromDiskCache || response.fromPrefetchCache,
    );
    record.fromServiceWorker = Boolean(response.fromServiceWorker);
    record.connectionReused = Boolean(response.connectionReused);
    record.headers = pickHeaders(response.headers ?? {});
    if (/text\/event-stream/i.test(record.mimeType ?? '')) {
      record.streaming = true;
      this.#streaming.add(record.id);
    }

    const timing = response.timing;
    if (timing && !record.fromCache) {
      const requestStartMs = this.#relative(timing.requestTime);
      const span = (/** @type {number} */ start, /** @type {number} */ end) =>
        start >= 0 && end >= start ? end - start : 0;
      const tlsMs = span(timing.sslStart, timing.sslEnd);
      record.responseStartMs = round(requestStartMs + timing.receiveHeadersEnd);
      record.phases = {
        queueMs: round(Math.max(0, requestStartMs - record.hopStartMs)),
        dnsMs: round(span(timing.dnsStart, timing.dnsEnd)),
        connectMs: round(Math.max(0, span(timing.connectStart, timing.connectEnd) - tlsMs)),
        tlsMs: round(tlsMs),
        sendMs: round(span(timing.sendStart, timing.sendEnd)),
        waitMs: round(Math.max(0, timing.receiveHeadersEnd - timing.sendEnd)),
        downloadMs: 0,
      };
    }
  }

  /** @param {any} event */
  #onData(event) {
    const record = this.#records.get(event.requestId);
    if (!record) return;
    // Streams deliver data forever; their messages must not keep the page from settling.
    if (!record.streaming) this.#lastActivity = Date.now();
    record.bodyBytes += event.dataLength ?? 0;
  }

  /** @param {any} event */
  #onFinished(event) {
    const record = this.#records.get(event.requestId);
    if (!record) return;
    this.#lastActivity = Date.now();
    this.#inflight.delete(event.requestId);
    record.endMs = this.#relative(event.timestamp);
    record.durationMs = round(record.endMs - record.startMs);
    record.transferBytes = event.encodedDataLength ?? 0;
    if (record.phases && record.responseStartMs !== null) {
      record.phases.downloadMs = round(Math.max(0, record.endMs - record.responseStartMs));
    }
    if (this.#inspectJson && isJsonApi(record) && record.bodyBytes <= MAX_JSON_INSPECT_BYTES) {
      this.#bodyInspections.push(this.#inspectBody(record));
    }
  }

  /** @param {any} event */
  #onFailed(event) {
    const record = this.#records.get(event.requestId);
    if (!record) return;
    this.#lastActivity = Date.now();
    this.#inflight.delete(event.requestId);
    record.endMs = this.#relative(event.timestamp);
    record.durationMs = round(record.endMs - record.startMs);
    record.failure = { errorText: String(event.errorText ?? 'failed'), canceled: !!event.canceled };
  }

  /** @param {any} event */
  #onServedFromCache(event) {
    const record = this.#records.get(event.requestId);
    if (record) record.fromCache = true;
  }

  /**
   * Reads a JSON response body to summarize its shape. The body itself is never stored.
   *
   * @param {RequestRecord} record
   */
  async #inspectBody(record) {
    try {
      const { body, base64Encoded } = await this.#session.send('Network.getResponseBody', {
        requestId: record.id,
      });
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
      if (record.bodyBytes === 0) record.bodyBytes = Buffer.byteLength(text);
      record.jsonShape = describeJsonShape(JSON.parse(text));
    } catch {
      // Body evicted, not JSON, or the page navigated away; the shape stays unknown.
    }
  }
}

/**
 * @param {unknown} value
 * @returns {JsonShape}
 */
export function describeJsonShape(value) {
  let largestArrayLength = 0;
  let keyCount = 0;
  let depth = 0;
  /** @type {Array<[unknown, number]>} */
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [current, level] = /** @type {[unknown, number]} */ (stack.pop());
    if (Array.isArray(current)) {
      depth = Math.max(depth, level);
      largestArrayLength = Math.max(largestArrayLength, current.length);
      for (const item of current) stack.push([item, level + 1]);
    } else if (current !== null && typeof current === 'object') {
      depth = Math.max(depth, level);
      const values = Object.values(current);
      keyCount += values.length;
      for (const item of values) stack.push([item, level + 1]);
    }
  }
  return {
    rootType: Array.isArray(value)
      ? 'array'
      : value !== null && typeof value === 'object'
        ? 'object'
        : 'scalar',
    largestArrayLength,
    keyCount,
    depth,
  };
}

/**
 * @param {any} initiator
 * @returns {Initiator}
 */
export function simplifyInitiator(initiator) {
  /** @type {string[]} */
  const stackUrls = [];
  let stack = initiator?.stack;
  while (stack) {
    for (const frame of stack.callFrames ?? []) {
      if (frame.url && !stackUrls.includes(frame.url)) stackUrls.push(frame.url);
    }
    stack = stack.parent;
  }
  return {
    type: String(initiator?.type ?? 'other'),
    url: initiator?.url ?? stackUrls[0] ?? null,
    stackUrls,
    requestId: initiator?.requestId ?? null,
  };
}

/**
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
function pickHeaders(headers) {
  /** @type {Record<string, string>} */
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (KEPT_RESPONSE_HEADERS.has(lower)) kept[lower] = String(value).slice(0, 500);
  }
  return kept;
}

/**
 * @param {RequestRecord} record
 * @returns {boolean}
 */
function isJsonApi(record) {
  return (
    (record.resourceType === 'Fetch' || record.resourceType === 'XHR') &&
    /json/i.test(record.mimeType ?? '')
  );
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
