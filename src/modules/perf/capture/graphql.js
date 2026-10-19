/**
 * GraphQL APIs usually serve every operation from one URL (`POST /graphql`), so grouping by URL
 * would blend a 5 ms `GetViewer` with a 900 ms `SearchProjects`. These helpers identify the
 * operation behind a request so endpoints can be analyzed per operation. Request bodies are
 * parsed in memory only; nothing but the operation name and type is kept.
 */

/** @typedef {'query' | 'mutation' | 'subscription'} OperationType */

/**
 * @typedef {object} GraphqlOperation
 * @property {string} name Operation name, or `(anonymous)`.
 * @property {OperationType | null} type
 * @property {boolean} persisted Sent as a persisted query (hash instead of query text).
 * @property {string} [bodyHash] Short hash of the POST body, to tell identical calls apart.
 */

const MAX_BODY_CHARS = 256 * 1024;
const OPERATION =
  /^\s*(?:#[^\n]*\n\s*)*(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/;
const SHORTHAND_QUERY = /^\s*(?:#[^\n]*\n\s*)*\{/;

/**
 * Whether a request is worth inspecting as GraphQL: a path ending in `graphql` (or `gql`), or
 * a GET whose query string carries a GraphQL document.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function looksLikeGraphql(url) {
  try {
    const parsed = new URL(url);
    return (
      /\/(?:graphql|gql)\/?$/i.test(parsed.pathname) ||
      (parsed.searchParams.has('query') &&
        /\b(?:query|mutation)\b|^\s*\{/.test(parsed.searchParams.get('query') ?? ''))
    );
  } catch {
    return false;
  }
}

/**
 * Identifies the operation(s) in a GraphQL request. Batched requests (a JSON array) produce one
 * combined name, e.g. `GetUser+GetFlags`.
 *
 * @param {{ url: string, method: string, postData?: string | null }} request
 * @returns {GraphqlOperation | null} Null when the request is not GraphQL.
 */
export function detectGraphqlOperation({ url, method, postData }) {
  if (method === 'GET') {
    let params;
    try {
      params = new URL(url).searchParams;
    } catch {
      return null;
    }
    const document = params.get('query');
    const extensions = params.get('extensions');
    if (document === null && !extensions?.includes('persistedQuery')) return null;
    return describe(
      params.get('operationName'),
      document,
      Boolean(extensions?.includes('persistedQuery')),
    );
  }

  if (!postData || postData.length > MAX_BODY_CHARS) return null;
  let body;
  try {
    body = JSON.parse(postData);
  } catch {
    return null;
  }
  const operations = (Array.isArray(body) ? body : [body]).filter(
    (item) =>
      item &&
      typeof item === 'object' &&
      ('query' in item || 'extensions' in item || 'operationName' in item),
  );
  if (operations.length === 0) return null;
  const described = operations.map((item) =>
    describe(
      typeof item.operationName === 'string' ? item.operationName : null,
      typeof item.query === 'string' ? item.query : null,
      Boolean(item.extensions?.persistedQuery),
    ),
  );
  if (described.length === 1) return described[0];
  const types = new Set(described.map((operation) => operation.type));
  return {
    name: described.map((operation) => operation.name).join('+'),
    type: types.size === 1 ? described[0].type : null,
    persisted: described.every((operation) => operation.persisted),
  };
}

/**
 * @param {string | null} operationName
 * @param {string | null} document
 * @param {boolean} persisted
 * @returns {GraphqlOperation}
 */
function describe(operationName, document, persisted) {
  const match = document ? OPERATION.exec(document) : null;
  /** @type {OperationType | null} */
  let type = match ? /** @type {OperationType} */ (match[1]) : null;
  if (!type && document && SHORTHAND_QUERY.test(document)) type = 'query';
  const name = sanitize(operationName) ?? sanitize(match?.[2] ?? null) ?? '(anonymous)';
  return { name, type, persisted };
}

/**
 * @param {string | null} value
 * @returns {string | null}
 */
function sanitize(value) {
  if (!value) return null;
  return /^[_A-Za-z][_0-9A-Za-z]{0,99}$/.test(value) ? value : null;
}
