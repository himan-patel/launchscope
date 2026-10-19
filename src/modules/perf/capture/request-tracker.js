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
 * Every fetch/XHR started while a cause is active records it. The cause stays active until the
 * end of the current task (cleared by a MessageChannel task), which covers promise continuations
 * (`await`) triggered by that response, and nothing scheduled later (timers, user input).
 * This is an observation of control flow, not an inference from timing.
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

  /** @type {WeakMap<object, number>} */
  const xhrIds = new WeakMap();
  const XHR = window.XMLHttpRequest;
  if (typeof XHR === 'function') {
    // Browser prototypes are patched dynamically, so they are typed loosely here.
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
    const completionEvents = ['readystatechange', 'load', 'loadend'];
    /**
     * @param {Function} handler
     * @param {string} type
     * @returns {Function}
     */
    const wrapHandler = (handler, type) =>
      /** @this {any} @param {any[]} args */
      function trackedHandler(...args) {
        const id = xhrIds.get(this);
        if (id !== undefined && (type !== 'readystatechange' || this.readyState === 4))
          setCause(id);
        return handler.apply(this, args);
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
    // Wrapped listeners are remembered so removeEventListener keeps working for the page.
    /** @type {WeakMap<Function, Map<string, Function>>} */
    const wrappedListeners = new WeakMap();
    const originalAdd = proto.addEventListener;
    const originalRemove = proto.removeEventListener;
    /** @this {any} @param {string} type @param {unknown} listener @param {unknown} options */
    proto.addEventListener = function trackedAddEventListener(type, listener, options) {
      if (typeof listener === 'function' && completionEvents.includes(type)) {
        const byType = wrappedListeners.get(listener) ?? new Map();
        const wrapped = byType.get(type) ?? wrapHandler(listener, type);
        byType.set(type, wrapped);
        wrappedListeners.set(listener, byType);
        return originalAdd.call(this, type, wrapped, options);
      }
      return originalAdd.call(this, type, listener, options);
    };
    /** @this {any} @param {string} type @param {unknown} listener @param {unknown} options */
    proto.removeEventListener = function trackedRemoveEventListener(type, listener, options) {
      const wrapped =
        typeof listener === 'function' ? wrappedListeners.get(listener)?.get(type) : undefined;
      return originalRemove.call(this, type, wrapped ?? listener, options);
    };
  }

  Object.defineProperty(window, '__launchscopeRequests', {
    configurable: false,
    enumerable: false,
    value: () => calls.slice(),
  });
}
