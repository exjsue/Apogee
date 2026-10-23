// Runs the real sw.js in a sandbox with fake caches, fake network, fake clients
// and fake events, so each rule of the worker can be checked without a browser.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SW_SOURCE = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

const SCOPE = "https://example.test/Apogee/";
const FILES = ["./index.html", "./manifest.webmanifest", "./src/ui/app.css", "./src/ui/main.js", "./icons/icon-180.png"];
const url = (file) => new URL(file, SCOPE).href;

class FakeResponse {
  constructor(body) {
    this.body = body;
  }
}
class FakeRequest {
  constructor(address, init = {}) {
    this.url = address;
    this.init = init;
    this.method = "GET";
  }
}

// The worker's world. `caches` maps a cache name to the URLs it holds.
function createWorld({ version = "v2", files = FILES, caches = {}, failing = [], clients = {} } = {}) {
  const listeners = {};
  const log = { skipWaiting: 0, claim: 0, fetched: [], addAll: [], deleted: [], imported: [] };
  const store = new Map(Object.entries(caches).map(([name, urls]) => [name, new Map(urls.map((u) => [u, new FakeResponse(`${name}:${u}`)]))]));
  let offline = false;

  const cacheApi = {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      return {
        async addAll(requests) {
          log.addAll.push({ name, requests });
          const fetched = [];
          for (const request of requests) {
            if (failing.includes(request.url)) throw new TypeError(`network error for ${request.url}`);
            fetched.push([request.url, new FakeResponse(`fresh:${request.url}`)]);
          }
          for (const [address, response] of fetched) store.get(name).set(address, response); // all or nothing, like the browser
        },
        async keys() {
          return [...store.get(name).keys()].map((address) => ({ url: address }));
        },
      };
    },
    async has(name) {
      return store.has(name);
    },
    async delete(name) {
      log.deleted.push(name);
      return store.delete(name);
    },
    async keys() {
      return [...store.keys()];
    },
    async match(request, options = {}) {
      const address = typeof request === "string" ? request : request.url;
      return store.get(options.cacheName)?.get(address);
    },
  };

  const self = {
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    location: new URL(SCOPE),
    registration: { scope: SCOPE },
    skipWaiting() {
      log.skipWaiting += 1;
      return Promise.resolve();
    },
    clients: {
      async claim() {
        log.claim += 1;
      },
      async get(id) {
        if (!(id in clients)) return undefined;
        if (clients[id] instanceof Error) throw clients[id];
        return clients[id];
      },
    },
  };
  const sandbox = {
    self,
    caches: cacheApi,
    Request: FakeRequest,
    URL,
    Promise,
    fetch: async (request) => {
      const address = typeof request === "string" ? request : request.url;
      log.fetched.push(address);
      if (offline) throw new TypeError("offline");
      return new FakeResponse(`network:${address}`);
    },
    importScripts(file) {
      log.imported.push(file);
      self.APOGEE_PRECACHE = { version, files };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: "sw.js" });

  // Delivers an event to the worker and reports what it did with it.
  async function dispatch(type, props = {}) {
    const waits = [];
    let answer;
    let answered = false;
    const event = {
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => {
        answered = true;
        answer = Promise.resolve(promise);
      },
      ...props,
    };
    listeners[type](event);
    let error = null;
    try {
      await Promise.all(waits);
    } catch (caught) {
      error = caught;
    }
    return { answered, response: answered ? await answer : undefined, error };
  }
  const request = (address, extra = {}) => ({ url: address, method: "GET", mode: "cors", ...extra });
  const navigation = (address) => request(address, { mode: "navigate" });

  return {
    log,
    store,
    dispatch,
    request,
    navigation,
    fetch: (req, props = {}) => dispatch("fetch", { request: req, ...props }),
    setOffline: (value) => {
      offline = value;
    },
    cacheName: `apogee-precache-${version}`,
  };
}

const appClient = { url: `${SCOPE}?sw=1` };
const testsClient = { url: `${SCOPE}tests/browser/index.html` };
const outsiderClient = { url: "https://example.test/other-site/page.html" };

// ---- install ----

test("sw: it takes its file list from the generated manifest and imports nothing else", () => {
  const world = createWorld();
  assert.deepEqual(world.log.imported, ["./sw-manifest.js"]);
});

test("sw install: caches every listed file, by absolute address, bypassing the HTTP cache, in a cache named for the version", async () => {
  const world = createWorld({ version: "abc" });
  const result = await world.dispatch("install");
  assert.equal(result.error, null);
  assert.equal(world.log.addAll.length, 1);
  assert.equal(world.log.addAll[0].name, "apogee-precache-abc");
  assert.deepEqual(world.log.addAll[0].requests.map((r) => r.url), FILES.map(url));
  assert.ok(world.log.addAll[0].requests.every((r) => r.init.cache === "reload"));
  assert.deepEqual([...world.store.get("apogee-precache-abc").keys()], FILES.map(url));
});

test("sw install: never activates itself (no skipWaiting, no claim) so the new version waits", async () => {
  const world = createWorld();
  await world.dispatch("install");
  assert.equal(world.log.skipWaiting, 0);
  assert.equal(world.log.claim, 0);
});

test("sw install: if any one file cannot be cached the install fails, and the old cache and no half-made new one remain", async () => {
  const old = { "apogee-precache-v1": FILES.map(url) };
  for (const bad of FILES) {
    const world = createWorld({ version: "v2", caches: old, failing: [url(bad)] });
    const result = await world.dispatch("install");
    assert.ok(result.error instanceof TypeError, `install must fail when ${bad} fails`);
    assert.ok(!world.store.has("apogee-precache-v2"), "no partial cache of the new version is left behind");
    assert.deepEqual([...world.store.get("apogee-precache-v1").keys()], FILES.map(url), "the old cache is exactly as it was");
    assert.equal(world.log.skipWaiting, 0);
  }
});

test("sw install: starts the version's cache from empty, so nothing stale from an earlier try survives", async () => {
  const world = createWorld({ version: "v2", caches: { "apogee-precache-v2": [url("./leftover.js"), url("./index.html")] } });
  await world.dispatch("install");
  assert.deepEqual([...world.store.get("apogee-precache-v2").keys()], FILES.map(url));
});

// ---- activate ----

test("sw activate: deletes older caches of this app, and only those, and takes over unclaimed pages", async () => {
  const world = createWorld({
    version: "v3",
    caches: {
      "apogee-precache-v1": [], "apogee-precache-v2": [], "apogee-precache-v3": FILES.map(url),
      "other-site-cache": [url("./x")], "workbox-precache-v2-https://example.test/": [], "apogee-precache": [], "my-apogee-precache-v1": [],
    },
  });
  const result = await world.dispatch("activate");
  assert.equal(result.error, null);
  assert.deepEqual([...world.store.keys()].sort(), [
    "apogee-precache", "apogee-precache-v3", "my-apogee-precache-v1", "other-site-cache", "workbox-precache-v2-https://example.test/",
  ]);
  assert.deepEqual(world.log.deleted.sort(), ["apogee-precache-v1", "apogee-precache-v2"]);
  assert.equal(world.log.claim, 1);
  assert.equal(world.log.skipWaiting, 0);
});

// ---- messages ----

test("sw message: SKIP_WAITING from a page of the app activates the waiting worker, once per message", async () => {
  const world = createWorld();
  await world.dispatch("message", { data: { type: "SKIP_WAITING" }, source: appClient });
  assert.equal(world.log.skipWaiting, 1);
});

test("sw message: SKIP_WAITING is ignored from other sites, from test pages, from nobody, and when malformed", async () => {
  const world = createWorld();
  await world.dispatch("message", { data: { type: "SKIP_WAITING" }, source: outsiderClient });
  await world.dispatch("message", { data: { type: "SKIP_WAITING" }, source: testsClient });
  await world.dispatch("message", { data: { type: "SKIP_WAITING" }, source: null });
  await world.dispatch("message", { data: { type: "SKIP_WAITING" }, source: { url: 5 } });
  for (const data of [null, undefined, "SKIP_WAITING", 7, {}, { type: "skip_waiting" }, { type: "SOMETHING_ELSE" }]) {
    await world.dispatch("message", { data, source: appClient });
  }
  assert.equal(world.log.skipWaiting, 0);
});

test("sw message: GET_VERSION answers on the given port with the version and file count, to the app only", async () => {
  const world = createWorld({ version: "v9" });
  const replies = [];
  const port = { postMessage: (message) => replies.push(message) };
  await world.dispatch("message", { data: { type: "GET_VERSION" }, source: appClient, ports: [port] });
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ version: "v9", fileCount: FILES.length }]); // made inside the sandbox, so compare as plain data
  await world.dispatch("message", { data: { type: "GET_VERSION" }, source: outsiderClient, ports: [port] });
  await world.dispatch("message", { data: { type: "GET_VERSION" }, source: appClient, ports: [] });
  await world.dispatch("message", { data: { type: "GET_VERSION" }, source: appClient });
  assert.equal(replies.length, 1);
});

// ---- fetch: what it leaves alone ----

test("sw fetch: ignores anything that is not a same-origin GET for a listed file", async () => {
  const world = createWorld({ caches: { "apogee-precache-v2": FILES.map(url) } });
  const ignored = [
    world.request(url("./index.html"), { method: "POST" }),
    world.request(url("./src/ui/main.js"), { method: "PUT" }),
    world.request("https://elsewhere.test/Apogee/src/ui/main.js"),
    world.request(url("./src/ui/not-listed.js")),
    world.request(url("./sw.js")),
    world.request(url("./sw-manifest.js")),
    world.request(url("./src/ui/main.js?cache-bust=1")),
    world.request(url("./tests/browser/run.js")),
    world.request(`${SCOPE.replace("example.test", "example.test:8443")}src/ui/main.js`),
  ];
  for (const req of ignored) {
    const result = await world.fetch(req);
    assert.equal(result.answered, false, `should not answer ${req.method} ${req.url}`);
  }
  assert.deepEqual(world.log.fetched, [], "the worker made no request of its own");
});

// ---- fetch: listed files ----

test("sw fetch: a listed file is answered from the cache without touching the network", async () => {
  const world = createWorld({ caches: { "apogee-precache-v2": FILES.map(url) } });
  for (const file of FILES) {
    const result = await world.fetch(world.request(url(file)), { clientId: "app" });
    assert.equal(result.answered, true);
    assert.equal(result.response.body, `apogee-precache-v2:${url(file)}`);
  }
  assert.deepEqual(world.log.fetched, []);
});

test("sw fetch: it works with no network at all", async () => {
  const world = createWorld({ caches: { "apogee-precache-v2": FILES.map(url) } });
  world.setOffline(true);
  const result = await world.fetch(world.request(url("./src/ui/main.js")), { clientId: "app" });
  assert.equal(result.response.body, `apogee-precache-v2:${url("./src/ui/main.js")}`);
  assert.equal(result.error, null);
});

test("sw fetch: if the cache lacks the file (it was evicted) the network is asked, once", async () => {
  const world = createWorld({ caches: {} });
  const result = await world.fetch(world.request(url("./src/ui/main.js")), { clientId: "app" });
  assert.equal(result.response.body, `network:${url("./src/ui/main.js")}`);
  assert.deepEqual(world.log.fetched, [url("./src/ui/main.js")]);
});

test("sw fetch: only the current version's cache is used, never an older one", async () => {
  const world = createWorld({ version: "v2", caches: { "apogee-precache-v1": FILES.map(url), "other-site-cache": FILES.map(url) } });
  const result = await world.fetch(world.request(url("./src/ui/main.js")), { clientId: "app" });
  assert.equal(result.response.body, `network:${url("./src/ui/main.js")}`);
});

// ---- fetch: navigation ----

test("sw navigation: the app's own address, with or without index.html, a query or a hash, gets the cached index.html", async () => {
  const world = createWorld({ caches: { "apogee-precache-v2": FILES.map(url) } });
  world.setOffline(true);
  for (const address of [SCOPE, url("./index.html"), `${SCOPE}?sw=1`, `${SCOPE}index.html?x=1#top`]) {
    const result = await world.fetch(world.navigation(address));
    assert.equal(result.answered, true, address);
    assert.equal(result.response.body, `apogee-precache-v2:${url("./index.html")}`, address);
  }
  assert.deepEqual(world.log.fetched, []);
});

test("sw navigation: other pages under the app go to the network, and fall back to the cached app page when offline", async () => {
  const world = createWorld({ caches: { "apogee-precache-v2": FILES.map(url) } });
  const address = `${SCOPE}some/other/page`;
  const online = await world.fetch(world.navigation(address));
  assert.equal(online.response.body, `network:${address}`);
  world.setOffline(true);
  const offline = await world.fetch(world.navigation(address));
  assert.equal(offline.response.body, `apogee-precache-v2:${url("./index.html")}`);
});

test("sw navigation: test pages and pages outside the app are never touched", async () => {
  const world = createWorld({ caches: { "apogee-precache-v2": FILES.map(url) } });
  for (const address of [`${SCOPE}tests/browser/index.html`, `${SCOPE}tests/`, "https://example.test/other-site/", "https://elsewhere.test/Apogee/"]) {
    const result = await world.fetch(world.navigation(address));
    assert.equal(result.answered, false, address);
  }
  assert.deepEqual(world.log.fetched, []);
});

// ---- fetch: test pages always see the current files ----

test("sw fetch: a request from a test page goes to the network even though the file is cached, nested imports included", async () => {
  const world = createWorld({
    caches: { "apogee-precache-v2": FILES.map(url) },
    clients: { page: testsClient, app: appClient },
  });
  // every module a test page loads, including ones imported by other modules, carries the page's clientId
  for (const file of ["./src/ui/main.js", "./src/ui/app.css", "./src/ui/main.js"]) {
    const fromTests = await world.fetch(world.request(url(file)), { clientId: "page" });
    assert.equal(fromTests.response.body, `network:${url(file)}`, "test page: current file from the network");
    const fromApp = await world.fetch(world.request(url(file)), { clientId: "app" });
    assert.equal(fromApp.response.body, `apogee-precache-v2:${url(file)}`, "app page: installed copy from the cache");
  }
});

test("sw fetch: when the requesting page cannot be identified the installed copy is served", async () => {
  const world = createWorld({
    caches: { "apogee-precache-v2": FILES.map(url) },
    clients: { broken: new Error("client lookup failed") },
  });
  for (const props of [{}, { clientId: "" }, { clientId: "unknown-id" }, { clientId: "broken" }]) {
    const result = await world.fetch(world.request(url("./src/ui/main.js")), props);
    assert.equal(result.response.body, `apogee-precache-v2:${url("./src/ui/main.js")}`, JSON.stringify(props));
    assert.equal(result.error, null);
  }
});

test("sw fetch: a page of another site is not mistaken for a test page", async () => {
  const world = createWorld({
    caches: { "apogee-precache-v2": FILES.map(url) },
    clients: { stranger: { url: "https://example.test/other-site/tests/index.html" } },
  });
  const result = await world.fetch(world.request(url("./src/ui/main.js")), { clientId: "stranger" });
  assert.equal(result.response.body, `apogee-precache-v2:${url("./src/ui/main.js")}`);
});

// ---- the source itself ----

test("sw.js: skipWaiting appears once, in the message handler, and nowhere near install or activate", () => {
  assert.equal([...SW_SOURCE.matchAll(/skipWaiting\(/g)].length, 1);
  const handler = SW_SOURCE.slice(SW_SOURCE.indexOf('self.addEventListener("message"'), SW_SOURCE.indexOf("// Which page asked"));
  assert.ok(handler.includes("self.skipWaiting()"));
});
