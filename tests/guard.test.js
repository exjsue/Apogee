// Guard: the shipped page (index.html and everything under src/) must not
// contain code or markup that could reach the network, inject markup, run
// strings as code or style elements inline. The allowlist starts empty; adding
// to it needs the owner's approval.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'";

// pattern -> why it is forbidden
const FORBIDDEN = [
  [/\bfetch\s*\(/, "fetch( can make network requests"],
  [/XMLHttpRequest/, "XMLHttpRequest can make network requests"],
  [/WebSocket/, "WebSocket opens network connections"],
  [/EventSource/, "EventSource opens network connections"],
  [/sendBeacon/, "sendBeacon sends data to a server"],
  [/importScripts/, "importScripts loads scripts"],
  [/innerHTML/, "innerHTML parses strings as markup"],
  [/outerHTML/, "outerHTML parses strings as markup"],
  [/insertAdjacentHTML/, "insertAdjacentHTML parses strings as markup"],
  [/\beval\s*\(/, "eval( runs strings as code"],
  [/new\s+Function\b/, "new Function runs strings as code"],
  [/document\s*\.\s*write/, "document.write injects markup"],
  [/https?:\/\//, "an http(s) URL"],
  [/createElement\(\s*["'](script|link|iframe|object|embed|img|style)["']/, "creating a script, link, frame, image or style element"],
  [/\.style\b|setAttribute\(\s*["']style["']|cssText/, "inline styles (use a CSS class)"],
];

// Returns "line N: reason" for every forbidden pattern found in the text.
export function scanText(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    for (const [pattern, reason] of FORBIDDEN) {
      if (pattern.test(line)) found.push(`line ${index + 1}: ${reason}`);
    }
  });
  return found;
}

// Problems in an HTML page: off-origin or inline scripts, stylesheets and
// links, inline styles, event-handler attributes.
export function scanHtml(html) {
  const found = [];
  const offOrigin = (value) => value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value);
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(attributes);
    if (!src) found.push("an inline script");
    else if (offOrigin(src[1])) found.push(`a script pointing off-origin (${src[1]})`);
    if (body.trim() !== "") found.push("a script with inline code");
  }
  for (const [, attributes] of html.matchAll(/<link\b([^>]*)>/gi)) {
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(attributes);
    if (href && offOrigin(href[1]) && !href[1].startsWith("data:")) found.push(`a link pointing off-origin (${href[1]})`);
  }
  if (/<style\b/i.test(html)) found.push("a style element");
  if (/\sstyle\s*=/i.test(html)) found.push("an inline style attribute");
  if (/\son[a-z]+\s*=/i.test(html)) found.push("an inline event-handler attribute");
  if (/<(iframe|object|embed|form)\b/i.test(html)) found.push("an iframe, object, embed or form element in the page");
  return found;
}

function filesUnder(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else files.push(full);
  }
  return files;
}

const shipped = () => [path.join(ROOT, "index.html"), ...filesUnder(path.join(ROOT, "src"))];

test("guard: index.html and src/ contain nothing that reaches the network or injects markup", () => {
  const problems = [];
  const files = shipped();
  assert.ok(files.length > 10, "expected to scan the whole of src/");
  for (const file of files) {
    const relative = path.relative(ROOT, file).replaceAll("\\", "/");
    const text = fs.readFileSync(file, "utf8");
    for (const finding of scanText(text)) problems.push(`${relative} ${finding}`);
    if (file.endsWith(".html")) for (const finding of scanHtml(text)) problems.push(`${relative}: ${finding}`);
  }
  assert.deepEqual(problems, []);
});

test("guard: index.html loads only local files and has no inline script or style", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.deepEqual(scanHtml(html), []);
  assert.match(html, /<script type="module" src="\.\/src\/ui\/main\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/src\/ui\/app\.css">/);
});

test("guard: index.html carries the content security policy that blocks all network access", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.ok(meta, "no Content-Security-Policy meta tag");
  assert.equal(meta[1], CONTENT_SECURITY_POLICY);
  // the policy must come before anything that loads
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script"));
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<link"));
});

test("guard: the server sends the same policy as the page's meta tag", () => {
  const source = fs.readFileSync(path.join(ROOT, "tools", "serve.js"), "utf8");
  const header = /const CONTENT_SECURITY_POLICY = "([^"]*)";/.exec(source);
  assert.ok(header, "serve.js has no CONTENT_SECURITY_POLICY constant");
  assert.equal(header[1], CONTENT_SECURITY_POLICY);
});

test("guard: the scanner flags every forbidden pattern (it would catch a violation)", () => {
  const samples = [
    "const r = fetch(url);", "new XMLHttpRequest()", "new WebSocket(x)", "new EventSource(x)",
    "navigator.sendBeacon(u, d)", "importScripts('a.js')", "el.innerHTML = x", "el.outerHTML = x",
    "el.insertAdjacentHTML('beforeend', x)", "eval(code)", "new Function('return 1')", "document.write(x)",
    "const u = 'https://example.com'", "const u = 'http://example.com'",
    "document.createElement('script')", 'document.createElement("link")', "document.createElement('img')",
    "el.style.color = 'red'", "el.setAttribute('style', 'x')", "el.style.cssText = 'x'",
  ];
  for (const sample of samples) assert.ok(scanText(sample).length > 0, `not flagged: ${sample}`);
  // ordinary code is not flagged, including words that merely contain a pattern
  for (const fine of ["const retrieval = 1;", "prefetchedNothing()", "element.append(child)", "el.textContent = x"]) {
    assert.deepEqual(scanText(fine), [], fine);
  }
});

test("guard: the HTML scanner flags off-origin and inline content", () => {
  const bad = [
    '<script src="https://cdn.example/x.js"></script>',
    '<script src="//cdn.example/x.js"></script>',
    "<script>alert(1)</script>",
    '<script type="module">import "./a.js"</script>',
    '<link rel="stylesheet" href="https://fonts.example/f.css">',
    '<link rel="stylesheet" href="//fonts.example/f.css">',
    "<style>body{}</style>",
    '<div style="color:red"></div>',
    '<button onclick="go()">x</button>',
    '<iframe src="./a.html"></iframe>',
    '<form action="./x"></form>',
  ];
  for (const html of bad) assert.ok(scanHtml(html).length > 0, `not flagged: ${html}`);
  const good = '<script type="module" src="./src/ui/main.js"></script><link rel="icon" href="data:,"><link rel="stylesheet" href="./a.css">';
  assert.deepEqual(scanHtml(good), []);
});

// ---- the app's real database name ----
//
// Only src/ui/main.js may open the app's real database. No test may import or
// use APP_DB_NAME, and none may pass the exact string apogee as a database name:
// a test that did could open, clear or delete a person's real data when the
// test page runs on the same origin as the app.
//
// What is flagged is exact: the identifier APP_DB_NAME, or the exact string
// apogee between matching quotes. Longer names such as apogee-storage-test or
// apogee-export-2026.json are different names and are not flagged.

const APP_DB_IDENTIFIER = /\bAPP_DB_NAME\b/;
const REAL_DB_LITERAL = /(["'`])apogee\1/;

// Returns "line N: reason" for each use of the real database name in the text.
export function scanForRealDatabase(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    if (APP_DB_IDENTIFIER.test(line)) found.push(`line ${index + 1}: uses APP_DB_NAME`);
    if (REAL_DB_LITERAL.test(line)) found.push(`line ${index + 1}: names the app's real database as a quoted string`);
  });
  return found;
}

test("guard: nothing under tests/ uses the app's real database name", () => {
  const problems = [];
  const own = path.join(ROOT, "tests", "guard.test.js"); // has to name what it forbids
  const files = filesUnder(path.join(ROOT, "tests")).filter((file) => file !== own);
  assert.ok(files.length >= 15, "expected to scan the whole of tests/ (16 files, 15 without this one)");
  for (const file of files) {
    for (const finding of scanForRealDatabase(fs.readFileSync(file, "utf8"))) {
      problems.push(`${path.relative(ROOT, file).replaceAll("\\", "/")} ${finding}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("guard: the database scanner flags the real name and not the names that merely contain it", () => {
  const violations = [
    'createIdbAdapter({ name: "apogee" })',
    "createIdbAdapter({ name: 'apogee' })",
    "indexedDB.open(`apogee`, 1)",
    'await deleteDatabase("apogee");',
    'const DB_NAME = "apogee";',
    'import { APP_DB_NAME } from "../src/storage/schema.js";',
    "createIdbAdapter({ name: APP_DB_NAME })",
    "const name = schema.APP_DB_NAME;",
  ];
  for (const sample of violations) assert.ok(scanForRealDatabase(sample).length > 0, `not flagged: ${sample}`);

  const legitimate = [
    'const DB_NAME = "apogee-storage-test";',
    "createIdbAdapter({ name: 'apogee-storage-test' })",
    "indexedDB.open(`apogee-storage-test`)",
    'await deleteDatabase("apogee-storage-test");',
    'app: "apogee-export",',
    'assert.equal(doc.app, "apogee-export");',
    'const file = "apogee-export-2026-10-22.json";',
    "the file apogee-export-*.json is ignored",
    '"apogee-"', '"my-apogee"', '"apogee2"', '"Apogee"', '"APOGEE"', '" apogee"', '"apogee "',
    "mixed quotes \"apogee' are not one string",
    "const APP_DB_NAMES = [];", "const MY_APP_DB_NAME = 1;",
  ];
  for (const sample of legitimate) assert.deepEqual(scanForRealDatabase(sample), [], `wrongly flagged: ${sample}`);
});

test("guard: the app database name is defined once, in schema.js, and still reads apogee", () => {
  const schema = fs.readFileSync(path.join(ROOT, "src", "storage", "schema.js"), "utf8");
  assert.equal(schema.match(/export const APP_DB_NAME = "apogee";/g)?.length, 1);
  // the quoted name appears nowhere else in src/, and the constant only in schema.js and main.js
  const literal = [];
  const identifier = [];
  for (const file of filesUnder(path.join(ROOT, "src"))) {
    const relative = path.relative(ROOT, file).replaceAll("\\", "/");
    const text = fs.readFileSync(file, "utf8");
    if (REAL_DB_LITERAL.test(text)) literal.push(relative);
    if (APP_DB_IDENTIFIER.test(text)) identifier.push(relative);
  }
  assert.deepEqual(literal, ["src/storage/schema.js"]);
  assert.deepEqual(identifier.sort(), ["src/storage/schema.js", "src/ui/main.js"]);
});

test("guard: main.js opens the app database with the explicit name", () => {
  const main = fs.readFileSync(path.join(ROOT, "src", "ui", "main.js"), "utf8");
  assert.match(main, /import \{ APP_DB_NAME \} from "\.\.\/storage\/schema\.js";/);
  // The name comes first and is the constant; other options (the visible notices) may follow.
  assert.match(main, /createIdbAdapter\(\{\s*name: APP_DB_NAME\b/);
});

test("guard: no code in src/, tools/ or the browser test page calls createIdbAdapter without a name", () => {
  const problems = [];
  const folders = [path.join(ROOT, "src"), path.join(ROOT, "tools"), path.join(ROOT, "tests", "browser")];
  for (const file of folders.flatMap((folder) => filesUnder(folder))) {
    const text = fs.readFileSync(file, "utf8");
    if (/createIdbAdapter\(\s*\)/.test(text)) problems.push(path.relative(ROOT, file).replaceAll("\\", "/"));
  }
  assert.deepEqual(problems, []);
});

// ---- the service worker (sw.js) and its generated list (sw-manifest.js) ----
//
// The worker may only make same-origin requests, only inside its fetch handler,
// only for the request the browser gave it; it may cache only the generated
// list; it may never touch IndexedDB; and it may activate a waiting version
// only from the message handler. These checks read the source, structurally
// where they can (each handler is found by matching its braces), and a
// deliberate violation of each rule below proves the rule fires.

// Comments become spaces (same length, newlines kept), so indexes stay aligned.
const blankComments = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
// Whatever is inside quotes becomes spaces too, leaving only code.
const blankStrings = (text) => text.replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(m.length - 2) + m[m.length - 1]);

// The [start, end) of the body of `self.addEventListener("<type>", ...)`, or null.
function handlerSpan(noComments, code, type) {
  const start = new RegExp(`self\\.addEventListener\\(\\s*"${type}"`).exec(noComments);
  if (!start) return null;
  const open = code.indexOf("{", code.indexOf("=>", start.index));
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}" && --depth === 0) return { start: open, end: i };
  }
  return null;
}

export function scanServiceWorker(source) {
  const findings = [];
  const noComments = blankComments(source);
  const code = blankStrings(noComments);
  const inside = (span, index) => span !== null && index > span.start && index < span.end;
  const spans = Object.fromEntries(["install", "activate", "message", "fetch"].map((type) => [type, handlerSpan(noComments, code, type)]));

  if (/https?:\/\//i.test(source)) findings.push("contains an http(s) URL");
  if (/indexedDB|IDBFactory|IDBDatabase|IDBOpenDBRequest/i.test(source)) findings.push("refers to IndexedDB");
  for (const [pattern, what] of [
    [/XMLHttpRequest/, "uses XMLHttpRequest"], [/WebSocket/, "uses WebSocket"], [/EventSource/, "uses EventSource"],
    [/sendBeacon/, "uses sendBeacon"], [/\beval\s*\(/, "uses eval"], [/new\s+Function\b/, "uses new Function"],
    [/\bimport\s*\(/, "uses a dynamic import"], [/openWindow|showNotification|PushManager|periodicSync|BackgroundFetch/, "uses a notification, push, sync or window API"],
    [/\bself\.on[a-z]+\s*=/, "assigns an event handler property instead of addEventListener"],
  ]) {
    if (pattern.test(code)) findings.push(what);
  }

  // the one allowed script import: the generated list
  const imports = [...noComments.matchAll(/importScripts\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  if (imports.length !== 1 || imports[0] !== '"./sw-manifest.js"') findings.push(`importScripts is not exactly one call for "./sw-manifest.js" (${imports.join(" ; ") || "none"})`);

  // the only events it listens to
  for (const m of noComments.matchAll(/addEventListener\(\s*(["'])([^"']+)\1/g)) {
    if (!["install", "activate", "message", "fetch"].includes(m[2])) findings.push(`listens for "${m[2]}"`);
  }
  for (const [type, span] of Object.entries(spans)) if (span === null) findings.push(`has no ${type} handler`);

  // every use of fetch: inside the fetch handler, on the request itself, and not through an object
  for (const m of code.matchAll(/\bfetch\b/g)) {
    if (code[m.index - 1] === ".") findings.push("reaches fetch through an object");
    else if (!inside(spans.fetch, m.index)) findings.push("uses fetch outside the fetch handler");
    else if (!/^\s*\(\s*request\s*\)/.test(code.slice(m.index + 5))) findings.push("calls fetch with something other than the request");
  }
  if (spans.fetch) {
    const body = code.slice(spans.fetch.start, spans.fetch.end);
    const bodyWithStrings = noComments.slice(spans.fetch.start, spans.fetch.end);
    if (!/const request = event\.request;/.test(bodyWithStrings)) findings.push("the fetch handler does not take the request from the event");
    const answer = body.indexOf("respondWith(");
    const method = bodyWithStrings.search(/request\.method !== "GET"\) return;/);
    const origin = bodyWithStrings.search(/url\.origin !== self\.location\.origin\) return;/);
    if (method < 0 || (answer >= 0 && method > answer)) findings.push("has no GET-only check before answering");
    if (origin < 0 || (answer >= 0 && origin > answer)) findings.push("has no same-origin check before answering");
  }

  // what may be cached or deleted
  if (/\.\s*(put|add)\s*\(/.test(code)) findings.push("writes to a cache with put or add");
  const addAll = [...code.matchAll(/\.\s*addAll\s*\(/g)];
  if (addAll.length !== 1 || !inside(spans.install, addAll[0].index) || !/cache\.addAll\(files\.map\(/.test(noComments)) {
    findings.push("addAll is not used exactly once, in install, on the generated file list");
  }
  for (const m of noComments.matchAll(/caches\.open\(\s*([^)]*?)\s*\)/g)) if (m[1] !== "CACHE_NAME") findings.push(`opens a cache other than CACHE_NAME (${m[1]})`);
  for (const m of noComments.matchAll(/caches\.delete\(\s*([^)]*?)\s*\)/g)) if (!["CACHE_NAME", "name"].includes(m[1])) findings.push(`deletes a cache other than CACHE_NAME or an old one of this app (${m[1]})`);
  for (const m of noComments.matchAll(/caches\.match\(\s*([^,)]*)/g)) if (!["INDEX", "request"].includes(m[1].trim())) findings.push(`looks up something other than the request or INDEX (${m[1].trim()})`);

  // activation of a waiting version and takeover of pages
  const skips = [...code.matchAll(/\bskipWaiting\s*\(/g)];
  if (skips.length !== 1 || !inside(spans.message, skips[0].index)) findings.push("skipWaiting is not called exactly once, in the message handler");
  const claims = [...code.matchAll(/\bclients\.claim\s*\(/g)];
  if (claims.length !== 1 || !inside(spans.activate, claims[0].index)) findings.push("clients.claim is not called exactly once, in the activate handler");

  // messages out: only the reply on the port that came with the request
  for (const m of code.matchAll(/\.postMessage\s*\(/g)) {
    if (!code.slice(Math.max(0, m.index - 20), m.index).endsWith("event.ports[0]")) findings.push("posts a message somewhere other than the reply port");
  }
  return findings;
}

// The generated list must be plain data: one assignment, relative paths only.
export function scanGeneratedManifest(text) {
  const findings = [];
  if (/https?:\/\//i.test(text)) findings.push("contains an http(s) URL");
  if (/\b(fetch|indexedDB|importScripts|eval)\b/i.test(blankComments(text))) findings.push("contains code other than the list");
  const shape = /^\/\/ GENERATED[^\n]*\n\/\/ [^\n]*\nself\.APOGEE_PRECACHE = \{\n  version: "[0-9a-f]{64}",\n  files: \[\n(?:    "\.\/[A-Za-z0-9._\-/]+",\n)+  \],\n\};\n$/;
  if (!shape.test(text.replace(/\r\n/g, "\n"))) findings.push("is not exactly a generated list of relative paths");
  return findings;
}

const readRoot = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

test("guard: sw.js obeys every rule for the service worker", () => {
  assert.deepEqual(scanServiceWorker(readRoot("sw.js")), []);
});

test("guard: sw-manifest.js is plain data, a list of relative paths and a version", () => {
  assert.deepEqual(scanGeneratedManifest(readRoot("sw-manifest.js")), []);
});

// Each deliberate violation of sw.js, with the finding that must appear.
const REAL_WORKER = readRoot("sw.js");
const violations = [
  ["an outside request to a URL", (s) => s.replace('if (request.method !== "GET") return;', 'if (request.method !== "GET") return;\n  fetch("https://example.com/collect");'), /http\(s\) URL/],
  ["fetch on a string address", (s) => s.replace('if (request.method !== "GET") return;', 'if (request.method !== "GET") return;\n  fetch("./other.json");'), /something other than the request/],
  ["fetch on some other variable", (s) => s.replace("cached || fetch(request)", "cached || fetch(url)"), /something other than the request/],
  ["fetch outside the fetch handler", (s) => s.replace('importScripts("./sw-manifest.js");', 'importScripts("./sw-manifest.js");\nfetch(request);'), /outside the fetch handler/],
  ["fetch inside the install handler", (s) => s.replace("await caches.delete(CACHE_NAME);", "await caches.delete(CACHE_NAME);\n    fetch(request);"), /outside the fetch handler/],
  ["fetch reached through self", (s) => s.replace("cached || fetch(request)", "cached || self.fetch(request)"), /through an object/],
  ["fetch under another name", (s) => s.replace("const request = event.request;", "const request = event.request;\n  const f = fetch;"), /something other than the request/],
  ["a request that is not taken from the event", (s) => s.replace("const request = event.request;", "const request = new Request(event.request.url + '?x');"), /does not take the request from the event/],
  ["IndexedDB used", (s) => `${s}\nself.indexedDB.open("apogee");\n`, /IndexedDB/],
  ["IndexedDB mentioned in a comment", (s) => `${s}\n// opens indexedDB\n`, /IndexedDB/],
  ["a WebSocket", (s) => `${s}\nnew WebSocket("wss://x");\n`, /WebSocket/],
  ["XMLHttpRequest", (s) => `${s}\nnew XMLHttpRequest();\n`, /XMLHttpRequest/],
  ["sendBeacon", (s) => `${s}\nself.navigator.sendBeacon("./x");\n`, /sendBeacon/],
  ["eval", (s) => `${s}\neval("1");\n`, /eval/],
  ["new Function", (s) => `${s}\nnew Function("return 1");\n`, /new Function/],
  ["a dynamic import", (s) => `${s}\nimport("./x.js");\n`, /dynamic import/],
  ["a second importScripts", (s) => s.replace('importScripts("./sw-manifest.js");', 'importScripts("./sw-manifest.js");\nimportScripts("./other.js");'), /importScripts/],
  ["importScripts from another host", (s) => s.replace('importScripts("./sw-manifest.js");', 'importScripts("https://cdn.test/x.js");'), /importScripts/],
  ["a push listener", (s) => `${s}\nself.addEventListener("push", () => {});\n`, /listens for "push"/],
  ["a sync listener", (s) => `${s}\nself.addEventListener("sync", () => {});\n`, /listens for "sync"/],
  ["an event handler property", (s) => `${s}\nself.onsync = () => {};\n`, /event handler property/],
  ["opening a window", (s) => `${s}\nself.clients.openWindow("./");\n`, /notification, push, sync or window/],
  ["cache.put", (s) => `${s}\ncaches.open(CACHE_NAME).then((c) => c.put(request, new Response()));\n`, /put or add/],
  ["cache.add", (s) => `${s}\ncaches.open(CACHE_NAME).then((c) => c.add("./x"));\n`, /put or add/],
  ["addAll on something other than the list", (s) => s.replace("cache.addAll(files.map(", "cache.addAll(extra.concat(files).map("), /addAll/],
  ["a second addAll", (s) => `${s}\ncaches.open(CACHE_NAME).then((c) => c.addAll([]));\n`, /addAll/],
  ["opening a cache with another name", (s) => `${s}\ncaches.open("other");\n`, /opens a cache other than CACHE_NAME/],
  ["deleting another site's cache by name", (s) => `${s}\ncaches.delete("other-site-cache");\n`, /deletes a cache other than/],
  ["looking up another cache's contents", (s) => `${s}\ncaches.match(somethingElse);\n`, /looks up something other than/],
  ["skipWaiting in install", (s) => s.replace("await caches.delete(CACHE_NAME);", "await caches.delete(CACHE_NAME);\n    self.skipWaiting();"), /skipWaiting is not called exactly once/],
  ["skipWaiting removed from the message handler", (s) => s.replace("self.skipWaiting(); //", "void 0; //"), /skipWaiting is not called exactly once/],
  ["skipWaiting in the fetch handler", (s) => s.replace('if (request.method !== "GET") return;', 'if (request.method !== "GET") return;\n  self.skipWaiting();'), /skipWaiting is not called exactly once/],
  ["claim moved out of activate", (s) => s.replace("await self.clients.claim();", "void 0;"), /clients.claim/],
  ["no same-origin check", (s) => s.replace("if (url.origin !== self.location.origin) return;", ""), /no same-origin check/],
  ["same-origin check after answering", (s) => s.replace("if (url.origin !== self.location.origin) return;", "").replace("if (!PRECACHED.has(url.href)) return;", "if (!PRECACHED.has(url.href)) return;\n  if (url.origin !== self.location.origin) return;"), /no same-origin check/],
  ["no GET-only check", (s) => s.replace('if (request.method !== "GET") return;', ""), /no GET-only check/],
  ["a message sent to every page", (s) => `${s}\nself.clients.matchAll().then((all) => all.forEach((c) => c.postMessage("hi")));\n`, /reply port/],
  ["no fetch handler", (s) => s.replace('self.addEventListener("fetch"', 'self.addEventListener("fetched"'), /has no fetch handler/],
];

for (const [name, mutate, expected] of violations) {
  test(`guard: sw.js rule fires for ${name}`, () => {
    const mutated = mutate(REAL_WORKER);
    assert.notEqual(mutated, REAL_WORKER, "the deliberate violation must actually change the file");
    const findings = scanServiceWorker(mutated);
    assert.ok(findings.some((finding) => expected.test(finding)), `expected ${expected} in ${JSON.stringify(findings)}`);
  });
}

test("guard: the real sw.js is clean, so every violation above is caught for its own reason", () => {
  assert.deepEqual(scanServiceWorker(REAL_WORKER), []);
  assert.ok(violations.length >= 30);
});

test("guard: ordinary wording in comments and strings is not mistaken for a violation", () => {
  const harmless = `${REAL_WORKER}\n// we never call skipWaiting( here, nor fetch( something, nor eval(\nconst note = "fetch(request) and skipWaiting() in a string";\n`;
  assert.deepEqual(scanServiceWorker(harmless), []);
});

test("guard: the generated list scanner flags URLs, code and a wrong shape", () => {
  const real = readRoot("sw-manifest.js");
  assert.deepEqual(scanGeneratedManifest(real), []);
  assert.ok(scanGeneratedManifest(real.replace('"./index.html"', '"https://cdn.test/index.html"')).length > 0);
  assert.ok(scanGeneratedManifest(`${real}\nfetch("./x");\n`).length > 0);
  assert.ok(scanGeneratedManifest(real.replace("version:", "ver:")).length > 0);
  assert.ok(scanGeneratedManifest(real.replace('"./index.html"', '"/index.html"')).length > 0);
});

// The page-side code may say in a comment that it never touches IndexedDB; its
// code must not. (sw.js is stricter: it may not even mention the word.)
const touchesIndexedDB = (source) => /indexedDB|IDBFactory|IDBDatabase|IDBOpenDBRequest|IDBTransaction/i.test(blankComments(source));

test("guard: the page-side offline code never touches IndexedDB", () => {
  assert.equal(touchesIndexedDB(readRoot("src", "app", "offline.js")), false);
});

test("guard: the IndexedDB check on offline.js fires for real use and ignores comments", () => {
  const real = readRoot("src", "app", "offline.js");
  assert.equal(touchesIndexedDB(`${real}\nconst db = indexedDB.open("x");\n`), true);
  assert.equal(touchesIndexedDB(`${real}\nconst db = globalThis.indexedDB;\n`), true);
  assert.equal(touchesIndexedDB(`${real}\nnew IDBFactory();\n`), true);
  assert.equal(touchesIndexedDB(`${real}\n// never touches indexedDB\n`), false);
});

test("guard: the worker's own server policy allows this origin only, and is sent to sw.js alone", () => {
  const source = readRoot("tools", "serve.js");
  const worker = /const WORKER_CONTENT_SECURITY_POLICY = "([^"]*)";/.exec(source);
  assert.ok(worker, "serve.js has no WORKER_CONTENT_SECURITY_POLICY");
  assert.equal(worker[1], "default-src 'none'; script-src 'self'; connect-src 'self'");
  assert.ok(!/unsafe-|https?:|\*/.test(worker[1]));
  assert.match(source, /const WORKER_SCRIPT = "sw\.js";/);
  assert.match(source, /isWorkerScript \? \{ "Content-Security-Policy": WORKER_CONTENT_SECURITY_POLICY \} : \{\}/);
});

test("guard: the page's policy allows the manifest and the worker from this origin only", () => {
  assert.match(CONTENT_SECURITY_POLICY, /manifest-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /worker-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'none'/); // the page itself still makes no requests at all
});
