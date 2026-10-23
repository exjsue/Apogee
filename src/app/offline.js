// Offline support for the page: registers the service worker, reports what
// state it is in, and offers the two user-controlled actions, "apply the update"
// and "reset the offline copy". No DOM here: the browser objects are passed in,
// which is also how the tests drive it with fakes.
//
// Rules this module keeps:
//   - A waiting worker is only told to activate by applyUpdate(), which the UI
//     calls when the user clicks Reload, or releases a pull-to-refresh past its
//     threshold and (if something would be lost) confirms. checkNow() only looks;
//     nothing else ever sends that message.
//   - Resetting removes this app's registration and this app's caches only, and
//     never reads or writes IndexedDB or any other stored data of the app.
//   - Every request goes through the browser's own worker mechanism; nothing
//     here makes a network request of its own.

// Must equal the prefix in sw.js (a test checks that they match).
export const CACHE_PREFIX = "gymapp-precache-";
// The worker's cache for one version is named CACHE_PREFIX + the version.

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // at most one check an hour
export const APPLY_TIMEOUT_MS = 10 * 1000;
export const VERSION_TIMEOUT_MS = 2 * 1000;
export const INSTALL_WAIT_MS = 20 * 1000; // how long checkNow waits for a new worker to finish installing

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

// The browser's timer functions must be called on the window itself. Putting
// the bare functions in an object and calling them as its methods throws
// "Illegal invocation" in a browser, so these wrappers call them properly.
export const browserTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

// The worker registers by itself everywhere except on this computer's own
// addresses, where it needs the address to end in ?sw=1. While developing, an
// installed copy would otherwise keep showing old files after every edit.
export function shouldRegister({ hostname, search }) {
  if (!LOCAL_HOSTS.includes(hostname)) return true;
  return new URLSearchParams(search).get("sw") === "1";
}

export function createOffline({
  serviceWorker = globalThis.navigator?.serviceWorker,
  caches = globalThis.caches,
  document = globalThis.document,
  location = globalThis.location,
  now = () => Date.now(),
  reloadPage = () => location.reload(),
  timers = browserTimers,
  workerUrl = "./sw.js",
  cachePrefix = CACHE_PREFIX, // only tests pass another one, to keep the real caches out of their way
} = {}) {
  const supported = Boolean(serviceWorker && typeof serviceWorker.register === "function");
  const enabled = supported && shouldRegister({ hostname: location.hostname, search: location.search });
  const scopeHref = new URL("./", location.href).href;

  let registration = null;
  let hadController = false;
  let applying = false;
  let resolveApplied = null;
  let lastCheckAt = null;
  const state = { updateAvailable: false, updatedElsewhere: false, error: null };
  const listeners = new Set();

  const snapshot = () => ({ ...state });
  const notify = () => {
    for (const listener of listeners) listener(snapshot());
  };

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function track(found) {
    registration = found;
    if (found.waiting && serviceWorker.controller) state.updateAvailable = true;
    found.addEventListener("updatefound", () => {
      const worker = found.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        // installed while another worker controls this page: it now waits for the user
        if (worker.state === "installed" && serviceWorker.controller) state.updateAvailable = true;
        notify();
      });
    });
  }

  function onControllerChange() {
    if (applying) {
      reloadPage(); // the user clicked Reload: the new worker is in charge, start the page afresh
      if (resolveApplied) resolveApplied();
    } else if (hadController) {
      state.updatedElsewhere = true; // another tab applied an update; this page runs older code
    }
    hadController = true;
    notify();
  }

  // Looks for a new worker, at most once an hour unless forced. Loading the page
  // counts as a check, because the browser looks for a new worker on every load.
  async function checkForUpdate({ force = false } = {}) {
    if (!registration) return false;
    const time = now();
    if (!force && lastCheckAt !== null && time - lastCheckAt < UPDATE_CHECK_INTERVAL_MS) return false;
    lastCheckAt = time;
    try {
      await registration.update();
      return true;
    } catch {
      return false; // offline, or the server is not reachable: try again later
    }
  }

  // Pull-to-refresh: looks for a new worker NOW (even within the hour), waits for
  // one that is installing to finish (it downloads every file of the new version),
  // and says what it found. It never activates anything: only applyUpdate does.
  //   "off"          no update checking here (no worker support, or switched off on this address)
  //   "unreachable"  the check could not run (offline, or the server did not answer)
  //   "installing"   a new version is still downloading
  //   "update"       a new version is waiting (the Reload button's case)
  //   "elsewhere"    another tab already updated; this tab runs older code
  //   "current"      nothing newer
  async function checkNow({ timeoutMs = INSTALL_WAIT_MS } = {}) {
    if (!supported || (!registration && !enabled)) return { status: "off" };
    if (!registration) return { status: "unreachable" };
    if (!(await checkForUpdate({ force: true }))) return { status: "unreachable" };
    const finished = (worker) => worker.state === "installed" || worker.state === "activated" || worker.state === "redundant";
    const installing = registration.installing;
    if (installing && !finished(installing)) {
      await new Promise((resolve) => {
        const timer = timers.setTimeout(done, timeoutMs);
        function done() {
          timers.clearTimeout(timer);
          installing.removeEventListener("statechange", onState);
          resolve();
        }
        function onState() {
          if (finished(installing)) done();
        }
        installing.addEventListener("statechange", onState);
      });
      if (!finished(installing)) return { status: "installing" };
    }
    if (state.updatedElsewhere) return { status: "elsewhere" };
    if (state.updateAvailable || (registration.waiting && serviceWorker.controller)) return { status: "update" };
    return { status: "current" };
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") checkForUpdate();
  }

  async function start() {
    if (!supported) {
      notify();
      return snapshot();
    }
    hadController = Boolean(serviceWorker.controller);
    serviceWorker.addEventListener("controllerchange", onControllerChange);
    try {
      let found = await serviceWorker.getRegistration(scopeHref);
      if (found && found.scope !== scopeHref) found = null; // someone else's registration, never ours
      if (enabled) found = await serviceWorker.register(workerUrl, { scope: "./", updateViaCache: "none" });
      if (found) track(found);
    } catch (error) {
      state.error = error.message;
    }
    lastCheckAt = now();
    document.addEventListener("visibilitychange", onVisibilityChange);
    notify();
    return snapshot();
  }

  // The user clicked Reload: tell the waiting worker to take over, then reload
  // the page once it has. Throws if there is nothing waiting or nothing happens.
  async function applyUpdate() {
    const waiting = registration && registration.waiting;
    if (!waiting) throw new Error("There is no update waiting");
    const done = new Promise((resolve) => {
      resolveApplied = resolve;
    });
    applying = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error("The update did not start. Reload the page and try again.")), APPLY_TIMEOUT_MS);
    });
    try {
      await Promise.race([done, timeout]);
    } finally {
      timers.clearTimeout(timer);
      applying = false;
      resolveApplied = null;
    }
  }

  // Asks the active worker which version it is and how many files it holds.
  function askWorker(worker) {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = timers.setTimeout(() => finish(null), VERSION_TIMEOUT_MS);
      function finish(answer) {
        timers.clearTimeout(timer);
        channel.port1.close();
        resolve(answer);
      }
      channel.port1.onmessage = (event) => finish(event.data);
      worker.postMessage({ type: "GET_VERSION" }, [channel.port2]);
    });
  }

  async function cacheIsComplete({ version, fileCount }) {
    if (!caches || !(await caches.has(cachePrefix + version))) return false;
    const cache = await caches.open(cachePrefix + version);
    return (await cache.keys()).length === fileCount;
  }

  // What the Offline section shows. `ready` means: a worker is active and its
  // cache holds every file it should.
  async function getStatus() {
    const status = {
      ...snapshot(), supported, enabled, controlled: Boolean(supported && serviceWorker.controller),
      registered: Boolean(registration), ready: false, version: null, versionShort: null,
    };
    if (!supported || !registration || !registration.active) return status;
    const info = await askWorker(registration.active);
    if (!info || typeof info.version !== "string") return status;
    status.version = info.version;
    status.versionShort = info.version.slice(0, 8);
    status.ready = await cacheIsComplete(info);
    return status;
  }

  // Removes this app's offline copy: its worker registration and its caches. The
  // registration is looked up by this app's own scope (all sites on this origin
  // share one list of registrations and one Cache Storage), and only caches with
  // this app's prefix are deleted. No stored data of the app is touched.
  async function resetOfflineCopy() {
    let unregistered = false;
    let cachesDeleted = 0;
    if (supported) {
      const found = await serviceWorker.getRegistration(scopeHref);
      if (found && found.scope === scopeHref) unregistered = Boolean(await found.unregister());
    }
    if (caches) {
      for (const name of await caches.keys()) {
        if (name.startsWith(cachePrefix) && (await caches.delete(name))) cachesDeleted += 1;
      }
    }
    registration = null;
    state.updateAvailable = false;
    notify();
    return { unregistered, cachesDeleted };
  }

  return {
    start, onChange, getState: snapshot, getStatus, applyUpdate, checkForUpdate, checkNow, resetOfflineCopy, reload: () => reloadPage(),
  };
}
