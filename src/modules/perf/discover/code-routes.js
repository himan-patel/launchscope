import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse } from '@babel/parser';

/**
 * Reads routes from code-based routers by parsing source files (JavaScript, TypeScript, JSX)
 * into syntax trees and following the code, across files:
 *
 * - Angular: route arrays passed to `provideRouter` / `RouterModule.forRoot`, nested `children`,
 *   lazy `loadChildren` (standalone route arrays and NgModules with `RouterModule.forChild`).
 * - React Router: `createBrowserRouter` / `useRoutes` route objects, `<Routes>` / `<Route>`
 *   trees, nested children, index routes, and descendant `<Routes>` under `path="x/*"`.
 * - Express: `app.get`, `router.get`, `app.route(path).get`, and routers mounted with
 *   `app.use(prefix, router)`, including routers imported from other files.
 *
 * Only routes reachable from a router root are reported, with their full prefix. Anything that
 * cannot be resolved statically (a computed path, a lazy import through a path alias, a router
 * built by a function call) is reported as skipped with the reason, never guessed.
 */

/** @typedef {any} Node Babel AST node. */
/** @typedef {{ kind: 'page' | 'api', path: string, file: string, framework: string }} CodeRoute */
/** @typedef {{ route: string, reason: string, file: string }} Skipped */
/** @typedef {{ node: Node, module: Module }} Ref A node and the module it lives in. */

/**
 * @typedef {object} Module
 * @property {string} file Repository-relative path with forward slashes.
 * @property {Node} program
 * @property {Map<string, Node>} locals Top-level `const`/`function`/`class` values by name.
 * @property {Map<string, { source: string, imported: string }>} imports Imported bindings.
 * @property {Map<string, ExportEntry>} exports
 * @property {string[]} starExports Sources of `export * from`.
 */

/** @typedef {{ local: string } | { node: Node } | { source: string, imported: string }} ExportEntry */

const MAX_SCAN_BYTES = 512 * 1024;
const MAX_DEPTH = 12;
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const AST_SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'extra',
  'range',
  'comments',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);

/**
 * @param {object} options
 * @param {string} options.root Repository directory.
 * @param {string[]} options.files Repository-relative source files (forward slashes).
 * @returns {Promise<{ routes: CodeRoute[], skipped: Skipped[] }>}
 */
export async function discoverCodeRoutes({ root, files }) {
  const graph = new ModuleGraph(root, files);
  /** @type {CodeRoute[]} */
  const routes = [];
  /** @type {Skipped[]} */
  const skipped = [];
  /** @type {Module[]} */
  const angular = [];
  /** @type {Module[]} */
  const react = [];
  /** @type {Module[]} */
  const express = [];
  for (const file of files) {
    const text = await graph.text(file);
    if (!text) continue;
    const wants = {
      angular: text.includes('@angular/router'),
      react: /['"]react-router(?:-dom)?['"]/.test(text),
      express: /['"]express['"]/.test(text),
    };
    if (!wants.angular && !wants.react && !wants.express) continue;
    const module = await graph.load(file);
    if (!module) {
      skipped.push({ route: '', reason: 'could not be parsed', file });
      continue;
    }
    if (wants.angular) angular.push(module);
    if (wants.react) react.push(module);
    if (wants.express) express.push(module);
  }
  const context = { graph, routes, skipped };
  await angularRoutes(angular, context);
  await reactRouterRoutes(react, context);
  await expressRoutes(express, context);
  return { routes, skipped };
}

/** @typedef {{ graph: ModuleGraph, routes: CodeRoute[], skipped: Skipped[] }} Context */

// ---------------------------------------------------------------------------------------------
// Angular

/**
 * @param {Module[]} modules
 * @param {Context} context
 */
async function angularRoutes(modules, context) {
  const { graph } = context;
  /** @type {Ref[]} */
  const roots = [];
  /** @type {Ref[]} */
  const forChild = [];
  /** @type {Ref[]} */
  const exported = [];
  for (const module of modules) {
    walk(module.program, (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = calleeName(node.callee);
      const argument = node.arguments[0];
      if (!argument) return;
      if (callee === 'provideRouter' || callee === 'RouterModule.forRoot') {
        roots.push({ node: argument, module });
      } else if (callee === 'RouterModule.forChild') {
        forChild.push({ node: argument, module });
      }
    });
    for (const [name, entry] of module.exports) {
      if (!('local' in entry)) continue;
      const declarator = module.locals.get(entry.local);
      if (declarator?.type !== 'VariableDeclarator') continue;
      const annotation = declarator.id.typeAnnotation?.typeAnnotation;
      const typeName =
        annotation?.type === 'TSTypeReference'
          ? annotation.typeName.name
          : annotation?.type === 'TSArrayType'
            ? annotation.elementType.typeName?.name
            : null;
      if (typeName === 'Routes' || typeName === 'Route' || /routes$/i.test(name)) {
        exported.push({ node: declarator.init, module });
      }
    }
  }
  if (roots.length + forChild.length + exported.length === 0) return;

  // Which route arrays are reached from another one (lazily or as children)?
  /** @type {Set<Node>} */
  const reached = new Set();
  for (const candidate of [...roots, ...forChild, ...exported]) {
    await angularTree(candidate, '', context, { emit: false, reached, visiting: new Set() });
  }
  const resolvedRoots = [];
  for (const root of roots) {
    const array = await graph.resolve(root);
    if (array) resolvedRoots.push(array);
  }
  /** @type {Ref[]} */
  const effectiveRoots = resolvedRoots.length > 0 ? resolvedRoots : [];
  if (effectiveRoots.length === 0) {
    // No router root found (for example, provideRouter imports routes through a path alias):
    // exported route arrays that nothing else loads are the app's top-level routes.
    for (const candidate of exported) {
      const array = await graph.resolve(candidate);
      if (array && !reached.has(array.node)) effectiveRoots.push(array);
    }
  }
  /** @type {Set<Node>} */
  const emitted = new Set();
  for (const root of effectiveRoots) {
    if (emitted.has(root.node)) continue;
    emitted.add(root.node);
    await angularTree(root, '', context, { emit: true, reached: emitted, visiting: new Set() });
  }
  for (const candidate of forChild) {
    const array = await graph.resolve(candidate);
    if (array && !emitted.has(array.node)) {
      context.skipped.push({
        route: '',
        reason:
          'RouterModule.forChild routes in this file are not loaded by any resolved route (loadChildren)',
        file: candidate.module.file,
      });
    }
  }
}

/**
 * @param {Ref} ref A route array (or an expression resolving to one).
 * @param {string} prefix
 * @param {Context} context
 * @param {{ emit: boolean, reached: Set<Node>, visiting: Set<Node> }} state
 */
async function angularTree(ref, prefix, context, state) {
  const array = await context.graph.resolve(ref);
  if (array?.node.type !== 'ArrayExpression' || state.visiting.has(array.node)) return;
  state.visiting.add(array.node);
  for (const element of await context.graph.elements(array)) {
    const route = await context.graph.resolve(element);
    if (route?.node.type !== 'ObjectExpression') continue;
    const file = route.module.file;
    const props = objectProps(route.node);
    if (props.has('matcher')) {
      if (state.emit)
        context.skipped.push({ route: prefix || '/', reason: 'custom route matcher', file });
      continue;
    }
    const path = props.has('path') ? stringValue(props.get('path')) : '';
    if (path === null) {
      if (state.emit)
        context.skipped.push({
          route: prefix || '/',
          reason: 'path is not a string literal',
          file,
        });
      continue;
    }
    if (path.includes('**')) continue;
    const full = joinSegments(prefix, path);
    if (props.has('redirectTo')) continue;
    if (state.emit && (props.has('component') || props.has('loadComponent'))) {
      context.routes.push({ kind: 'page', path: full, file, framework: 'angular' });
    }
    if (props.has('children')) {
      const children = await context.graph.resolve({
        node: props.get('children'),
        module: route.module,
      });
      if (children) {
        state.reached.add(children.node);
        await angularTree(children, full, context, state);
      }
    }
    if (props.has('loadChildren')) {
      const lazy = await angularLazyRoutes(props.get('loadChildren'), route.module, context.graph);
      if (lazy) {
        state.reached.add(lazy.node);
        await angularTree(lazy, full, context, state);
      } else if (state.emit) {
        context.skipped.push({
          route: `${full || '/'} (lazy children)`,
          reason: 'loadChildren target could not be resolved',
          file,
        });
      }
    }
  }
  state.visiting.delete(array.node);
}

/**
 * Follows `loadChildren: () => import('./x').then((m) => m.ROUTES)` (or a default export, or an
 * NgModule that calls RouterModule.forChild) to the route array it loads.
 *
 * @param {Node} node
 * @param {Module} module
 * @param {ModuleGraph} graph
 * @returns {Promise<Ref | null>}
 */
async function angularLazyRoutes(node, module, graph) {
  const lazy = dynamicImport(node);
  if (!lazy) return null;
  const target = await graph.importModule(module, lazy.source);
  if (!target) return null;
  const exported = await graph.exportValue(target, lazy.member ?? 'default');
  if (!exported) return null;
  if (exported.node.type === 'ArrayExpression') return exported;
  if (exported.node.type === 'ClassDeclaration' || exported.node.type === 'ClassExpression') {
    return angularModuleRoutes(exported.module, graph, new Set());
  }
  return null;
}

/**
 * The routes an NgModule registers: RouterModule.forChild in its file, or in a routing module it
 * imports from a relative path.
 *
 * @param {Module} module
 * @param {ModuleGraph} graph
 * @param {Set<string>} seen
 * @returns {Promise<Ref | null>}
 */
async function angularModuleRoutes(module, graph, seen) {
  if (seen.has(module.file)) return null;
  seen.add(module.file);
  /** @type {Node | null} */
  let argument = null;
  walk(module.program, (node) => {
    if (
      !argument &&
      node.type === 'CallExpression' &&
      calleeName(node.callee) === 'RouterModule.forChild'
    ) {
      argument = node.arguments[0] ?? null;
    }
  });
  if (argument) return graph.resolve({ node: argument, module });
  for (const { source } of module.imports.values()) {
    if (!source.startsWith('.')) continue;
    const imported = await graph.importModule(module, source);
    if (!imported) continue;
    const routes = await angularModuleRoutes(imported, graph, seen);
    if (routes) return routes;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// React Router

const ROUTER_FACTORIES = new Set([
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
  'createStaticRouter',
  'useRoutes',
]);

/**
 * @param {Module[]} modules
 * @param {Context} context
 */
async function reactRouterRoutes(modules, context) {
  /** @type {Ref[]} */
  const candidates = [];
  for (const module of modules) {
    walk(module.program, (node) => {
      if (node.type === 'CallExpression' && ROUTER_FACTORIES.has(calleeName(node.callee))) {
        if (node.arguments[0]) candidates.push({ node: node.arguments[0], module });
      } else if (node.type === 'JSXElement' && jsxName(node) === 'Routes') {
        candidates.push({ node, module });
      } else if (
        node.type === 'CallExpression' &&
        calleeName(node.callee) === 'createRoutesFromElements' &&
        node.arguments[0]
      ) {
        candidates.push({ node: node.arguments[0], module });
      }
    });
  }
  if (candidates.length === 0) return;
  /** @type {Set<Node>} */
  const reached = new Set();
  for (const candidate of candidates) {
    await reactTree(candidate, '', context, { emit: false, reached, visiting: new Set() });
  }
  /** @type {Set<Node>} */
  const emitted = new Set();
  for (const candidate of candidates) {
    const resolved = await context.graph.resolve(candidate);
    if (!resolved || reached.has(resolved.node) || emitted.has(resolved.node)) continue;
    // `createRoutesFromElements(<Route>)` inside `createBrowserRouter(...)` is the same tree.
    if (resolved.node.type === 'CallExpression') {
      const inner = await context.graph.resolve({
        node: resolved.node.arguments[0],
        module: resolved.module,
      });
      if (inner) emitted.add(inner.node);
    }
    emitted.add(resolved.node);
    await reactTree(resolved, '', context, { emit: true, reached: new Set(), visiting: new Set() });
  }
}

/**
 * @param {Ref} ref Route objects array, `<Routes>`, `<Route>`, or `createRoutesFromElements(...)`.
 * @param {string} prefix
 * @param {Context} context
 * @param {{ emit: boolean, reached: Set<Node>, visiting: Set<Node> }} state
 */
async function reactTree(ref, prefix, context, state) {
  const resolved = await context.graph.resolve(ref);
  if (!resolved || state.visiting.has(resolved.node)) return;
  state.visiting.add(resolved.node);
  const { node, module } = resolved;
  if (node.type === 'CallExpression' && calleeName(node.callee) === 'createRoutesFromElements') {
    await reactTree({ node: node.arguments[0], module }, prefix, context, state);
  } else if (node.type === 'ArrayExpression') {
    for (const element of await context.graph.elements(resolved)) {
      await reactRoute(element, prefix, context, state);
    }
  } else if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
    if (node.type === 'JSXElement' && jsxName(node) === 'Route') {
      await reactRoute(resolved, prefix, context, state);
    } else {
      for (const child of jsxChildren(node)) {
        await reactTree({ node: child, module }, prefix, context, state);
      }
    }
  }
  state.visiting.delete(resolved.node);
}

/**
 * One route, as an object (`{ path, element, children }`) or a `<Route>` element.
 *
 * @param {Ref} ref
 * @param {string} prefix
 * @param {Context} context
 * @param {{ emit: boolean, reached: Set<Node>, visiting: Set<Node> }} state
 */
async function reactRoute(ref, prefix, context, state) {
  const route = await context.graph.resolve(ref);
  if (!route) return;
  const { node, module } = route;
  const file = module.file;
  /** @type {Map<string, Node | true>} */
  const props =
    node.type === 'ObjectExpression'
      ? objectProps(node)
      : node.type === 'JSXElement' && jsxName(node) === 'Route'
        ? jsxProps(node)
        : new Map();
  if (props.size === 0 && node.type !== 'JSXElement') return;
  const isIndex = props.has('index') && props.get('index') !== null;
  const rawPath = props.has('path') ? stringValue(props.get('path')) : null;
  if (props.has('path') && rawPath === null) {
    if (state.emit)
      context.skipped.push({ route: prefix || '/', reason: 'path is not a string literal', file });
    return;
  }
  if (rawPath === '*') return;
  const renders = props.has('element') || props.has('Component') || props.has('lazy');
  const splat = rawPath?.endsWith('/*') ?? false;
  const path = splat ? /** @type {string} */ (rawPath).slice(0, -2) : rawPath;
  const full =
    path === null ? prefix : path.startsWith('/') ? normalize(path) : joinSegments(prefix, path);
  if (state.emit && ((path !== null && renders) || isIndex)) {
    context.routes.push({ kind: 'page', path: full, file, framework: 'react-router' });
  }
  if (splat) {
    const descendant = await descendantRoutes(props.get('element'), module, context.graph);
    if (descendant) {
      state.reached.add(descendant.node);
      await reactTree(descendant, full, context, state);
    } else if (state.emit) {
      context.skipped.push({
        route: `${full || '/'}/*`,
        reason: 'descendant <Routes> of the element could not be resolved',
        file,
      });
    }
  }
  if (node.type === 'ObjectExpression' && props.has('children')) {
    await reactTree({ node: props.get('children'), module }, full, context, state);
  } else if (node.type === 'JSXElement') {
    for (const child of jsxChildren(node)) {
      await reactTree({ node: child, module }, full, context, state);
    }
  }
}

/**
 * `element={<Dashboard />}` on a `path="x/*"` route: the `<Routes>` that Dashboard renders.
 *
 * @param {Node | true | undefined} element
 * @param {Module} module
 * @param {ModuleGraph} graph
 * @returns {Promise<Ref | null>}
 */
async function descendantRoutes(element, module, graph) {
  const value = element && element !== true ? unwrapJsxValue(element) : null;
  if (value?.type !== 'JSXElement') return null;
  const name = value.openingElement.name;
  if (name.type !== 'JSXIdentifier') return null;
  const component = await graph.resolve({ node: { type: 'Identifier', name: name.name }, module });
  if (!component) return null;
  /** @type {Node | null} */
  let routes = null;
  walk(component.node, (node) => {
    if (!routes && node.type === 'JSXElement' && jsxName(node) === 'Routes') routes = node;
  });
  return routes ? { node: routes, module: component.module } : null;
}

// ---------------------------------------------------------------------------------------------
// Express

/**
 * @typedef {object} RouterInfo
 * @property {string} id
 * @property {boolean} isApp
 * @property {Module} module
 * @property {Array<{ path: string, file: string }>} gets
 * @property {Array<{ prefix: string, target: Ref, file: string }>} mounts
 */

/**
 * @param {Module[]} modules
 * @param {Context} context
 */
async function expressRoutes(modules, context) {
  const { graph } = context;
  /** @type {Map<string, RouterInfo>} */
  const routers = new Map();
  /** @type {Map<Node, string>} creation call node → router id */
  const created = new Map();

  for (const module of modules) {
    const expressNames = new Set(['express']);
    const routerNames = new Set();
    for (const [local, { source, imported }] of module.imports) {
      if (source !== 'express') continue;
      if (imported === 'default' || imported === '*') expressNames.add(local);
      if (imported === 'Router') routerNames.add(local);
    }
    walk(module.program, (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = calleeName(node.callee);
      const isApp = node.callee.type === 'Identifier' && expressNames.has(callee);
      const isRouter =
        routerNames.has(callee) ||
        (node.callee.type === 'MemberExpression' &&
          expressNames.has(calleeName(node.callee.object)) &&
          propertyName(node.callee) === 'Router');
      if (!isApp && !isRouter) return;
      const id = `${module.file}:${node.start}`;
      created.set(node, id);
      routers.set(id, { id, isApp, module, gets: [], mounts: [] });
    });
  }
  if (routers.size === 0) return;

  /**
   * The router a receiver expression refers to (`app`, `router`, or an imported router).
   *
   * @param {Ref} ref
   */
  const routerOf = async (ref) => {
    const resolved = await graph.resolve(ref);
    if (!resolved) return null;
    const id = created.get(resolved.node);
    return id ? /** @type {RouterInfo} */ (routers.get(id)) : null;
  };

  for (const module of modules) {
    /** @type {Node[]} */
    const calls = [];
    walk(module.program, (node) => {
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression')
        calls.push(node);
    });
    for (const call of calls) {
      const method = propertyName(call.callee);
      if (method !== 'get' && method !== 'use') continue;
      // `app.route('/x').get(handler)` (possibly after other chained methods).
      let receiver = call.callee.object;
      let routePath = null;
      while (receiver.type === 'CallExpression' && receiver.callee.type === 'MemberExpression') {
        if (propertyName(receiver.callee) === 'route') {
          routePath = receiver.arguments[0] ?? null;
          receiver = receiver.callee.object;
          break;
        }
        receiver = receiver.callee.object;
      }
      const router = await routerOf({ node: receiver, module });
      if (!router) continue;
      const file = module.file;
      if (method === 'get') {
        // `app.get('setting')` reads a setting; a route has a handler.
        const pathNode = routePath ?? (call.arguments.length >= 2 ? call.arguments[0] : null);
        if (!pathNode) continue;
        const path = stringValue(pathNode);
        if (path === null) {
          context.skipped.push({
            route: '',
            reason: 'GET route path is not a string literal',
            file,
          });
        } else if (path.includes('*') || path.includes('{')) {
          continue;
        } else {
          router.gets.push({ path, file });
        }
      } else if (!routePath) {
        const [first, ...rest] = call.arguments;
        const prefixValue = first ? stringValue(first) : null;
        const handlers = prefixValue === null ? call.arguments : rest;
        for (const handler of handlers) {
          router.mounts.push({
            prefix: prefixValue ?? '/',
            target: { node: handler, module },
            file,
          });
        }
      }
    }
  }

  /** @type {Set<string>} */
  const mounted = new Set();
  /**
   * @param {RouterInfo} router
   * @param {string} prefix
   * @param {Set<string>} visiting
   */
  const emit = async (router, prefix, visiting) => {
    if (visiting.has(router.id)) return;
    visiting.add(router.id);
    for (const { path, file } of router.gets) {
      context.routes.push({ kind: 'api', path: joinUrl(prefix, path), file, framework: 'express' });
    }
    for (const mount of router.mounts) {
      const target = await routerOf(mount.target);
      if (target) {
        mounted.add(target.id);
        await emit(target, joinUrl(prefix, mount.prefix), visiting);
      } else if (await looksLikeUnresolvedRouter(mount.target, graph)) {
        context.skipped.push({
          route: `${joinUrl(prefix, mount.prefix)}/…`,
          reason: 'mounted router could not be resolved',
          file: mount.file,
        });
      }
    }
    visiting.delete(router.id);
  };
  for (const router of routers.values()) {
    if (router.isApp) await emit(router, '', new Set());
  }
  for (const router of routers.values()) {
    if (router.isApp || mounted.has(router.id)) continue;
    for (const { path, file } of router.gets) {
      context.skipped.push({
        route: path,
        reason: 'router is not mounted on an Express app that could be resolved',
        file,
      });
    }
  }
}

/**
 * Middleware functions are expected in `app.use`; only a mounted value that is not a function
 * (an identifier or `require()` that did not resolve to a router) is worth reporting.
 *
 * @param {Ref} ref
 * @param {ModuleGraph} graph
 */
async function looksLikeUnresolvedRouter(ref, graph) {
  const { node } = ref;
  if (node.type === 'CallExpression' && calleeName(node.callee) === 'require') return true;
  if (node.type !== 'Identifier' && node.type !== 'MemberExpression') return false;
  const resolved = await graph.resolve(ref);
  if (!resolved) return /router|routes|api/i.test(calleeName(node));
  const type = resolved.node.type;
  return !(
    type.includes('Function') ||
    type === 'ClassDeclaration' ||
    type === 'CallExpression' ||
    type === 'NewExpression'
  );
}

// ---------------------------------------------------------------------------------------------
// Module graph and value resolution

class ModuleGraph {
  /** @type {Map<string, Promise<Module | null>>} */
  #modules = new Map();
  /** @type {Map<string, Promise<string | null>>} */
  #texts = new Map();
  #root;
  #files;

  /**
   * @param {string} root
   * @param {string[]} files
   */
  constructor(root, files) {
    this.#root = root;
    this.#files = new Set(files);
  }

  /** @param {string} file */
  text(file) {
    let text = this.#texts.get(file);
    if (!text) {
      text = readSmall(join(this.#root, ...file.split('/')));
      this.#texts.set(file, text);
    }
    return text;
  }

  /** @param {string} file @returns {Promise<Module | null>} */
  load(file) {
    let module = this.#modules.get(file);
    if (!module) {
      module = this.text(file).then((text) => (text === null ? null : parseModule(file, text)));
      this.#modules.set(file, module);
    }
    return module;
  }

  /**
   * @param {Module} from
   * @param {string} source Import specifier.
   */
  async importModule(from, source) {
    const file = this.#resolvePath(from.file, source);
    return file ? this.load(file) : null;
  }

  /**
   * @param {string} from
   * @param {string} source
   * @returns {string | null} Only relative specifiers resolve; packages and aliases do not.
   */
  #resolvePath(from, source) {
    if (!source.startsWith('.')) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), source));
    const stems = [base];
    // TypeScript ESM imports name the emitted file: './routes.js' is './routes.ts'.
    const emitted = /\.(?:m|c)?js$/.exec(base);
    if (emitted) stems.push(base.slice(0, -emitted[0].length));
    for (const stem of stems) {
      if (stem === base && this.#files.has(stem)) return stem;
      for (const extension of RESOLVE_EXTENSIONS) {
        if (this.#files.has(stem + extension)) return stem + extension;
      }
      for (const extension of RESOLVE_EXTENSIONS) {
        if (this.#files.has(`${stem}/index${extension}`)) return `${stem}/index${extension}`;
      }
    }
    return null;
  }

  /**
   * The value an exported name refers to.
   *
   * @param {Module} module
   * @param {string} name
   * @param {number} [depth]
   * @returns {Promise<Ref | null>}
   */
  async exportValue(module, name, depth = 0) {
    if (depth > MAX_DEPTH) return null;
    const entry = module.exports.get(name);
    if (entry) {
      if ('node' in entry) return this.resolve({ node: entry.node, module }, depth + 1);
      if ('local' in entry) {
        return this.resolve({ node: { type: 'Identifier', name: entry.local }, module }, depth + 1);
      }
      const target = await this.importModule(module, entry.source);
      return target ? this.exportValue(target, entry.imported, depth + 1) : null;
    }
    for (const source of module.starExports) {
      const target = await this.importModule(module, source);
      const value = target ? await this.exportValue(target, name, depth + 1) : null;
      if (value) return value;
    }
    return null;
  }

  /**
   * Follows identifiers, imports, `require()`, and TypeScript wrappers to the expression or
   * declaration they stand for.
   *
   * @param {Ref} ref
   * @param {number} [depth]
   * @returns {Promise<Ref | null>}
   */
  async resolve(ref, depth = 0) {
    if (!ref.node || depth > MAX_DEPTH) return null;
    const node = unwrap(ref.node);
    const { module } = ref;
    if (node.type === 'Identifier') {
      const local = module.locals.get(node.name);
      if (local) {
        if (local.type === 'VariableDeclarator') {
          return local.init ? this.resolve({ node: local.init, module }, depth + 1) : null;
        }
        return { node: local, module };
      }
      const imported = module.imports.get(node.name);
      if (!imported) return null;
      const target = await this.importModule(module, imported.source);
      if (!target) return null;
      return this.exportValue(target, imported.imported, depth + 1);
    }
    if (node.type === 'CallExpression' && calleeName(node.callee) === 'require') {
      const source = stringValue(node.arguments[0]);
      const target = source ? await this.importModule(module, source) : null;
      return target ? this.exportValue(target, 'default', depth + 1) : null;
    }
    if (node.type === 'MemberExpression' && !node.computed) {
      // `routes.admin` or `require('./x').router`.
      const object = await this.resolve({ node: node.object, module }, depth + 1);
      const name = propertyName(node);
      if (object?.node.type === 'ObjectExpression') {
        const value = objectProps(object.node).get(name);
        return value ? this.resolve({ node: value, module: object.module }, depth + 1) : null;
      }
      if (node.object.type === 'CallExpression' && calleeName(node.object.callee) === 'require') {
        const source = stringValue(node.object.arguments[0]);
        const target = source ? await this.importModule(module, source) : null;
        return target ? this.exportValue(target, name, depth + 1) : null;
      }
      return null;
    }
    return { node, module };
  }

  /**
   * Array elements with spreads (`...adminRoutes`) expanded.
   *
   * @param {Ref} array
   * @returns {Promise<Ref[]>}
   */
  async elements(array) {
    /** @type {Ref[]} */
    const result = [];
    for (const element of array.node.elements) {
      if (!element) continue;
      if (element.type === 'SpreadElement') {
        const spread = await this.resolve({ node: element.argument, module: array.module });
        if (spread?.node.type === 'ArrayExpression') result.push(...(await this.elements(spread)));
      } else {
        result.push({ node: element, module: array.module });
      }
    }
    return result;
  }
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {Module | null}
 */
function parseModule(file, text) {
  /** @type {Array<string | [string, object]>} */
  const plugins = ['decorators'];
  if (/\.[cm]?tsx?$/.test(file)) plugins.push('typescript');
  if (!/\.[cm]?ts$/.test(file)) plugins.push('jsx');
  /** @type {Node} */
  let program;
  try {
    program = parse(text, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: /** @type {any} */ (plugins),
    }).program;
  } catch {
    return null;
  }
  /** @type {Module} */
  const module = {
    file,
    program,
    locals: new Map(),
    imports: new Map(),
    exports: new Map(),
    starExports: [],
  };
  /** @param {Node} declaration */
  const declare = (declaration) => {
    if (!declaration) return [];
    if (declaration.type === 'VariableDeclaration') {
      const names = [];
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === 'Identifier') {
          module.locals.set(declarator.id.name, declarator);
          names.push(declarator.id.name);
          recordRequire(declarator.init, declarator.id.name);
        } else if (declarator.id.type === 'ObjectPattern') {
          // `const { Router } = require('express')`.
          for (const property of declarator.id.properties) {
            if (property.type !== 'ObjectProperty' || property.value.type !== 'Identifier')
              continue;
            const source = requireSource(declarator.init);
            if (source) {
              module.imports.set(property.value.name, {
                source,
                imported: propertyKey(property) ?? property.value.name,
              });
            }
          }
        }
      }
      return names;
    }
    if (declaration.id?.type === 'Identifier') {
      module.locals.set(declaration.id.name, declaration);
      return [declaration.id.name];
    }
    return [];
  };
  /**
   * `const x = require('./x')` is an import of the module's default export.
   *
   * @param {Node} init
   * @param {string} name
   */
  const recordRequire = (init, name) => {
    const source = requireSource(init);
    if (source) {
      module.locals.delete(name);
      module.imports.set(name, { source, imported: 'default' });
    }
  };

  for (const statement of program.body) {
    switch (statement.type) {
      case 'ImportDeclaration':
        for (const specifier of statement.specifiers) {
          module.imports.set(specifier.local.name, {
            source: statement.source.value,
            imported:
              specifier.type === 'ImportSpecifier'
                ? (specifier.imported.name ?? specifier.imported.value)
                : specifier.type === 'ImportDefaultSpecifier'
                  ? 'default'
                  : '*',
          });
        }
        break;
      case 'ExportNamedDeclaration':
        for (const name of declare(statement.declaration))
          module.exports.set(name, { local: name });
        for (const specifier of statement.specifiers ?? []) {
          const exported = specifier.exported.name ?? specifier.exported.value;
          const local = specifier.local?.name ?? specifier.local?.value;
          module.exports.set(
            exported,
            statement.source
              ? { source: statement.source.value, imported: local ?? 'default' }
              : { local },
          );
        }
        break;
      case 'ExportDefaultDeclaration': {
        const [name] = declare(statement.declaration);
        module.exports.set('default', name ? { local: name } : { node: statement.declaration });
        break;
      }
      case 'ExportAllDeclaration':
        if (!statement.exported) module.starExports.push(statement.source.value);
        break;
      case 'VariableDeclaration':
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        declare(statement);
        break;
      case 'ExpressionStatement': {
        // CommonJS: `module.exports = x`, `module.exports.y = x`, `exports.y = x`.
        const expression = statement.expression;
        if (expression.type !== 'AssignmentExpression') break;
        const target = memberPath(expression.left);
        if (target === 'module.exports') module.exports.set('default', { node: expression.right });
        else if (/^(?:module\.)?exports\.\w+$/.test(target ?? '')) {
          module.exports.set(/** @type {string} */ (target).split('.').pop() ?? '', {
            node: expression.right,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return module;
}

// ---------------------------------------------------------------------------------------------
// AST helpers

/**
 * Depth-first walk over every node.
 *
 * @param {Node} root
 * @param {(node: Node) => void} visit
 */
function walk(root, visit) {
  /** @type {Node[]} */
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    visit(node);
    for (const key of Object.keys(node)) {
      if (AST_SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          if (value[index] && typeof value[index].type === 'string') stack.push(value[index]);
        }
      } else if (value && typeof value.type === 'string') {
        stack.push(value);
      }
    }
  }
}

/** @param {Node} node */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression')
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * `a.b.c` for identifiers and non-computed members; `''` otherwise.
 *
 * @param {Node} node
 * @returns {string}
 */
function calleeName(node) {
  return memberPath(node) ?? '';
}

/**
 * @param {Node} node
 * @returns {string | null}
 */
function memberPath(node) {
  const current = unwrap(node);
  if (current?.type === 'Identifier') return current.name;
  if (current?.type === 'MemberExpression' && !current.computed) {
    const object = memberPath(current.object);
    return object === null ? null : `${object}.${propertyName(current)}`;
  }
  return null;
}

/** @param {Node} member */
function propertyName(member) {
  return member.property.type === 'Identifier' ? member.property.name : '';
}

/**
 * @param {Node} property
 * @returns {string | null}
 */
function propertyKey(property) {
  if (property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'StringLiteral') return property.key.value;
  return null;
}

/**
 * Plain properties of an object literal (`{ path: 'x' }`); shorthand values are identifiers.
 *
 * @param {Node} object
 * @returns {Map<string, Node>}
 */
function objectProps(object) {
  /** @type {Map<string, Node>} */
  const props = new Map();
  for (const property of object.properties) {
    if (property.type === 'ObjectMethod') {
      const key = propertyKey(property);
      if (key) props.set(key, property);
      continue;
    }
    if (property.type !== 'ObjectProperty') continue;
    const key = propertyKey(property);
    if (key) props.set(key, property.value);
  }
  return props;
}

/**
 * The string a literal or expression-free template stands for.
 *
 * @param {Node | true | undefined} input
 * @returns {string | null}
 */
function stringValue(input) {
  if (!input || input === true) return null;
  const node = unwrapJsxValue(unwrap(input));
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((/** @type {Node} */ quasi) => quasi.value.cooked).join('');
  }
  return null;
}

/** @param {Node} node */
function unwrapJsxValue(node) {
  return node?.type === 'JSXExpressionContainer' ? unwrap(node.expression) : node;
}

/**
 * `import('./x')`, `import('./x').then((m) => m.Name)`, or Angular's legacy `'./x#Name'` string.
 *
 * @param {Node} input
 * @returns {{ source: string, member: string | null } | null}
 */
function dynamicImport(input) {
  let node = unwrap(input);
  const legacy = stringValue(node);
  if (legacy) {
    const [source, member] = legacy.split('#');
    return { source, member: member ?? null };
  }
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    node = node.body.type === 'BlockStatement' ? returnedExpression(node.body) : node.body;
    node = unwrap(node);
  }
  if (!node) return null;
  /** @type {string | null} */
  let member = null;
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    propertyName(node.callee) === 'then'
  ) {
    const callback = unwrap(node.arguments[0]);
    const body =
      callback?.type === 'ArrowFunctionExpression'
        ? unwrap(
            callback.body.type === 'BlockStatement'
              ? returnedExpression(callback.body)
              : callback.body,
          )
        : null;
    if (body?.type === 'MemberExpression' && !body.computed) member = propertyName(body);
    node = unwrap(node.callee.object);
  }
  if (node.type === 'ImportExpression') {
    const source = stringValue(node.source);
    return source ? { source, member } : null;
  }
  if (node.type === 'CallExpression' && node.callee.type === 'Import') {
    const source = stringValue(node.arguments[0]);
    return source ? { source, member } : null;
  }
  return null;
}

/** @param {Node} block */
function returnedExpression(block) {
  const statement = block.body.find(
    (/** @type {Node} */ entry) => entry.type === 'ReturnStatement',
  );
  return statement?.argument ?? null;
}

/** @param {Node} init */
function requireSource(init) {
  const node = unwrap(init);
  return node?.type === 'CallExpression' && calleeName(node.callee) === 'require'
    ? stringValue(node.arguments[0])
    : null;
}

/** @param {Node} element */
function jsxName(element) {
  const name = element.openingElement?.name;
  if (name?.type === 'JSXIdentifier') return name.name;
  if (name?.type === 'JSXMemberExpression') return name.property.name;
  return '';
}

/**
 * Attributes of a JSX element; a bare attribute (`index`) maps to `true`.
 *
 * @param {Node} element
 * @returns {Map<string, Node | true>}
 */
function jsxProps(element) {
  /** @type {Map<string, Node | true>} */
  const props = new Map();
  for (const attribute of element.openingElement.attributes) {
    if (attribute.type !== 'JSXAttribute' || attribute.name.type !== 'JSXIdentifier') continue;
    const value = attribute.value === null ? true : attribute.value;
    if (value !== true && attribute.name.name === 'index') {
      const inner = unwrapJsxValue(value);
      if (inner?.type === 'BooleanLiteral' && !inner.value) continue;
    }
    props.set(attribute.name.name, value);
  }
  return props;
}

/** @param {Node} element */
function jsxChildren(element) {
  return element.children.filter(
    (/** @type {Node} */ child) => child.type === 'JSXElement' || child.type === 'JSXFragment',
  );
}

/**
 * Router path segments joined Angular/React-Router style: relative children append.
 *
 * @param {string} prefix
 * @param {string} path
 */
function joinSegments(prefix, path) {
  return normalize(`${prefix}/${path}`);
}

/**
 * Express mount prefixes: `/api` + `/users` → `/api/users`; `/api` + `/` → `/api`.
 *
 * @param {string} prefix
 * @param {string} path
 */
function joinUrl(prefix, path) {
  return normalize(`${prefix}/${path}`);
}

/** @param {string} path */
function normalize(path) {
  return `/${path.split('/').filter(Boolean).join('/')}`;
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
