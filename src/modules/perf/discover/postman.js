/**
 * Reads the requests in a Postman collection (v2.0 or v2.1, as exported from Postman). Folders
 * are walked recursively and `{{variables}}` are filled from the collection's own variables. A
 * request whose URL starts with an unresolved variable (usually `{{baseUrl}}`) is pointed at the
 * target; any other unresolved variable skips the request instead of sending a guess. Auth
 * settings and headers are never used (only a body's Content-Type), so saved credentials are not
 * replayed.
 */

const VARIABLE = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const MAX_DEPTH = 20;

/**
 * @param {any} document
 * @returns {boolean}
 */
export function isPostmanCollection(document) {
  const schema = document?.info?.schema;
  return (
    Array.isArray(document?.item) &&
    (typeof schema === 'string'
      ? /getpostman\.com\/json\/collection\/v2/i.test(schema)
      : typeof document?.info?._postman_id === 'string')
  );
}

/**
 * @param {any} document A Postman collection.
 * @param {URL} targetUrl
 * @returns {import('./imports.js').ImportedRequest[]}
 */
export function postmanRequests(document, targetUrl) {
  /** @type {Map<string, string>} */
  const variables = new Map();
  for (const variable of Array.isArray(document.variable) ? document.variable : []) {
    if (
      typeof variable?.key === 'string' &&
      variable.disabled !== true &&
      variable.value !== undefined &&
      variable.value !== null
    ) {
      variables.set(variable.key, String(variable.value));
    }
  }
  /** @type {import('./imports.js').ImportedRequest[]} */
  const requests = [];
  /** @param {any[]} items @param {string} folder @param {number} depth */
  const walk = (items, folder, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const item of items) {
      if (Array.isArray(item?.item)) {
        walk(item.item, `${folder}${String(item.name ?? '')}/`, depth + 1);
      } else if (item?.request) {
        requests.push(
          toRequest(item.request, `${folder}${String(item.name ?? '')}`, variables, targetUrl),
        );
      }
    }
  };
  walk(document.item, '', 0);
  return requests;
}

/**
 * @param {any} request
 * @param {string} name Folder path and request name, for skip reasons.
 * @param {Map<string, string>} variables
 * @param {URL} targetUrl
 * @returns {import('./imports.js').ImportedRequest}
 */
function toRequest(request, name, variables, targetUrl) {
  const method = String((typeof request === 'object' && request.method) || 'GET').toUpperCase();
  const rawUrl = typeof request === 'string' ? request : rawUrlOf(request.url);
  /** @type {import('./imports.js').ImportedRequest} */
  const base = {
    method,
    url: '',
    body: null,
    contentType: null,
    looksLikeApi: true,
    kind: 'postman request',
  };
  if (!rawUrl) return { ...base, url: name, skipReason: 'request has no URL' };

  // A leading variable that the collection does not define is the base URL: use the target.
  const leading = /^\{\{\s*([^{}\s]+)\s*\}\}/.exec(rawUrl);
  const withBase =
    leading && !variables.has(leading[1])
      ? `${targetUrl.origin}${ensureLeadingSlash(rawUrl.slice(leading[0].length))}`
      : rawUrl;
  const url = substitute(withBase, variables);
  if (url.missing) {
    return { ...base, url: name, skipReason: `unresolved variable {{${url.missing}}}` };
  }
  // Like Postman, a URL without a scheme is fine; use the target's.
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.value)
    ? url.value
    : `${targetUrl.protocol}//${url.value}`;

  const body =
    typeof request === 'object' ? bodyOf(request, variables) : { body: null, contentType: null };
  if ('skipReason' in body) return { ...base, url: absolute, skipReason: body.skipReason };
  return { ...base, url: absolute, ...body };
}

/**
 * @param {any} url A string or a Postman URL object.
 * @returns {string | null}
 */
function rawUrlOf(url) {
  if (typeof url === 'string') return url.trim() || null;
  if (!url || typeof url !== 'object') return null;
  if (typeof url.raw === 'string' && url.raw.trim()) return url.raw.trim();
  // Exports without `raw` keep the parts.
  const host = Array.isArray(url.host) ? url.host.join('.') : (url.host ?? '');
  const path = Array.isArray(url.path) ? url.path.join('/') : (url.path ?? '');
  if (!host && !path) return null;
  const protocol = url.protocol ? `${url.protocol}://` : '';
  const query = Array.isArray(url.query)
    ? url.query
        .filter((/** @type {any} */ param) => param && param.disabled !== true && param.key)
        .map((/** @type {any} */ param) => `${param.key}=${param.value ?? ''}`)
        .join('&')
    : '';
  return `${protocol}${host}${url.port ? `:${url.port}` : ''}/${path}${query ? `?${query}` : ''}`;
}

/**
 * @param {any} request
 * @param {Map<string, string>} variables
 * @returns {{ body: string | null, contentType: string | null } | { skipReason: string }}
 */
function bodyOf(request, variables) {
  const body = request.body;
  const declared = headerValue(request.header, 'content-type');
  if (!body || typeof body !== 'object' || body.disabled === true) {
    return { body: null, contentType: null };
  }
  /** @type {string} */
  let text;
  /** @type {string | null} */
  let contentType = declared;
  switch (body.mode) {
    case 'raw': {
      if (typeof body.raw !== 'string' || body.raw === '') return { body: null, contentType: null };
      text = body.raw;
      const language = body.options?.raw?.language;
      contentType ??=
        language === 'json'
          ? 'application/json'
          : language === 'xml'
            ? 'application/xml'
            : 'text/plain;charset=UTF-8';
      break;
    }
    case 'urlencoded': {
      const form = new URLSearchParams();
      for (const param of Array.isArray(body.urlencoded) ? body.urlencoded : []) {
        if (param && param.disabled !== true && typeof param.key === 'string') {
          form.append(param.key, String(param.value ?? ''));
        }
      }
      text = form.toString();
      contentType ??= 'application/x-www-form-urlencoded';
      break;
    }
    case 'graphql': {
      const graphql = body.graphql ?? {};
      let variablesValue;
      try {
        variablesValue =
          typeof graphql.variables === 'string' && graphql.variables.trim()
            ? JSON.parse(substitute(graphql.variables, variables).value)
            : undefined;
      } catch {
        return { skipReason: 'GraphQL variables are not valid JSON' };
      }
      text = JSON.stringify({ query: String(graphql.query ?? ''), variables: variablesValue });
      contentType ??= 'application/json';
      break;
    }
    default:
      return { skipReason: `${String(body.mode ?? 'unknown')} bodies are not supported` };
  }
  const filled = substitute(text, variables);
  if (filled.missing)
    return { skipReason: `unresolved variable {{${filled.missing}}} in the body` };
  return { body: filled.value, contentType };
}

/**
 * @param {unknown} headers
 * @param {string} name Lowercase.
 * @returns {string | null}
 */
function headerValue(headers, name) {
  if (!Array.isArray(headers)) return null;
  const header = headers.find(
    (item) => item && item.disabled !== true && String(item.key ?? '').toLowerCase() === name,
  );
  const value = header?.value;
  return typeof value === 'string' && value && !/[\r\n{}]/.test(value) ? value : null;
}

/**
 * @param {string} text
 * @param {Map<string, string>} variables
 * @returns {{ value: string, missing: string | null }}
 */
function substitute(text, variables) {
  /** @type {string | null} */
  let missing = null;
  const value = text.replace(VARIABLE, (match, name) => {
    const known = variables.get(name);
    if (known === undefined) {
      missing ??= name;
      return match;
    }
    return known;
  });
  return { value, missing };
}

/** @param {string} path */
function ensureLeadingSlash(path) {
  return path === '' || path.startsWith('/') || path.startsWith('?') ? path : `/${path}`;
}
