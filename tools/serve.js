// Tiny static file server for local testing. Node built-ins only.
// Bound to 127.0.0.1, so other machines on the network cannot reach it.
// Serves only src/ and tests/ (the browser test page needs nothing else).
// Usage: node tools/serve.js [port]      (default port 8080)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVED_FOLDERS = ["src", "tests"];
const START_PATH = "/tests/browser/index.html";

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`Not a valid port: ${process.argv[2] ?? process.env.PORT}`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  // The page may load only from this same server: nothing external can load.
  "Content-Security-Policy": "default-src 'self'",
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
  if (segments.length === 0 || !SERVED_FOLDERS.includes(segments[0])) return { status: 403 };
  if (segments.some((segment) => segment.startsWith("."))) return { status: 403 }; // dotfiles and ".."
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
  if (req.url === "/") {
    send(res, 302, "", { Location: START_PATH });
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
  res.writeHead(200, {
    ...HEADERS,
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
  console.error(error.code === "EADDRINUSE"
    ? `Port ${PORT} is already in use. Try: node tools/serve.js ${PORT + 1}`
    : error.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`Serving src/ and tests/ on 127.0.0.1 only. Press Ctrl+C to stop.`);
  console.log(`Browser tests: http://127.0.0.1:${port}${START_PATH}`);
});
