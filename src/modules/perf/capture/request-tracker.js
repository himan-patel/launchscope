/**
 * Observes, inside the page, which API request's response handler issued each new API request.
 *
 * `installRequestTracker` is serialized by Playwright and runs before the page's own scripts, so
 * it must be self-contained. It wraps:
 * - `fetch`: when a response arrives, and when its body is read (`json()`, `text()`, …), the code
 *   that continues from that point runs "caused by" that request;
 * - `XMLHttpRequest` (and libraries built on it, such as axios): the page's completion handlers
 *   (`onreadystatechange` at readyState 4, `onload`, `onloadend`, and their listeners) run
 *   "caused by" that request.
 *
 * Every fetch/XHR started while a cause is active records it. The cause stays active for the rest
 * of the current task, which covers the promise continuations (`await`) triggered by that
 * response. Every other task entry point clears it before the page's code runs: timers
 * (`setTimeout`, `setInterval`), `requestAnimationFrame`, `requestIdleCallback`, and every event
 * listener added with `addEventListener`. Browsers may run those tasks in any order, so the
 * clearing happens at their start rather than relying on task ordering; a MessageChannel task
 * clears it as well, as a fallback for entry points that are not wrapped (such as `onclick`
 * properties). This is an observation of control flow, not an inference from timing.
 */
export function installRequestTracker() {
  if (/** @type {any} */ (window).__launchscopeRequests) return;
  /** @type {Array<{ id: number, url: string, method: string, causeId: number | null }>} */
  const calls = [];
  let nextId = 0;
  /** @type {number | null} */
  let cause = null;
  let clearScheduled = false;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    cause = null;
    clearScheduled = false;
  };
  /** @param {number} id */
  const setCause = (id) => {
    cause = id;
    if (!clearScheduled) {
      clearScheduled = true;
      channel.port2.postMessage(0);
    }
  };
  /** @param {unknown} url */
  const absolute = (url) => {
    try {
      const parsed = new URL(String(url), location.href);
      parsed.hash = '';
      return parsed.href;
    } catch {
      return String(url);
    }
  };
  /** @param {string} url @param {string} method */
  const record = (url, method) => {
    const id = (nextId += 1);
    calls.push({ id, url: absolute(url), method: method.toUpperCase(), causeId: cause });
    return id;
  };

  /** @type {WeakMap<Response, number>} */
  const responseIds = new WeakMap();
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function trackedFetch(input, init) {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const id = record(url, method);
      return originalFetch.call(this, input, init).then((response) => {
        responseIds.set(response, id);
        setCause(id);
        return response;
      });
    };
    for (const name of /** @type {const} */ (['json', 'text', 'arrayBuffer', 'blob', 'formData'])) {
      const original = Response.prototype[name];
      if (typeof original !== 'function') continue;
      Object.defineProperty(Response.prototype, name, {
        configurable: true,
        writable: true,
        value: function trackedBody() {
          return /** @type {Promise<unknown>} */ (original.call(this)).then((value) => {
            const id = responseIds.get(this);
            if (id !== undefined) setCause(id);
            return value;
          });
        },
      });
    }
  }

  // Browser globals and prototypes are patched dynamically, so they are typed loosely here.
  const global = /** @type {any} */ (window);

  /** @param {Function} callback @returns {Function} */
  const startsTask = (callback) =>
    /** @this {any} @param {any[]} args */
    function trackedTask(...args) {
      cause = null;
      return callback.apply(this, args);
    };
  for (const name of [
    'setTimeout',
    'setInterval',
    'requestAnimationFrame',
    'requestIdleCallback',
  ]) {
    const original = global[name];
    if (typeof original !== 'function') continue;
    /** @this {any} @param {unknown} callback @param {any[]} rest */
    global[name] = function trackedSchedule(callback, ...rest) {
      return original.call(
        this,
        typeof callback === 'function' ? startsTask(callback) : callback,
        ...rest,
      );
    };
  }

  /** @type {WeakMap<object, number>} */
  const xhrIds = new WeakMap();
  const XHR = window.XMLHttpRequest;
  const completionEvents = ['readystatechange', 'load', 'loadend'];
  /**
   * An XHR event handler: completion runs "caused by" that request; any other event (progress,
   * earlier ready states) is a new task with no cause.
   *
   * @param {Function} handler
   * @param {string} type
   * @returns {Function}
   */
  const wrapHandler = (handler, type) =>
    /** @this {any} @param {any[]} args */
    function trackedHandler(...args) {
      const id = xhrIds.get(this);
      if (id !== undefined && (type !== 'readystatechange' || this.readyState === 4)) setCause(id);
      else cause = null;
      return handler.apply(this, args);
    };
  if (typeof XHR === 'function') {
    const proto = /** @type {any} */ (XHR.prototype);
    const originalOpen = proto.open;
    const originalSend = proto.send;
    /** @this {any} @param {any[]} args */
    proto.open = function trackedOpen(...args) {
      this.__launchscopeTarget = { method: String(args[0]), url: String(args[1]) };
      return originalOpen.apply(this, args);
    };
    /** @this {any} @param {any[]} args */
    proto.send = function trackedSend(...args) {
      const target = this.__launchscopeTarget;
      if (target) xhrIds.set(this, record(target.url, target.method));
      return originalSend.apply(this, args);
    };
    /** @param {string} name */
    const findDescriptor = (name) => {
      // `onload`/`onloadend` live on XMLHttpRequestEventTarget.prototype, one level up.
      for (let target = proto; target; target = Object.getPrototypeOf(target)) {
        const descriptor = Object.getOwnPropertyDescriptor(target, name);
        if (descriptor) return descriptor;
      }
      return undefined;
    };
    for (const type of completionEvents) {
      // Redefined on XMLHttpRequest.prototype so XMLHttpRequestUpload is left untouched.
      const descriptor = findDescriptor(`on${type}`);
      if (!descriptor?.set || !descriptor.get) continue;
      const { get, set } = descriptor;
      Object.defineProperty(proto, `on${type}`, {
        configurable: true,
        /** @this {any} */
        get() {
          return this.__launchscopeOriginal?.[type] ?? get.call(this);
        },
        /** @this {any} @param {unknown} handler */
        set(handler) {
          this.__launchscopeOriginal ??= {};
          this.__launchscopeOriginal[type] = handler;
          set.call(this, typeof handler === 'function' ? wrapHandler(handler, type) : handler);
        },
      });
    }
  }

  // Every listener starts a task; XHR completion listeners set their request as the cause.
  // Wrapped listeners are remembered so removeEventListener keeps working for the page.
  /** @type {WeakMap<Function, Map<string, Function>>} */
  const wrappedListeners = new WeakMap();
  const targetProto = /** @type {any} */ (EventTarget.prototype);
  const originalAdd = targetProto.addEventListener;
  const originalRemove = targetProto.removeEventListener;
  /** @param {object} target @param {string} type */
  const listenerKey = (target, type) =>
    typeof XHR === 'function' && target instanceof XHR && completionEvents.includes(type)
      ? `xhr:${type}`
      : `task:${type}`;
  /** @this {any} @param {string} type @param {unknown} listener @param {unknown} options */
  targetProto.addEventListener = function trackedAddEventListener(type, listener, options) {
    if (typeof listener !== 'function') return originalAdd.call(this, type, listener, options);
    const key = listenerKey(this, type);
    const byKey = wrappedListeners.get(listener) ?? new Map();
    const wrapped =
      byKey.get(key) ??
      (key.startsWith('xhr:') ? wrapHandler(listener, type) : startsTask(listener));
    byKey.set(key, wrapped);
    wrappedListeners.set(listener, byKey);
    return originalAdd.call(this, type, wrapped, options);
  };
  /** @this {any} @param {string} type @param {unknown} listener @param {unknown} options */
  targetProto.removeEventListener = function trackedRemoveEventListener(type, listener, options) {
    const wrapped =
      typeof listener === 'function'
        ? wrappedListeners.get(listener)?.get(listenerKey(this, type))
        : undefined;
    return originalRemove.call(this, type, wrapped ?? listener, options);
  };

  Object.defineProperty(window, '__launchscopeRequests', {
    configurable: false,
    enumerable: false,
    value: () => calls.slice(),
  });
}
