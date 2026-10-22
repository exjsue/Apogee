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

const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

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
