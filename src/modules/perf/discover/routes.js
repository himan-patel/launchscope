import { ALWAYS_EXCLUDED } from '../settings.js';

/** File extensions that are not pages, so following them would not measure a route. */
const NON_PAGE_EXTENSION =
  /\.(?:pdf|zip|gz|tar|rar|7z|png|jpe?g|gif|svg|webp|avif|ico|bmp|css|m?js|json|xml|txt|csv|mp4|webm|mov|mp3|wav|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|dmg|exe|apk)$/i;

const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;
const MAX_CHILD_SITEMAPS = 5;
const MAX_QUERY_VARIANTS_PER_PATH = 3;

/**
 * @typedef {'off-origin' | 'excluded' | 'logout' | 'not-a-page' | 'invalid' | 'duplicate' | 'limit' | 'query-variants'} SkipReason
 */

/**
 * @typedef {object} QueuedRoute
 * @property {string} url
 * @property {number} depth 0 for seeds, +1 per crawled link.
 * @property {'seed' | 'sitemap' | 'link'} source
 */

/**
 * Decides whether a discovered URL is a measurable route on the target origin.
 *
 * @param {string} href
 * @param {URL} targetUrl
 * @param {RegExp[]} exclude
 * @returns {{ url: string } | { skip: SkipReason }}
 */
export function normalizeRoute(href, targetUrl, exclude) {
  let url;
  try {
    url = new URL(href, targetUrl);
  } catch {
    return { skip: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { skip: 'invalid' };
  if (url.origin !== targetUrl.origin) return { skip: 'off-origin' };
  if (url.username || url.password) return { skip: 'invalid' };
  url.hash = '';
  if (ALWAYS_EXCLUDED.test(`${url.pathname}${url.search}`)) return { skip: 'logout' };
  if (NON_PAGE_EXTENSION.test(url.pathname)) return { skip: 'not-a-page' };
  if (exclude.some((pattern) => pattern.test(url.href))) return { skip: 'excluded' };
  return { url: url.href };
}

/**
 * Breadth-first route queue with a global limit, de-duplication, and a cap on query-string
 * variants per path (so `/search?q=a`, `/search?q=b`, ... cannot crowd out real routes).
 */
export class RouteQueue {
  /** @type {QueuedRoute[]} */
  #pending = [];
  /** @type {Set<string>} */
  #seen = new Set();
  /** @type {Map<string, number>} */
  #queryVariants = new Map();
  /** @type {Map<SkipReason, number>} */
  #skipped = new Map();
  #accepted = 0;
  #targetUrl;
  #exclude;
  #maxRoutes;

  /**
   * @param {{ targetUrl: URL, exclude: RegExp[], maxRoutes: number }} options
   */
  constructor({ targetUrl, exclude, maxRoutes }) {
    this.#targetUrl = targetUrl;
    this.#exclude = exclude;
    this.#maxRoutes = maxRoutes;
  }

  /**
   * @param {string} href
   * @param {number} depth
   * @param {QueuedRoute['source']} source
   * @returns {boolean} True if the route was queued.
   */
  add(href, depth, source) {
    const normalized = normalizeRoute(href, this.#targetUrl, this.#exclude);
    if ('skip' in normalized) return this.#skip(normalized.skip);
    if (this.#seen.has(normalized.url)) return this.#skip('duplicate');
    if (this.#accepted >= this.#maxRoutes) return this.#skip('limit');

    const url = new URL(normalized.url);
    if (url.search) {
      const variants = this.#queryVariants.get(url.pathname) ?? 0;
      if (variants >= MAX_QUERY_VARIANTS_PER_PATH) return this.#skip('query-variants');
      this.#queryVariants.set(url.pathname, variants + 1);
    }

    this.#seen.add(normalized.url);
    this.#accepted += 1;
    this.#pending.push({ url: normalized.url, depth, source });
    return true;
  }

  /** @returns {QueuedRoute | undefined} */
  next() {
    return this.#pending.shift();
  }

  /** Counts of skipped URLs by reason, for the run summary. */
  get skipped() {
    return Object.fromEntries(this.#skipped);
  }

  get acceptedCount() {
    return this.#accepted;
  }

  /**
   * @param {SkipReason} reason
   * @returns {false}
   */
  #skip(reason) {
    this.#skipped.set(reason, (this.#skipped.get(reason) ?? 0) + 1);
    return false;
  }
}

/**
 * Reads `/sitemap.xml` (and up to five child sitemaps of a sitemap index) on the target origin.
 * Failures are not fatal: a site without a sitemap simply contributes no routes.
 *
 * @param {object} options
 * @param {URL} options.targetUrl
 * @param {Record<string, string>} options.headers Sent only because the request is same-origin.
 * @param {number} options.timeoutMs
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ urls: string[], error: string | null }>}
 */
export async function readSitemap({ targetUrl, headers, timeoutMs, fetchImpl = fetch }) {
  const rootUrl = new URL('/sitemap.xml', targetUrl.origin);
  try {
    const rootXml = await fetchXml(rootUrl, headers, timeoutMs, fetchImpl);
    if (rootXml === null) return { urls: [], error: null };
    if (!/<sitemapindex[\s>]/i.test(rootXml)) return { urls: extractLocs(rootXml), error: null };

    /** @type {string[]} */
    const urls = [];
    const children = extractLocs(rootXml)
      .filter((loc) => safeOrigin(loc) === targetUrl.origin)
      .slice(0, MAX_CHILD_SITEMAPS);
    for (const child of children) {
      const xml = await fetchXml(new URL(child), headers, timeoutMs, fetchImpl);
      if (xml) urls.push(...extractLocs(xml));
    }
    return { urls, error: null };
  } catch (error) {
    return { urls: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {URL} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string | null>} Null when the sitemap does not exist.
 */
async function fetchXml(url, headers, timeoutMs, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { ...headers, accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`sitemap returned HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_SITEMAP_BYTES) throw new Error('sitemap is larger than 5 MB');
  const text = await response.text();
  if (text.length > MAX_SITEMAP_BYTES) throw new Error('sitemap is larger than 5 MB');
  return text;
}

/**
 * @param {string} xml
 * @returns {string[]}
 */
export function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) =>
    match[1]
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'"),
  );
}

/**
 * @param {string} url
 * @returns {string | null}
 */
function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
