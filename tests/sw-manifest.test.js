import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  DEFAULT_ROOT as ROOT,
  MANIFEST_FILE,
  buildManifest,
  findPrecacheFiles,
  manifestSource,
} from "../tools/build-sw-manifest.js";
import { CACHE_PREFIX } from "../src/app/offline.js";

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

// A copy of what the app is made of, so a test can change files without touching the real ones.
function withAppCopy(body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gymapp-sw-test-"));
  try {
    for (const entry of ["index.html", "manifest.webmanifest", "sw.js", "icons", "src"]) {
      fs.cpSync(path.join(ROOT, entry), path.join(directory, entry), { recursive: true });
    }
    return body(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// ---- the committed file is current ----

test("sw-manifest.js is exactly what tools/build-sw-manifest.js writes now (if this fails, run: node tools/build-sw-manifest.js)", () => {
  const committed = read(MANIFEST_FILE).replace(/\r\n/g, "\n");
  assert.equal(committed, manifestSource(buildManifest()));
});

test("sw-manifest.js, run as the worker runs it, defines the same version and file list the builder computes", () => {
  const sandbox = { self: {} };
  vm.createContext(sandbox);
  vm.runInContext(read(MANIFEST_FILE), sandbox);
  const expected = buildManifest();
  assert.equal(sandbox.self.GYMAPP_PRECACHE.version, expected.version);
  assert.deepEqual([...sandbox.self.GYMAPP_PRECACHE.files], expected.files);
  assert.match(sandbox.self.GYMAPP_PRECACHE.version, /^[0-9a-f]{64}$/);
});

// ---- the list is what the app really loads ----

// A second, independent way of finding what the app loads (different patterns
// from the builder's), so the builder cannot simply agree with itself.
function independentCrawl() {
  const found = new Set(["index.html"]);
  const html = read("index.html");
  for (const m of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) found.add(m[1].slice(2));
  const queue = [...html.matchAll(/<script[^>]*src="\.\/([^"]+)"/g)].map((m) => m[1]);
  const visited = new Set();
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    found.add(file);
    for (const m of read(file).matchAll(/\b(?:from|import)\s*\(?\s*(["'])(\.{1,2}\/[^"']+)\1/g)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2])));
    }
  }
  for (const icon of JSON.parse(read("manifest.webmanifest")).icons) found.add(path.posix.normalize(icon.src));
  return [...found].sort();
}

test("the precache list equals what index.html, main.js and everything they import actually load", () => {
  const listed = buildManifest().files.map((file) => file.replace(/^\.\//, ""));
  assert.deepEqual(listed, independentCrawl());
});

test("the precache list has the app, its modules, the stylesheet, the manifest and all three icons", () => {
  const listed = buildManifest().files;
  for (const required of [
    "./index.html", "./manifest.webmanifest", "./src/ui/main.js", "./src/ui/app.js", "./src/ui/app.css",
    "./src/app/offline.js", "./src/storage/idb-adapter.js", "./src/domain/model.js",
    "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png",
  ]) {
    assert.ok(listed.includes(required), `missing ${required}`);
  }
});

test("the precache list leaves out tests, tools, docs, the worker itself and code the app never loads", () => {
  const listed = buildManifest().files;
  for (const file of listed) {
    assert.ok(!/^\.\/(tests|tools)\//.test(file), file);
    assert.ok(!/\.md$/.test(file), file);
  }
  for (const excluded of ["./sw.js", "./sw-manifest.js", "./package.json", "./src/storage/memory-adapter.js", "./.gitignore", "./.nojekyll"]) {
    assert.ok(!listed.includes(excluded), `should not list ${excluded}`);
  }
});

test("every listed path is relative, sorted, unique, starts with ./ and names a file that exists", () => {
  const listed = buildManifest().files;
  assert.deepEqual(listed, [...listed].sort());
  assert.equal(new Set(listed).size, listed.length);
  for (const file of listed) {
    assert.match(file, /^\.\/[A-Za-z0-9._\-/]+$/);
    assert.ok(!file.includes(".."), file);
    assert.ok(fs.statSync(path.join(ROOT, file)).isFile(), file);
  }
  assert.ok(!/https?:/.test(read(MANIFEST_FILE)), "no URLs in the generated file");
});

test("findPrecacheFiles gives the same list without the leading ./", () => {
  assert.deepEqual(findPrecacheFiles().map((file) => `./${file}`), buildManifest().files);
});

// ---- the version ----

test("the version is the same for an identical copy, and ignores line endings in text files", () => {
  const real = buildManifest().version;
  withAppCopy((copy) => {
    assert.equal(buildManifest(copy).version, real);
    const css = path.join(copy, "src", "ui", "app.css");
    fs.writeFileSync(css, fs.readFileSync(css, "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));
    assert.equal(buildManifest(copy).version, real, "CRLF must not change the version");
  });
});

test("the version changes when any listed file changes: a module, the stylesheet, the page, an icon", () => {
  const real = buildManifest().version;
  for (const file of ["src/domain/model.js", "src/ui/app.css", "index.html", "icons/icon-512.png", "manifest.webmanifest"]) {
    withAppCopy((copy) => {
      const target = path.join(copy, file);
      if (file.endsWith(".png")) fs.appendFileSync(target, Buffer.from([0]));
      else fs.appendFileSync(target, "\n");
      assert.notEqual(buildManifest(copy).version, real, `changing ${file} must change the version`);
    });
  }
});

test("the version also changes when the worker itself changes, and not when an unlisted file does", () => {
  const real = buildManifest().version;
  withAppCopy((copy) => {
    fs.appendFileSync(path.join(copy, "sw.js"), "\n// changed\n");
    assert.notEqual(buildManifest(copy).version, real);
  });
  withAppCopy((copy) => {
    fs.writeFileSync(path.join(copy, "src", "storage", "memory-adapter.js"), "// not loaded by the app\n");
    fs.writeFileSync(path.join(copy, "notes.md"), "not part of the app\n");
    assert.equal(buildManifest(copy).version, real);
  });
});

// ---- the builder refuses inputs that would produce a wrong list ----

test("the builder fails loudly if a referenced file is missing", () => {
  withAppCopy((copy) => {
    fs.rmSync(path.join(copy, "src", "ui", "app.css"));
    assert.throws(() => buildManifest(copy), /app\.css.*does not exist/);
  });
  withAppCopy((copy) => {
    fs.rmSync(path.join(copy, "icons", "icon-192.png"));
    assert.throws(() => buildManifest(copy), /icon-192\.png.*does not exist/);
  });
});

test("the builder fails if the page or a module uses a path that is not relative", () => {
  withAppCopy((copy) => {
    const page = path.join(copy, "index.html");
    fs.writeFileSync(page, fs.readFileSync(page, "utf8").replace('href="./src/ui/app.css"', 'href="/src/ui/app.css"'));
    assert.throws(() => buildManifest(copy), /must be relative/);
  });
  withAppCopy((copy) => {
    fs.appendFileSync(path.join(copy, "src", "ui", "dom.js"), '\nimport "some-package";\n');
    assert.throws(() => buildManifest(copy), /every import in the app must be relative/);
  });
});

// ---- the worker and the page agree ----

test("sw.js loads exactly the generated file, and uses the same cache prefix as the page's offline code", () => {
  const worker = read("sw.js");
  assert.deepEqual([...worker.matchAll(/importScripts\(([^)]*)\)/g)].map((m) => m[1]), ['"./sw-manifest.js"']);
  assert.ok(worker.includes(`const CACHE_PREFIX = "${CACHE_PREFIX}";`), "the prefix in sw.js and in offline.js must match");
});
