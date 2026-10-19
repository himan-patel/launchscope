import { readFile, rename, writeFile } from 'node:fs/promises';

/**
 * HAR files are handy for Chrome DevTools and other tools, but raw HARs contain cookies,
 * tokens, and request bodies. LaunchScope records them with bodies omitted and then scrubs
 * every remaining secret-bearing field, so a HAR from a report can be shared safely.
 */

export const REDACTED = '[redacted]';

const SENSITIVE_HEADER =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$|token|secret|session|auth|apikey|api-key|password|signature/i;
const SENSITIVE_PARAM =
  /^(?:code|state|sig|signature|key|api_?key|token|access_?token|refresh_?token|id_?token|auth|password|passwd|secret|session|sid|jwt|otp)$|token|secret|password/i;

/**
 * @typedef {{ name: string, value: string }} NameValue
 */

/**
 * Redacts a parsed HAR object in place and returns it.
 *
 * @param {any} har
 * @returns {any}
 */
export function redactHar(har) {
  for (const entry of har?.log?.entries ?? []) {
    const request = entry.request ?? {};
    const response = entry.response ?? {};
    request.url = redactUrl(request.url);
    request.headers = redactHeaders(request.headers);
    request.cookies = [];
    request.queryString = (request.queryString ?? []).map((/** @type {NameValue} */ param) =>
      SENSITIVE_PARAM.test(param.name) ? { ...param, value: REDACTED } : param,
    );
    delete request.postData;
    response.headers = redactHeaders(response.headers);
    response.cookies = [];
    if (response.redirectURL) response.redirectURL = redactUrl(response.redirectURL);
    if (response.content) delete response.content.text;
  }
  for (const page of har?.log?.pages ?? []) {
    if (page.title) page.title = redactUrl(page.title);
  }
  return har;
}

/**
 * Reads, redacts, and atomically rewrites a HAR file.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function redactHarFile(path) {
  const har = JSON.parse(await readFile(path, 'utf8'));
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(redactHar(har), null, 1), { mode: 0o600 });
  await rename(temporaryPath, path);
}

/**
 * @param {NameValue[] | undefined} headers
 * @returns {NameValue[]}
 */
function redactHeaders(headers) {
  return (headers ?? []).map((header) =>
    SENSITIVE_HEADER.test(header.name) ? { ...header, value: REDACTED } : header,
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function redactUrl(value) {
  const text = String(value ?? '');
  let url;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(name)) url.searchParams.set(name, REDACTED);
  }
  return url.href;
}
