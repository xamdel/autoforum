import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const ROOT = "/workspace/artifacts";
const PORT = 8082;

const TYPES = new Map(Object.entries({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
}));

function fail(response, status, message) {
  const body = Buffer.from(`${message}\n`);
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function requestedFile(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl ?? "/", "http://artifact.invalid").pathname);
  if (pathname.includes("\\") || pathname.includes("\0")) throw new Error("not_found");
  const relative = pathname.replace(/^\/+/, "");
  const normalized = path.posix.normalize(relative || ".");
  if (normalized === ".." || normalized.startsWith("../")) throw new Error("not_found");

  let target = path.join(ROOT, ...normalized.split("/"));
  let information = await stat(target);
  if (information.isDirectory()) {
    target = path.join(target, "index.html");
    information = await stat(target);
  }
  if (!information.isFile()) throw new Error("not_found");

  const resolvedRoot = await realpath(ROOT);
  const resolved = await realpath(target);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("not_found");
  return { resolved, size: information.size };
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    fail(response, 405, "Method not allowed");
    return;
  }

  try {
    const file = await requestedFile(request.url);
    const handle = await open(file.resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const type = TYPES.get(path.extname(file.resolved).toLowerCase()) ?? "application/octet-stream";
    response.writeHead(200, {
      "content-type": type,
      "content-length": file.size,
      "cache-control": "no-store",
    });
    if (request.method === "HEAD") {
      await handle.close();
      response.end();
      return;
    }
    handle.createReadStream().on("error", () => response.destroy()).pipe(response);
  } catch {
    fail(response, 404, "Not found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Autoforum artifact server listening on ${PORT}`);
});
