import { createHash } from 'node:crypto';

const MAX_SLUG_LENGTH = 60;

/**
 * Turns a route URL into a stable, filesystem-safe folder name:
 * `/` → `home`, `/app/settings` → `app-settings`, `/search?q=x` → `search-q-x`.
 * Long or colliding paths get a short hash suffix so folder names stay unique.
 *
 * @param {string} routeUrl
 * @returns {string}
 */
export function slugifyRoute(routeUrl) {
  const url = new URL(routeUrl);
  const raw = `${url.pathname}${url.search}`;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') return 'home';
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${slug.slice(0, MAX_SLUG_LENGTH - 9).replace(/-+$/, '')}-${hash}`;
}

/**
 * Assigns a unique slug to every route, in order.
 *
 * @param {string[]} routeUrls
 * @returns {Map<string, string>} Route URL → slug.
 */
export function assignRouteSlugs(routeUrls) {
  /** @type {Map<string, string>} */
  const slugs = new Map();
  const used = new Set();
  for (const routeUrl of routeUrls) {
    const base = slugifyRoute(routeUrl);
    let slug = base;
    for (let suffix = 2; used.has(slug); suffix += 1) slug = `${base}-${suffix}`;
    used.add(slug);
    slugs.set(routeUrl, slug);
  }
  return slugs;
}
