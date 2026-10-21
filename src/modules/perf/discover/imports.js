import { readFile, stat } from 'node:fs/promises';
import { UsageError } from '../../../core/errors.js';
import { isPostmanCollection, postmanRequests } from './postman.js';

/**
 * Turns recorded or saved requests into API operations to measure directly: HAR files (exported
 * from browser DevTools or proxies) and Postman collections (v2.0/v2.1). Only requests to the target origin that look like API calls
 * are used. GET requests are imported as they are; POST, PUT, and PATCH only with
 * `includeWrites`, with their recorded bodies; DELETE and other methods never. Headers and
 * cookies from the file are never used, so credentials in it are not replayed: pass `--header`
 * or `--storage-state` instead.
 */

const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SKIPPED_LISTED = 200;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch']);
const API_MIME = /json|xml|graphql|text\/plain|x-www-form-urlencoded/i;

/**
 * @typedef {object} ImportSkip
 * @property {string} method
 * @property {string} path Path (or URL for other origins), without the query string.
 * @property {string} reason
 * @property {number} count How many requests were skipped for this method, path, and reason.
 */

/**
 * @typedef {object} ImportPlan
 * @property {import('./openapi.js').ApiOperation[]} operations
 * @property {ImportSkip[]} skipped
 * @property {Array<{ file: string, format: 'har' | 'postman', operations: number }>} sources
 */

/**
 * @param {object} options
 * @param {string[]} options.files Absolute paths.
 * @param {URL} options.targetUrl
 * @param {boolean} options.includeWrites Import POST/PUT/PATCH requests with their bodies.
 * @param {number} options.limit Maximum operations across all files.
 * @returns {Promise<ImportPlan>}
 */
export async function loadImports({ files, targetUrl, includeWrites, limit }) {
  /** @type {ImportPlan} */
  const plan = { operations: [], skipped: [], sources: [] };
  /** @type {Map<string, ImportSkip>} */
  const skips = new Map();
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} method @param {string} path @param {string} reason */
  const skip = (method, path, reason) => {
    const key = `${method} ${path} ${reason}`;
    const existing = skips.get(key);
    if (existing) existing.count += 1;
    else skips.set(key, { method, path, reason, count: 1 });
  };

  for (const file of files) {
    const document = await readImportFile(file);
    const before = plan.operations.length;
    const format = isPostmanCollection(document) ? 'postman' : 'har';
    const requests =
      format === 'postman' ? postmanRequests(document, targetUrl) : harRequests(document, file);
    for (const request of requests) {
      if (request.skipReason) {
        skip(request.method, request.url, request.skipReason);
        continue;
      }
      const operation = toOperation(request, { targetUrl, includeWrites, skip });
      if (!operation) continue;
      const key = `${operation.method ?? 'GET'} ${operation.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (plan.operations.length >= limit) {
        skip(operation.method ?? 'GET', operation.path, `limit of ${limit} operations reached`);
        continue;
      }
      plan.operations.push(operation);
    }
    plan.sources.push({ file, format, operations: plan.operations.length - before });
  }
  plan.skipped = [...skips.values()].sort((a, b) => b.count - a.count).slice(0, MAX_SKIPPED_LISTED);
  return plan;
}

/**
 * @typedef {object} ImportedRequest
 * @property {string} method
 * @property {string} url
 * @property {string | null} body
 * @property {string | null} contentType
 * @property {boolean} looksLikeApi
 * @property {string} kind Shown when the request is not an API call, e.g. `document`.
 * @property {string} [skipReason] Set when the request cannot be sent as it is.
 */

/**
 * @param {string} file
 * @returns {Promise<any>}
 */
async function readImportFile(file) {
  let text;
  try {
    if ((await stat(file)).size > MAX_IMPORT_BYTES) {
      throw new UsageError(`Import file ${file} is larger than 100 MB.`);
    }
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Could not read import file ${file}.`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`Import file ${file} is not JSON.`, {
      cause: error,
      hint: 'Use a HAR file (DevTools Network panel → "Save all as HAR") or a Postman collection export.',
    });
  }
}

/**
 * @param {any} document
 * @param {string} file
 * @returns {ImportedRequest[]}
 */
function harRequests(document, file) {
  const entries = document?.log?.entries;
  if (!Array.isArray(entries)) {
    throw new UsageError(`Import file ${file} is neither a HAR file nor a Postman collection.`, {
      hint: 'Postman: export the collection as "Collection v2.1". HAR: DevTools → Network → "Save all as HAR".',
    });
  }
  /** @type {ImportedRequest[]} */
  const requests = [];
  for (const entry of entries) {
    const request = entry?.request;
    if (typeof request?.method !== 'string' || typeof request?.url !== 'string') continue;
    const resourceType = typeof entry._resourceType === 'string' ? entry._resourceType : null;
    const mime = String(entry.response?.content?.mimeType ?? request.postData?.mimeType ?? '');
    requests.push({
      method: request.method.toUpperCase(),
      url: request.url,
      ...harBody(request.postData),
      // Chromium records the resource type; other browsers' HARs are judged by content type.
      looksLikeApi: resourceType
        ? API_RESOURCE_TYPES.has(resourceType.toLowerCase())
        : API_MIME.test(mime),
      kind: resourceType ?? (mime.split(';')[0] || 'unknown type'),
    });
  }
  return requests;
}

/**
 * @param {any} postData
 * @returns {{ body: string | null, contentType: string | null }}
 */
function harBody(postData) {
  if (!postData || typeof postData !== 'object') return { body: null, contentType: null };
  const contentType =
    typeof postData.mimeType === 'string' && postData.mimeType ? postData.mimeType : null;
  if (typeof postData.text === 'string') return { body: postData.text, contentType };
  if (Array.isArray(postData.params)) {
    const form = new URLSearchParams();
    for (const param of postData.params) {
      if (typeof param?.name === 'string') form.append(param.name, String(param.value ?? ''));
    }
    return {
      body: form.toString(),
      contentType: contentType ?? 'application/x-www-form-urlencoded',
    };
  }
  return { body: null, contentType };
}

/**
 * @param {ImportedRequest} request
 * @param {{ targetUrl: URL, includeWrites: boolean, skip: (method: string, path: string, reason: string) => void }} options
 * @returns {import('./openapi.js').ApiOperation | null}
 */
function toOperation(request, { targetUrl, includeWrites, skip }) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    skip(request.method, request.url.slice(0, 200), 'not a valid URL');
    return null;
  }
  const { method } = request;
  if (url.origin !== targetUrl.origin) {
    skip(method, `${url.origin}${url.pathname}`, 'not on the target origin');
    return null;
  }
  if (!request.looksLikeApi) {
    skip(method, url.pathname, `not an API call (${request.kind})`);
    return null;
  }
  if (method !== 'GET' && !WRITE_METHODS.has(method)) {
    skip(method, url.pathname, `${method} is never sent`);
    return null;
  }
  if (method !== 'GET' && !includeWrites) {
    skip(method, url.pathname, 'writes are imported only with --import-writes');
    return null;
  }
  if (request.body !== null && Buffer.byteLength(request.body) > MAX_BODY_BYTES) {
    skip(method, url.pathname, 'request body is larger than 1 MB');
    return null;
  }
  url.hash = '';
  return method === 'GET'
    ? { url: url.href, path: url.pathname, operationId: null }
    : {
        url: url.href,
        path: url.pathname,
        operationId: null,
        method: /** @type {'POST' | 'PUT' | 'PATCH'} */ (method),
        body: request.body,
        contentType: request.contentType,
      };
}
