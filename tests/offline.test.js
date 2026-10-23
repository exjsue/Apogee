import test from "node:test";
import assert from "node:assert/strict";
import { createOffline, shouldRegister, browserTimers, CACHE_PREFIX, UPDATE_CHECK_INTERVAL_MS, APPLY_TIMEOUT_MS } from "../src/app/offline.js";

const PAGE = "https://exjsue.github.io/GymAppppp/";
const SCOPE = PAGE;
const MINUTE = 60 * 1000;

// ---- fakes for the browser objects ----

class FakeWorker extends EventTarget {
  constructor(state = "installed") {
    super();
    this.state = state;
    this.posted = [];
    this.reply = null; // what to answer to GET_VERSION
  }

  postMessage(message, ports = []) {
    this.posted.push(message);
    if (message.type === "GET_VERSION" && ports[0] && this.reply) ports[0].postMessage(this.reply);
  }

  setState(state) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  constructor(scope) {
    super();
    this.scope = scope;
    this.active = null;
    this.waiting = null;
    this.installing = null;
    this.updateCalls = 0;
    this.updateError = null;
    this.unregistered = false;
  }

  async update() {
    this.updateCalls += 1;
    if (this.updateError) throw this.updateError;
  }

  async unregister() {
    this.unregistered = true;
    return true;
  }
}

class FakeServiceWorker extends EventTarget {
  constructor() {
    super();
    this.controller = null;
    this.registrations = new Map();
    this.registerCalls = [];
  }

  async register(workerUrl, options) {
    this.registerCalls.push({ workerUrl, options });
    const scope = new URL(options.scope, PAGE).href;
    if (!this.registrations.has(scope)) this.registrations.set(scope, new FakeRegistration(scope));
    return this.registrations.get(scope);
  }

  // like the browser: the registration with the longest scope that contains the address
  async getRegistration(address) {
    const matches = [...this.registrations.values()].filter((r) => address.startsWith(r.scope));
    return matches.sort((a, b) => b.scope.length - a.scope.length)[0];
  }

  takeControl(worker = new FakeWorker("activated")) {
    this.controller = worker;
    this.dispatchEvent(new Event("controllerchange"));
  }
}

function fakeCaches(initial = {}) {
  const store = new Map(Object.entries(initial).map(([name, files]) => [name, [...files]]));
  return {
    store,
    async keys() {
      return [...store.keys()];
    },
    async has(name) {
      return store.has(name);
    },
    async delete(name) {
      return store.delete(name);
    },
    async open(name) {
      return { keys: async () => (store.get(name) ?? []).map((url) => ({ url })) };
    },
  };
}

function fakeDocument() {
  const target = new EventTarget();
  target.visibilityState = "visible";
  target.show = () => {
    target.visibilityState = "visible";
    target.dispatchEvent(new Event("visibilitychange"));
  };
  target.hide = () => {
    target.visibilityState = "hidden";
    target.dispatchEvent(new Event("visibilitychange"));
  };
  return target;
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (id) => pending.delete(id),
    fireAll: () => {
      for (const [id, { fn }] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    count: () => pending.size,
  };
}

// Builds an offline manager on a fake page. `at` is the address of the page.
function setup({ address = PAGE, serviceWorker = new FakeServiceWorker(), caches = fakeCaches(), clock = { now: 0 } } = {}) {
  const location = new URL(address);
  const document = fakeDocument();
  const timers = fakeTimers();
  const reloads = [];
  const offline = createOffline({
    serviceWorker, caches, document, location, timers, now: () => clock.now, reloadPage: () => reloads.push(true),
  });
  return { offline, serviceWorker, caches, document, timers, reloads, clock, location };
}

// While this runs, any use of IndexedDB fails the test.
async function withTrappedIndexedDB(body) {
  const real = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const touched = [];
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    get() {
      touched.push("indexedDB was read");
      throw new Error("IndexedDB must not be touched");
    },
  });
  try {
    await body();
  } finally {
    if (real) Object.defineProperty(globalThis, "indexedDB", real);
    else delete globalThis.indexedDB;
  }
  assert.deepEqual(touched, []);
}

// ---- when to register ----

test("shouldRegister: automatic everywhere except this computer's own addresses, which need ?sw=1", () => {
  for (const hostname of ["exjsue.github.io", "example.com", "192.168.1.20", "localhost.example.com", "127.0.0.1.example.com"]) {
    assert.equal(shouldRegister({ hostname, search: "" }), true, hostname);
  }
  for (const hostname of ["localhost", "127.0.0.1", "[::1]", "::1"]) {
    assert.equal(shouldRegister({ hostname, search: "" }), false, hostname);
    assert.equal(shouldRegister({ hostname, search: "?x=1" }), false, hostname);
    assert.equal(shouldRegister({ hostname, search: "?sw=0" }), false, hostname);
    assert.equal(shouldRegister({ hostname, search: "?sw=10" }), false, hostname);
    assert.equal(shouldRegister({ hostname, search: "?sw" }), false, hostname);
    assert.equal(shouldRegister({ hostname, search: "?sw=1" }), true, hostname);
    assert.equal(shouldRegister({ hostname, search: "?a=b&sw=1" }), true, hostname);
  }
});

test("start: on the live address it registers sw.js with this app's own scope and no HTTP caching of the worker", async () => {
  const { offline, serviceWorker } = setup();
  await offline.start();
  assert.deepEqual(serviceWorker.registerCalls, [{ workerUrl: "./sw.js", options: { scope: "./", updateViaCache: "none" } }]);
});

test("start: on 127.0.0.1 and localhost it does not register by itself, and does with ?sw=1", async () => {
  for (const address of ["http://127.0.0.1:8080/", "http://localhost:8080/", "http://[::1]:8080/", "http://127.0.0.1:8080/?x=1"]) {
    const { offline, serviceWorker } = setup({ address });
    await offline.start();
    assert.deepEqual(serviceWorker.registerCalls, [], address);
  }
  for (const address of ["http://127.0.0.1:8080/?sw=1", "http://localhost:8080/?sw=1"]) {
    const { offline, serviceWorker } = setup({ address });
    await offline.start();
    assert.equal(serviceWorker.registerCalls.length, 1, address);
  }
});

test("start: where it does not register it still follows an existing registration of this app", async () => {
  const serviceWorker = new FakeServiceWorker();
  const registration = new FakeRegistration("http://127.0.0.1:8080/");
  registration.waiting = new FakeWorker();
  serviceWorker.registrations.set(registration.scope, registration);
  serviceWorker.controller = new FakeWorker("activated");
  const { offline } = setup({ address: "http://127.0.0.1:8080/", serviceWorker });
  await offline.start();
  assert.deepEqual(serviceWorker.registerCalls, []);
  assert.equal(offline.getState().updateAvailable, true);
});

test("start: it never adopts a registration whose scope is not this app's (another site on the same origin)", async () => {
  const serviceWorker = new FakeServiceWorker();
  // A registration with a broader scope also contains this page, so the browser would hand it back when asked.
  const foreign = new FakeRegistration("http://127.0.0.1:8080/");
  foreign.waiting = new FakeWorker();
  serviceWorker.registrations.set(foreign.scope, foreign);
  serviceWorker.controller = new FakeWorker("activated");
  const { offline } = setup({ address: "http://127.0.0.1:8080/app/", serviceWorker }); // our scope is /app/, not registering here
  await offline.start();
  assert.deepEqual(serviceWorker.registerCalls, []);
  assert.equal(offline.getState().updateAvailable, false, "someone else's waiting worker is not our update");
  assert.equal((await offline.getStatus()).registered, false);
  assert.deepEqual(await offline.resetOfflineCopy(), { unregistered: false, cachesDeleted: 0 });
  assert.equal(foreign.unregistered, false, "someone else's registration is never unregistered");
});

test("start: where service workers do not exist the manager reports it and nothing throws", async () => {
  const { offline } = setup({ serviceWorker: null });
  await offline.start();
  const status = await offline.getStatus();
  assert.equal(status.supported, false);
  assert.equal(status.ready, false);
  assert.equal((await offline.resetOfflineCopy()).unregistered, false);
  await assert.rejects(offline.applyUpdate(), /no update waiting/);
});

test("start: a registration failure is reported, not thrown", async () => {
  const serviceWorker = new FakeServiceWorker();
  serviceWorker.register = async () => {
    throw new Error("The script could not be loaded");
  };
  const { offline } = setup({ serviceWorker });
  const state = await offline.start();
  assert.equal(state.error, "The script could not be loaded");
});

// ---- detecting an update ----

test("update: a worker already waiting while another controls the page means an update is available", async () => {
  const serviceWorker = new FakeServiceWorker();
  serviceWorker.controller = new FakeWorker("activated");
  const registration = new FakeRegistration(SCOPE);
  registration.waiting = new FakeWorker();
  serviceWorker.registrations.set(SCOPE, registration);
  const { offline } = setup({ serviceWorker });
  await offline.start();
  assert.equal(offline.getState().updateAvailable, true);
});

test("update: a worker waiting on the very first visit (nothing controls the page yet) is not an update", async () => {
  const serviceWorker = new FakeServiceWorker();
  const registration = new FakeRegistration(SCOPE);
  registration.waiting = new FakeWorker();
  serviceWorker.registrations.set(SCOPE, registration);
  const { offline } = setup({ serviceWorker });
  await offline.start();
  assert.equal(offline.getState().updateAvailable, false);
});

test("update: a new worker that finishes installing while the app runs makes the banner state appear", async () => {
  const { offline, serviceWorker } = setup();
  serviceWorker.controller = new FakeWorker("activated");
  const seen = [];
  offline.onChange((state) => seen.push(state.updateAvailable));
  await offline.start();
  const registration = serviceWorker.registrations.get(SCOPE);
  const incoming = new FakeWorker("installing");
  registration.installing = incoming;
  registration.dispatchEvent(new Event("updatefound"));
  assert.equal(offline.getState().updateAvailable, false, "still installing");
  incoming.setState("installed");
  assert.equal(offline.getState().updateAvailable, true);
  assert.equal(seen.at(-1), true);
});

test("update: a worker installing on the first visit never shows an update banner", async () => {
  const { offline, serviceWorker } = setup();
  await offline.start();
  const registration = serviceWorker.registrations.get(SCOPE);
  const first = new FakeWorker("installing");
  registration.installing = first;
  registration.dispatchEvent(new Event("updatefound"));
  first.setState("installed");
  first.setState("activated");
  assert.equal(offline.getState().updateAvailable, false);
});

test("update: a failed install (the new worker becomes redundant) shows nothing", async () => {
  const { offline, serviceWorker } = setup();
  serviceWorker.controller = new FakeWorker("activated");
  await offline.start();
  const registration = serviceWorker.registrations.get(SCOPE);
  const broken = new FakeWorker("installing");
  registration.installing = broken;
  registration.dispatchEvent(new Event("updatefound"));
  broken.setState("redundant");
  assert.equal(offline.getState().updateAvailable, false);
});

// ---- applying it: only on the user's click ----

async function withWaitingUpdate() {
  const world = setup();
  world.serviceWorker.controller = new FakeWorker("activated");
  await world.offline.start();
  const registration = world.serviceWorker.registrations.get(SCOPE);
  registration.waiting = new FakeWorker("installed");
  registration.dispatchEvent(new Event("updatefound"));
  registration.installing = registration.waiting;
  registration.dispatchEvent(new Event("updatefound"));
  registration.waiting.setState("installed");
  return { ...world, registration, waiting: registration.waiting };
}

test("apply: a waiting worker is never told to activate until applyUpdate is called", async () => {
  const { offline, waiting, serviceWorker, reloads, document, clock } = await withWaitingUpdate();
  assert.equal(offline.getState().updateAvailable, true);
  // time passes, the page comes back to the foreground, the browser checks again: still nothing is sent
  clock.now += 5 * UPDATE_CHECK_INTERVAL_MS;
  document.show();
  await offline.checkForUpdate({ force: true });
  assert.deepEqual(waiting.posted, []);
  assert.deepEqual(reloads, []);
  assert.equal(serviceWorker.controller.state, "activated");
});

test("apply: on the click it sends SKIP_WAITING once and reloads only after the new worker has taken over", async () => {
  const { offline, waiting, serviceWorker, reloads } = await withWaitingUpdate();
  const applying = offline.applyUpdate();
  assert.deepEqual(waiting.posted, [{ type: "SKIP_WAITING" }]);
  assert.deepEqual(reloads, [], "not before the switch");
  serviceWorker.takeControl(new FakeWorker("activated"));
  await applying;
  assert.deepEqual(reloads, [true]);
});

test("apply: if nothing happens within the time limit it says so and does not reload", async () => {
  const { offline, timers, reloads } = await withWaitingUpdate();
  const applying = offline.applyUpdate();
  timers.fireAll(); // the 10 second limit passes
  await assert.rejects(applying, /did not start/);
  assert.deepEqual(reloads, []);
  assert.ok(APPLY_TIMEOUT_MS > 0);
  assert.equal(timers.count(), 0, "no timer left running");
});

test("apply: with no update waiting it refuses and sends nothing", async () => {
  const { offline } = setup();
  await offline.start();
  await assert.rejects(offline.applyUpdate(), /no update waiting/);
});

test("apply: a controller change the user did not ask for never reloads the page; it only warns", async () => {
  const world = setup();
  world.serviceWorker.controller = new FakeWorker("activated");
  await world.offline.start();
  world.serviceWorker.takeControl(new FakeWorker("activated")); // another tab applied an update
  assert.equal(world.offline.getState().updatedElsewhere, true);
  assert.deepEqual(world.reloads, []);
  world.offline.reload();
  assert.deepEqual(world.reloads, [true], "reloading happens only when the page asks for it");
});

test("apply: the worker taking over a first visit (nothing controlled the page before) is not 'updated elsewhere'", async () => {
  const world = setup();
  await world.offline.start();
  world.serviceWorker.takeControl(new FakeWorker("activated"));
  assert.equal(world.offline.getState().updatedElsewhere, false);
  assert.deepEqual(world.reloads, []);
  world.serviceWorker.takeControl(new FakeWorker("activated")); // a later change IS an update from elsewhere
  assert.equal(world.offline.getState().updatedElsewhere, true);
});

// ---- the hourly update check ----

test("update check: coming back to the foreground checks for a new version at most once an hour", async () => {
  const { offline, serviceWorker, document, clock } = setup();
  await offline.start(); // loading the page counts as the check at time 0
  const registration = serviceWorker.registrations.get(SCOPE);
  document.show();
  clock.now = 10 * MINUTE;
  document.show();
  clock.now = UPDATE_CHECK_INTERVAL_MS - 1;
  document.show();
  await Promise.resolve();
  assert.equal(registration.updateCalls, 0, "within the hour of the page load");

  clock.now = UPDATE_CHECK_INTERVAL_MS;
  document.show();
  await Promise.resolve();
  assert.equal(registration.updateCalls, 1, "an hour on");
  clock.now += 5 * MINUTE;
  document.show();
  clock.now += 40 * MINUTE;
  document.show();
  await Promise.resolve();
  assert.equal(registration.updateCalls, 1, "not again within the hour");

  clock.now += 20 * MINUTE;
  document.show();
  await Promise.resolve();
  assert.equal(registration.updateCalls, 2, "an hour after the last check");
});

test("update check: going to the background never checks, and a failed check is quietly tried again later", async () => {
  const { offline, serviceWorker, document, clock } = setup();
  await offline.start();
  const registration = serviceWorker.registrations.get(SCOPE);
  clock.now = 3 * UPDATE_CHECK_INTERVAL_MS;
  document.hide();
  await Promise.resolve();
  assert.equal(registration.updateCalls, 0);
  registration.updateError = new TypeError("Failed to fetch");
  assert.equal(await offline.checkForUpdate(), false, "offline: no error escapes");
  assert.equal(registration.updateCalls, 1);
  assert.equal(await offline.checkForUpdate(), false, "and not hammered: the attempt used up the hour");
  assert.equal(registration.updateCalls, 1);
});

test("update check: it can be forced, and does nothing without a registration", async () => {
  const none = setup({ address: "http://127.0.0.1:8080/" });
  await none.offline.start();
  assert.equal(await none.offline.checkForUpdate({ force: true }), false);
  const { offline, serviceWorker } = setup();
  await offline.start();
  const registration = serviceWorker.registrations.get(SCOPE);
  assert.equal(await offline.checkForUpdate({ force: true }), true);
  assert.equal(await offline.checkForUpdate({ force: true }), true);
  assert.equal(registration.updateCalls, 2);
});

// ---- what the Offline section shows ----

async function withActiveWorker({ reply, cacheFiles } = {}) {
  const caches = fakeCaches(cacheFiles ?? {});
  const world = setup({ caches });
  await world.offline.start();
  const registration = world.serviceWorker.registrations.get(SCOPE);
  registration.active = new FakeWorker("activated");
  registration.active.reply = reply ?? null;
  return { ...world, registration };
}

test("status: ready only when an active worker's cache holds every file it should; the version is shown short", async () => {
  const version = "0123456789abcdef".repeat(4);
  const complete = await withActiveWorker({ reply: { version, fileCount: 3 }, cacheFiles: { [CACHE_PREFIX + version]: ["a", "b", "c"] } });
  const ready = await complete.offline.getStatus();
  assert.equal(ready.ready, true);
  assert.equal(ready.version, version);
  assert.equal(ready.versionShort, "01234567");
  assert.equal(ready.versionShort.length, 8);

  const partial = await withActiveWorker({ reply: { version, fileCount: 3 }, cacheFiles: { [CACHE_PREFIX + version]: ["a", "b"] } });
  const notReady = await partial.offline.getStatus();
  assert.equal(notReady.ready, false);
  assert.equal(notReady.versionShort, "01234567");

  const missing = await withActiveWorker({ reply: { version, fileCount: 3 }, cacheFiles: {} });
  assert.equal((await missing.offline.getStatus()).ready, false);
});

test("status: a worker that does not answer, or no active worker, is simply not ready", async () => {
  const silent = await withActiveWorker({ reply: null });
  const pending = silent.offline.getStatus();
  await Promise.resolve();
  silent.timers.fireAll();
  const status = await pending;
  assert.equal(status.ready, false);
  assert.equal(status.version, null);

  const fresh = setup();
  await fresh.offline.start();
  const none = await fresh.offline.getStatus();
  assert.deepEqual([none.supported, none.registered, none.ready, none.version], [true, true, false, null]);
});

test("status: reports whether it is switched off on this address", async () => {
  const local = setup({ address: "http://127.0.0.1:8080/" });
  await local.offline.start();
  const status = await local.offline.getStatus();
  assert.deepEqual([status.supported, status.enabled, status.registered], [true, false, false]);
});

// ---- reset ----

test("reset: removes this app's registration and only the caches with its prefix", async () => {
  const caches = fakeCaches({
    [`${CACHE_PREFIX}old`]: ["a"], [`${CACHE_PREFIX}new`]: ["a"],
    "other-site-cache": ["x"], "workbox-precache-v2": ["y"], "apogee-precache": ["z"], "my-apogee-precache-1": ["w"],
  });
  const world = setup({ caches });
  await world.offline.start();
  const registration = world.serviceWorker.registrations.get(SCOPE);
  const result = await world.offline.resetOfflineCopy();
  assert.deepEqual(result, { unregistered: true, cachesDeleted: 2 });
  assert.equal(registration.unregistered, true);
  assert.deepEqual([...caches.store.keys()].sort(), ["apogee-precache", "my-apogee-precache-1", "other-site-cache", "workbox-precache-v2"]);
});

test("reset: with another cache prefix (as the browser test page uses) the app's real caches are out of reach", async () => {
  const caches = fakeCaches({
    [`${CACHE_PREFIX}real-version`]: ["a"], "apogee-test-precache-one": ["a"], "apogee-test-precache-two": ["a"], "other-site-cache": ["x"],
  });
  const location = new URL(PAGE);
  const offline = createOffline({
    serviceWorker: new FakeServiceWorker(), caches, document: fakeDocument(), location, timers: fakeTimers(), cachePrefix: "apogee-test-precache-",
  });
  assert.deepEqual(await offline.resetOfflineCopy(), { unregistered: false, cachesDeleted: 2 });
  assert.deepEqual([...caches.store.keys()].sort(), [`${CACHE_PREFIX}real-version`, "other-site-cache"]);
});

test("reset: another site's registration on the same origin is left alone, whatever its scope", async () => {
  const serviceWorker = new FakeServiceWorker();
  const neighbours = ["https://exjsue.github.io/", "https://exjsue.github.io/OtherSite/", "https://exjsue.github.io/GymAppppp2/"].map((scope) => {
    const registration = new FakeRegistration(scope);
    serviceWorker.registrations.set(scope, registration);
    return registration;
  });
  const world = setup({ serviceWorker });
  const result = await world.offline.resetOfflineCopy(); // this app never registered here
  assert.equal(result.unregistered, false);
  assert.ok(neighbours.every((r) => r.unregistered === false));
});

test("reset: with nothing installed it reports that and changes nothing", async () => {
  const caches = fakeCaches({ "other-site-cache": ["x"] });
  const world = setup({ caches });
  assert.deepEqual(await world.offline.resetOfflineCopy(), { unregistered: false, cachesDeleted: 0 });
  assert.deepEqual([...caches.store.keys()], ["other-site-cache"]);
});

test("reset clears a pending update and tells listeners", async () => {
  const world = await withWaitingUpdate();
  const seen = [];
  world.offline.onChange((state) => seen.push(state.updateAvailable));
  await world.offline.resetOfflineCopy();
  assert.equal(world.offline.getState().updateAvailable, false);
  assert.equal(seen.at(-1), false);
});

test("nothing here ever touches IndexedDB: start, update, status and reset all run with it booby-trapped", async () => {
  await withTrappedIndexedDB(async () => {
    const version = "f".repeat(64);
    const caches = fakeCaches({ [CACHE_PREFIX + version]: ["a", "b"], "other-site-cache": ["x"] });
    const world = setup({ caches });
    world.serviceWorker.controller = new FakeWorker("activated");
    await world.offline.start();
    const registration = world.serviceWorker.registrations.get(SCOPE);
    registration.active = new FakeWorker("activated");
    registration.active.reply = { version, fileCount: 2 };
    registration.waiting = new FakeWorker("installed");
    registration.installing = registration.waiting;
    registration.dispatchEvent(new Event("updatefound"));
    registration.waiting.setState("installed");
    assert.equal((await world.offline.getStatus()).ready, true);
    await world.offline.checkForUpdate({ force: true });
    const applying = world.offline.applyUpdate();
    world.serviceWorker.takeControl(new FakeWorker("activated"));
    await applying;
    await world.offline.resetOfflineCopy();
  });
});

test("the default timers call the window's own functions, not as methods of another object (a browser throws Illegal invocation otherwise)", () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const calls = [];
  // like a browser: refuses to run unless called on the global object (or with no object at all)
  const strict = (name, real) => function (...args) {
    if (this !== globalThis && this !== undefined) throw new TypeError("Illegal invocation");
    calls.push(name);
    return real.apply(globalThis, args);
  };
  globalThis.setTimeout = strict("setTimeout", realSet);
  globalThis.clearTimeout = strict("clearTimeout", realClear);
  try {
    const id = browserTimers.setTimeout(() => {}, 1000);
    browserTimers.clearTimeout(id);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  assert.deepEqual(calls, ["setTimeout", "clearTimeout"]);
});

test("the cache prefix is the one the worker uses", () => {
  assert.equal(CACHE_PREFIX, "apogee-precache-");
  assert.ok(UPDATE_CHECK_INTERVAL_MS === 3600000);
});

// ---- checkNow: the check behind pull-to-refresh only looks, it never activates ----

test("checkNow: forces a check even within the hour, says current when nothing is newer, and activates nothing", async () => {
  const { offline, serviceWorker, reloads } = setup();
  serviceWorker.controller = new FakeWorker("activated");
  await offline.start();
  const registration = serviceWorker.registrations.get(SCOPE);
  assert.deepEqual(await offline.checkNow(), { status: "current" });
  assert.equal(registration.updateCalls, 1); // a check was made although one had just happened
  assert.deepEqual(reloads, []);
  registration.updateError = new Error("offline");
  assert.deepEqual(await offline.checkNow(), { status: "unreachable" });
});

test("checkNow: waits for a new version that is still installing, reports it as an update, and still sends nothing", async () => {
  const { offline, serviceWorker, reloads } = setup();
  serviceWorker.controller = new FakeWorker("activated");
  await offline.start();
  const registration = serviceWorker.registrations.get(SCOPE);
  const incoming = new FakeWorker("installing");
  registration.update = async () => {
    registration.installing = incoming;
    registration.dispatchEvent(new Event("updatefound"));
  };
  const checking = offline.checkNow();
  await new Promise((resolve) => setImmediate(resolve));
  incoming.setState("installed"); // the download finished
  registration.waiting = incoming;
  assert.deepEqual(await checking, { status: "update" });
  assert.deepEqual(incoming.posted, []); // looking never activates
  assert.deepEqual(reloads, []);
});

test("checkNow: a version that is still downloading when the wait ends is 'installing', never 'current'; a failed install is 'current'", async () => {
  const { offline, serviceWorker, timers } = setup();
  serviceWorker.controller = new FakeWorker("activated");
  await offline.start();
  const registration = serviceWorker.registrations.get(SCOPE);
  const slow = new FakeWorker("installing");
  registration.update = async () => {
    registration.installing = slow;
    registration.dispatchEvent(new Event("updatefound"));
  };
  const checking = offline.checkNow();
  await new Promise((resolve) => setImmediate(resolve));
  timers.fireAll(); // the wait runs out
  assert.deepEqual(await checking, { status: "installing" });
  const broken = new FakeWorker("installing");
  registration.update = async () => {
    registration.installing = broken;
    registration.dispatchEvent(new Event("updatefound"));
    broken.state = "redundant";
  };
  assert.deepEqual(await offline.checkNow(), { status: "current" });
});

test("checkNow: 'off' when update checking is not available or not switched on here, and an update already waiting is found", async () => {
  const unsupported = setup({ serviceWorker: null });
  await unsupported.offline.start();
  assert.deepEqual(await unsupported.offline.checkNow(), { status: "off" });
  const local = setup({ address: "http://127.0.0.1:8080/" }); // needs ?sw=1 on this address
  await local.offline.start();
  assert.deepEqual(await local.offline.checkNow(), { status: "off" });

  const { offline, waiting } = await withWaitingUpdate();
  assert.deepEqual(await offline.checkNow(), { status: "update" });
  assert.deepEqual(waiting.posted, []);
});
