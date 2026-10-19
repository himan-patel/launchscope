import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { UsageError } from '../../../core/errors.js';
import { discoverCodeRoutes } from './code-routes.js';

/**
 * Finds routes in an app's source code so pages that nothing links to still get measured.
 *
 * File-based routers are read from their directory conventions. Code-based routers (Angular,
 * React Router, Express) are read by parsing the source and following it across files
 * (`code-routes.js`), so nested and lazily loaded routes keep their full prefix. Dynamic segments
 * are filled from `routeParams`; routes that still need a value, and router code that cannot be
 * resolved statically, are skipped and reported with the reason, never guessed.
 */

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.astro',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  '.turbo',
  '.cache',
  '.vercel',
  'tmp',
]);
const MAX_FILES = 20_000;
const MAX_SCAN_BYTES = 512 * 1024;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * @typedef {object} RepoDiscovery
 * @property {string[]} frameworks Routers detected, e.g. `next-app`, `angular`.
 * @property {string[]} pages Page paths, e.g. `/pricing`, `/blog/hello-world`.
 * @property {string[]} apis GET API paths to measure directly, e.g. `/api/health`.
 * @property {Array<{ route: string, reason: string, file: string }>} skipped
 */

/**
 * @param {object} options
 * @param {string} options.root Repository directory.
 * @param {Record<string, string>} options.routeParams Values for dynamic segments, by name.
 * @returns {Promise<RepoDiscovery>}
 */
export async function discoverRepoRoutes({ root, routeParams }) {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new UsageError(`--repo ${root} is not a readable directory.`, { cause: error });
  }
  const files = await listFiles(root);
  /** @type {Set<string>} */
  const frameworks = new Set();
  /** @type {Set<string>} */
  const pages = new Set();
  /** @type {Set<string>} */
  const apis = new Set();
  /** @type {Array<{ route: string, reason: string, file: string }>} */
  const skipped = [];

  /**
   * @param {'page' | 'api'} kind
   * @param {string[]} segments Route segments, possibly with `[param]` placeholders.
   * @param {string} file
   * @param {string} framework
   */
  const add = (kind, segments, file, framework) => {
    frameworks.add(framework);
    const filled = fillSegments(segments, routeParams);
    const route = `/${segments.join('/')}`;
    if ('missing' in filled) {
      skipped.push({ route, reason: `no value for "${filled.missing}" in routeParams`, file });
      return;
    }
    (kind === 'page' ? pages : apis).add(
      `/${filled.segments.join('/')}`.replace(/\/+$/, '') || '/',
    );
  };

  for (const file of files) {
    const parts = file.split('/');
    // Next.js App Router: app/**/page.* and app/**/route.* (optionally under src/).
    const appIndex = parts.findIndex(
      (part, index) => part === 'app' && (index === 0 || parts[index - 1] === 'src'),
    );
    if (appIndex !== -1 && /^(?:page|route)\.(?:[jt]sx?|mdx)$/.test(parts[parts.length - 1])) {
      const segments = nextAppSegments(parts.slice(appIndex + 1, -1));
      if (segments) {
        const isRoute = parts[parts.length - 1].startsWith('route.');
        if (isRoute) {
          if (await exportsGet(join(root, file))) add('api', segments, file, 'next-app');
        } else {
          add('page', segments, file, 'next-app');
        }
      }
      continue;
    }
    // Next.js Pages Router: pages/**/*.(js|jsx|ts|tsx) (optionally under src/).
    const pagesIndex = parts.findIndex(
      (part, index) => part === 'pages' && (index === 0 || parts[index - 1] === 'src'),
    );
    if (pagesIndex !== -1 && /\.[jt]sx?$/.test(file) && (await isNextProject(root))) {
      const relativeParts = parts.slice(pagesIndex + 1);
      const name = relativeParts[relativeParts.length - 1].replace(/\.[jt]sx?$/, '');
      if (name.startsWith('_')) continue;
      const segments = [...relativeParts.slice(0, -1), name].filter(
        (segment) => segment !== 'index',
      );
      if (relativeParts[0] === 'api') add('api', segments, file, 'next-pages');
      else add('page', segments, file, 'next-pages');
      continue;
    }
    // SvelteKit: src/routes/**/+page.svelte and +server.(js|ts) with a GET export.
    if (file.startsWith('src/routes/') && /\/\+(?:page\.svelte|server\.[jt]s)$/.test(`/${file}`)) {
      const segments = groupless(parts.slice(2, -1));
      if (file.endsWith('+page.svelte')) add('page', segments, file, 'sveltekit');
      else if (await exportsGet(join(root, file))) add('api', segments, file, 'sveltekit');
      continue;
    }
    // Nuxt: pages/**/*.vue.
    if (parts[0] === 'pages' && file.endsWith('.vue')) {
      const name = parts[parts.length - 1].replace(/\.vue$/, '');
      add(
        'page',
        [...parts.slice(1, -1), name].filter((segment) => segment !== 'index'),
        file,
        'nuxt',
      );
      continue;
    }
    // Astro: src/pages/**/*.(astro|md|mdx|html).
    if (file.startsWith('src/pages/') && /\.(?:astro|mdx?|html)$/.test(file)) {
      const name = parts[parts.length - 1].replace(/\.(?:astro|mdx?|html)$/, '');
      add(
        'page',
        [...parts.slice(2, -1), name].filter((segment) => segment !== 'index'),
        file,
        'astro',
      );
      continue;
    }
    // Remix / React Router v7 flat file routes: app/routes/*.(tsx|jsx|ts|js).
    if (
      parts[0] === 'app' &&
      parts[1] === 'routes' &&
      parts.length === 3 &&
      /\.[jt]sx?$/.test(file)
    ) {
      const segments = remixSegments(parts[2].replace(/\.[jt]sx?$/, ''));
      if (segments) add('page', segments, file, 'remix');
      continue;
    }
  }

  // Code-based routers: parsed and followed across files.
  const code = await discoverCodeRoutes({
    root,
    files: files.filter((candidate) => SOURCE_FILE.test(candidate)),
  });
  for (const route of code.routes) {
    add(route.kind, angularSegments(route.path), route.file, route.framework);
  }
  skipped.push(...code.skipped);

  return {
    frameworks: [...frameworks].sort(),
    pages: [...pages].sort(),
    apis: [...apis].filter((api) => !pages.has(api)).sort(),
    skipped,
  };
}

/**
 * Next.js App Router folder names to route segments: drops route groups `(x)` and parallel
 * slots `@x`; ignores private `_folders` and intercepting routes.
 *
 * @param {string[]} folders
 * @returns {string[] | null} Null for folders that are not routable.
 */
function nextAppSegments(folders) {
  if (folders.some((folder) => folder.startsWith('_') || /^\(\.+\)/.test(folder))) return null;
  return folders.filter((folder) => !/^\(.*\)$/.test(folder) && !folder.startsWith('@'));
}

/**
 * @param {string[]} folders
 * @returns {string[]}
 */
function groupless(folders) {
  return folders.filter((folder) => !/^\(.*\)$/.test(folder));
}

/**
 * Remix flat routes: `blog.$slug` → `/blog/[slug]`, `_index` → `/`, `_auth.login` → `/login`.
 *
 * @param {string} name
 * @returns {string[] | null}
 */
function remixSegments(name) {
  if (name === 'root') return null;
  return name
    .split('.')
    .filter((segment) => segment !== '_index' && !(segment.startsWith('_') && segment !== '_'))
    .map((segment) => segment.replace(/_$/, ''))
    .map((segment) => (segment.startsWith('$') ? `[${segment.slice(1) || 'splat'}]` : segment));
}

/**
 * Colon-style paths (`users/:id`) to segments with `[id]` placeholders.
 *
 * @param {string} path
 * @returns {string[]}
 */
function angularSegments(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(':') ? `[${segment.slice(1).replace(/\?$/, '')}]` : segment,
    );
}

/**
 * Replaces `[param]`, `[...param]`, and `[[...param]]` with values from `routeParams`. An
 * optional catch-all without a value is simply dropped.
 *
 * @param {string[]} segments
 * @param {Record<string, string>} routeParams
 * @returns {{ segments: string[] } | { missing: string }}
 */
export function fillSegments(segments, routeParams) {
  /** @type {string[]} */
  const filled = [];
  for (const segment of segments) {
    const match = /^\[\[?(?:\.\.\.)?([^\]]+)\]?\]$/.exec(segment);
    if (!match) {
      filled.push(segment);
      continue;
    }
    const name = match[1];
    const value = routeParams[name];
    if (value === undefined) {
      if (segment.startsWith('[[')) continue;
      return { missing: name };
    }
    filled.push(...value.split('/').map(encodeURIComponent));
  }
  return { segments: filled };
}

/**
 * @param {string} root
 * @returns {Promise<string[]>} Repository-relative paths with forward slashes.
 */
async function listFiles(root) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_FILES) {
    const directory = /** @type {string} */ (pending.pop());
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
          pending.push(join(directory, entry.name));
        }
      } else if (entry.isFile()) {
        files.push(relative(root, join(directory, entry.name)).split(sep).join('/'));
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files.sort();
}

/** @type {Map<string, boolean>} */
const nextProjectCache = new Map();

/**
 * The `pages/` directory only means Next.js routes when the project uses Next.js.
 *
 * @param {string} root
 * @returns {Promise<boolean>}
 */
async function isNextProject(root) {
  const cached = nextProjectCache.get(root);
  if (cached !== undefined) return cached;
  let result;
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    result = Boolean(manifest.dependencies?.next ?? manifest.devDependencies?.next);
  } catch {
    result = false;
  }
  nextProjectCache.set(root, result);
  return result;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exportsGet(path) {
  const text = await readSmall(path);
  return Boolean(
    text && /export\s+(?:async\s+)?(?:function|const)\s+GET\b|export\s*\{[^}]*\bGET\b/.test(text),
  );
}

/**
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function readSmall(path) {
  try {
    if ((await stat(path)).size > MAX_SCAN_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
