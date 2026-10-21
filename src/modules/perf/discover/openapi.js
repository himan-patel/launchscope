import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { UsageError } from '../../../core/errors.js';

/**
 * Reads an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) and turns its safe operations into URLs
 * that can be measured directly. Only GET operations on the target origin are used. Path and
 * required query parameters must have an example or default value; operations that need values
 * LaunchScope cannot guess are reported as skipped rather than called with made-up input.
 */

/** Well-known spec locations tried by `--openapi auto`. */
export const WELL_KNOWN_SPEC_PATHS = Object.freeze([
  '/openapi.json',
  '/swagger.json',
  '/v3/api-docs',
  '/api-docs',
  '/api/openapi.json',
  '/swagger/v1/swagger.json',
  '/openapi.yaml',
  '/openapi.yml',
  '/swagger.yaml',
]);

const MAX_SPEC_BYTES = 10 * 1024 * 1024;
/** YAML aliases can expand exponentially ("billion laughs"); real specs need few. */
const MAX_YAML_ALIASES = 100;
const SPEC_ACCEPT = 'application/json, application/yaml;q=0.9, text/yaml;q=0.9, */*;q=0.5';

/**
 * @typedef {object} ApiOperation
 * @property {string} url Concrete URL to call.
 * @property {string} path Path template from the spec, e.g. `/api/items/{id}`.
 * @property {string | null} operationId
 * @property {'POST' | 'PUT' | 'PATCH'} [method] Omitted for GET. Writes come only from endpoints
 *   the user listed, never from a spec.
 * @property {string | null} [body] Request body for writes, held in memory only.
 * @property {string | null} [contentType]
 */

/**
 * @typedef {object} SkippedOperation
 * @property {string} method
 * @property {string} path
 * @property {string} reason
 */

/**
 * @typedef {object} OpenApiPlan
 * @property {string} source Where the spec was read from.
 * @property {string | null} title
 * @property {ApiOperation[]} operations
 * @property {SkippedOperation[]} skipped
 */

/**
 * Loads a spec from a URL, a file, or (`auto`) the first well-known path that answers.
 *
 * @param {object} options
 * @param {string} options.reference `auto`, an http(s) URL, or an absolute file path.
 * @param {URL} options.targetUrl
 * @param {Record<string, string>} options.headers Sent only to the target origin.
 * @param {number} options.timeoutMs
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ source: string, document: any } | null>} Null when `auto` finds nothing.
 */
export async function loadOpenApi({ reference, targetUrl, headers, timeoutMs, fetchImpl = fetch }) {
  if (reference === 'auto') {
    for (const path of WELL_KNOWN_SPEC_PATHS) {
      const url = new URL(path, targetUrl.origin);
      const document = await fetchSpec(url, headers, timeoutMs, fetchImpl, { optional: true });
      if (document) return { source: url.href, document };
    }
    return null;
  }
  if (/^https?:\/\//i.test(reference)) {
    const url = new URL(reference);
    const sameOrigin = url.origin === targetUrl.origin;
    const document = await fetchSpec(url, sameOrigin ? headers : {}, timeoutMs, fetchImpl, {
      optional: false,
    });
    return { source: url.href, document };
  }
  let text;
  try {
    text = await readFile(reference, 'utf8');
  } catch (error) {
    throw new UsageError(`Could not read OpenAPI file ${reference}.`, { cause: error });
  }
  return { source: reference, document: parseSpec(text, reference) };
}

/**
 * @param {URL} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @param {typeof fetch} fetchImpl
 * @param {{ optional: boolean }} options
 * @returns {Promise<any | null>}
 */
async function fetchSpec(url, headers, timeoutMs, fetchImpl, { optional }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { ...headers, accept: SPEC_ACCEPT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (optional) return null;
    throw new UsageError(`Could not fetch OpenAPI document ${url.href}.`, { cause: error });
  }
  if (!response.ok) {
    if (optional) return null;
    throw new UsageError(`OpenAPI document ${url.href} returned HTTP ${response.status}.`);
  }
  const text = await response.text();
  if (optional) {
    try {
      const document = parseSpec(text, url.href);
      return document;
    } catch {
      return null;
    }
  }
  return parseSpec(text, url.href);
}

/**
 * @param {string} text
 * @param {string} source
 * @returns {any}
 */
export function parseSpec(text, source) {
  if (text.length > MAX_SPEC_BYTES)
    throw new UsageError(`OpenAPI document ${source} is larger than 10 MB.`);
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    try {
      // The YAML 1.2 core schema has no custom tags, so parsing never runs code or loads files.
      document = parseYaml(text, { schema: 'core', maxAliasCount: MAX_YAML_ALIASES });
    } catch (error) {
      throw new UsageError(`OpenAPI document ${source} is neither JSON nor valid YAML.`, {
        cause: error,
        hint: error instanceof Error ? error.message.split('\n')[0] : undefined,
      });
    }
  }
  const version = String(document?.openapi ?? document?.swagger ?? '');
  if (
    !/^(?:3\.|2\.0)/.test(version) ||
    typeof document.paths !== 'object' ||
    document.paths === null
  ) {
    throw new UsageError(`${source} is not an OpenAPI 3.x or Swagger 2.0 document.`);
  }
  return document;
}

/**
 * Turns a spec into concrete GET URLs on the target origin.
 *
 * @param {object} options
 * @param {any} options.document
 * @param {string} options.source
 * @param {URL} options.targetUrl
 * @param {number} options.limit Maximum operations to return.
 * @returns {OpenApiPlan}
 */
export function planOperations({ document, source, targetUrl, limit }) {
  const base = resolveBaseUrl(document, source, targetUrl);
  /** @type {ApiOperation[]} */
  const operations = [];
  /** @type {SkippedOperation[]} */
  const skipped = [];

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of Object.keys(item)) {
      if (
        ['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace'].includes(method) &&
        method !== 'get'
      ) {
        skipped.push({
          method: method.toUpperCase(),
          path,
          reason: 'only GET operations are called',
        });
      }
    }
    const operation = item.get;
    if (!operation || typeof operation !== 'object') continue;

    if (base.origin !== targetUrl.origin) {
      skipped.push({
        method: 'GET',
        path,
        reason: `server ${base.origin} is not the target origin`,
      });
      continue;
    }
    if (operation.deprecated === true) {
      skipped.push({ method: 'GET', path, reason: 'deprecated' });
      continue;
    }

    const parameters = [
      ...(Array.isArray(item.parameters) ? item.parameters : []),
      ...(Array.isArray(operation.parameters) ? operation.parameters : []),
    ]
      .map((parameter) => resolveRef(document, parameter))
      .filter((parameter) => parameter && typeof parameter === 'object');

    let concretePath = path;
    const query = new URLSearchParams();
    let missing = null;
    for (const parameter of parameters) {
      const value = exampleValue(document, parameter);
      if (parameter.in === 'path') {
        if (value === undefined) {
          missing = `path parameter "${parameter.name}" has no example or default`;
          break;
        }
        concretePath = concretePath.replaceAll(
          `{${parameter.name}}`,
          encodeURIComponent(String(value)),
        );
      } else if (parameter.in === 'query') {
        if (value !== undefined) query.set(parameter.name, String(value));
        else if (parameter.required) {
          missing = `required query parameter "${parameter.name}" has no example or default`;
          break;
        }
      } else if (parameter.in === 'header' && parameter.required && value === undefined) {
        missing = `required header "${parameter.name}" has no example or default`;
        break;
      }
    }
    if (!missing && /\{[^}]+\}/.test(concretePath)) missing = 'path has undeclared parameters';
    if (missing) {
      skipped.push({ method: 'GET', path, reason: missing });
      continue;
    }
    if (operations.length >= limit) {
      skipped.push({ method: 'GET', path, reason: `limit of ${limit} operations reached` });
      continue;
    }

    const url = new URL(`${base.pathname.replace(/\/$/, '')}${concretePath}`, base.origin);
    url.search = query.toString();
    operations.push({
      url: url.href,
      path,
      operationId: typeof operation.operationId === 'string' ? operation.operationId : null,
    });
  }

  return {
    source,
    title: typeof document.info?.title === 'string' ? document.info.title : null,
    operations,
    skipped,
  };
}

/**
 * @param {any} document
 * @param {string} source
 * @param {URL} targetUrl
 * @returns {URL}
 */
function resolveBaseUrl(document, source, targetUrl) {
  const relativeTo = /^https?:\/\//i.test(source) ? source : targetUrl.href;
  if (typeof document.swagger === 'string') {
    const scheme =
      Array.isArray(document.schemes) && document.schemes.length > 0
        ? document.schemes[0]
        : targetUrl.protocol.replace(':', '');
    const host =
      typeof document.host === 'string' ? `${scheme}://${document.host}` : targetUrl.origin;
    return new URL(typeof document.basePath === 'string' ? document.basePath : '/', host);
  }
  const server = Array.isArray(document.servers) ? document.servers[0] : undefined;
  if (!server || typeof server.url !== 'string') return new URL('/', targetUrl.origin);
  let serverUrl = server.url;
  for (const [name, variable] of Object.entries(server.variables ?? {})) {
    serverUrl = serverUrl.replaceAll(
      `{${name}}`,
      String(/** @type {any} */ (variable)?.default ?? ''),
    );
  }
  return new URL(serverUrl, relativeTo);
}

/**
 * @param {any} document
 * @param {any} parameter
 * @returns {unknown}
 */
function exampleValue(document, parameter) {
  const schema = resolveRef(document, parameter.schema) ?? {};
  const fromExamples =
    parameter.examples && typeof parameter.examples === 'object'
      ? resolveRef(document, Object.values(parameter.examples)[0])?.value
      : undefined;
  const candidates = [
    parameter.example,
    fromExamples,
    schema.example,
    Array.isArray(schema.examples) ? schema.examples[0] : undefined,
    schema.default,
    parameter['x-example'],
    parameter.default,
    Array.isArray(schema.enum) ? schema.enum[0] : undefined,
  ];
  return candidates.find(
    (value) => value !== undefined && value !== null && typeof value !== 'object',
  );
}

/**
 * Resolves a local `$ref` (`#/components/...`) one level, which covers shared parameters and
 * schemas in practice.
 *
 * @param {any} document
 * @param {any} value
 * @returns {any}
 */
function resolveRef(document, value) {
  if (!value || typeof value !== 'object' || typeof value.$ref !== 'string') return value;
  if (!value.$ref.startsWith('#/')) return undefined;
  return value.$ref
    .slice(2)
    .split('/')
    .map((/** @type {string} */ segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce(
      (/** @type {any} */ node, /** @type {string} */ segment) =>
        node && typeof node === 'object' ? node[segment] : undefined,
      document,
    );
}
