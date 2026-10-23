// Tiny static file server for local use. Node built-ins only.
// Bound to 127.0.0.1, so other machines on the network cannot reach it.
// Serves index.html (at "/"), src/ and tests/, and nothing else. Dotfiles and
// anything outside those places are refused.
// Usage: node tools/serve.js
//
// The port is fixed on purpose. Browser storage (IndexedDB) belongs to an
// origin, and an origin includes the port: http://127.0.0.1:8080 and
// http://127.0.0.1:8081 are different origins with separate databases. If this
// server quietly moved to another port, the app would open with an empty
// database and your workouts would seem to be gone. So when the port is taken
// the server stops with a message instead of choosing another one.
// (An explicit port can still be given as an argument; that is your choice.)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const PORT = process.argv[2] === undefined ? DEFAULT_PORT : Number(process.argv[2]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVED_FOLDERS = ["src", "tests", "icons"];
const ROOT_FILES = ["index.html", "manifest.webmanifest", "sw.js", "sw-manifest.js"];
const TESTS_PATH = "/tests/browser/index.html";

// Blocks every network request from the page. Kept identical to the policy in
// the meta tag of index.html (a test checks that they match).
const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'";

// The service worker obeys the policy sent with ITS OWN script, not the page's.
// The page's policy has connect-src 'none', which would stop the worker from
// fetching the app's files to cache them. So sw.js gets this one instead: still
// nothing but this origin, and nothing else allowed.
const WORKER_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; connect-src 'self'";
const WORKER_SCRIPT = "sw.js";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Not a valid port: ${process.argv[2]}`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
};

function send(res, status, body, extra = {}) {
  res.writeHead(status, { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra });
  res.end(body);
}

// Returns the file path to serve, or { status } when the request is refused.
function resolveRequest(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(rawUrl.split(/[?#]/)[0]);
  } catch {
    return { status: 400 };
  }
  if (/[\0\\:]/.test(pathname)) return { status: 403 };
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return { file: path.join(ROOT, "index.html") };
  if (segments.some((segment) => segment.startsWith("."))) return { status: 403 }; // dotfiles and ".."
  if (segments.length === 1 && ROOT_FILES.includes(segments[0])) return { file: path.join(ROOT, segments[0]) };
  if (!SERVED_FOLDERS.includes(segments[0])) return { status: 403 };
  const file = path.join(ROOT, ...segments);
  const folder = path.join(ROOT, segments[0]) + path.sep;
  if (!file.startsWith(folder)) return { status: 403 };
  return { file };
}

function hostAllowed(hostHeader) {
  const port = server.address().port;
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
    return;
  }
  // Refuse requests that arrive under another hostname (DNS rebinding).
  if (!hostAllowed(req.headers.host)) {
    send(res, 403, "Forbidden");
    return;
  }
  const resolved = resolveRequest(req.url);
  if (resolved.status) {
    send(res, resolved.status, resolved.status === 400 ? "Bad request" : "Forbidden");
    return;
  }
  let file = resolved.file;
  let stat;
  try {
    stat = fs.statSync(file);
    if (stat.isDirectory()) {
      file = path.join(file, "index.html");
      stat = fs.statSync(file);
    }
  } catch {
    send(res, 404, "Not found");
    return;
  }
  if (!stat.isFile()) {
    send(res, 404, "Not found");
    return;
  }
  const isWorkerScript = file === path.join(ROOT, WORKER_SCRIPT);
  res.writeHead(200, {
    ...HEADERS,
    ...(isWorkerScript ? { "Content-Security-Policy": WORKER_CONTENT_SECURITY_POLICY } : {}),
    "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": stat.size,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use, so the server did not start.\n`
      + "Close whatever is using it (often an earlier copy of this server) and run this again.\n"
      + "The port is not changed automatically: browser storage is separate for every port, "
      + "so the app would open with an empty database on a different one.",
    );
  } else {
    console.error(error.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`Apogee server running on port ${port}, 127.0.0.1 only. Press Ctrl+C to stop.`);
  console.log(`App:           http://127.0.0.1:${port}/`);
  console.log(`Browser tests: http://127.0.0.1:${port}${TESTS_PATH}`);
});
