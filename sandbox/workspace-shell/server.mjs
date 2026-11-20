import { randomBytes } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.AUTOFORUM_WORKSPACE_ROOT ?? "/workspace";
const PORT = Number(process.env.PORT ?? 8080);
const BUILD_ROOT = process.env.AUTOFORUM_SHELL_BUILD_ROOT ?? path.join(WORKSPACE, ".autoforum", "shell-build");
const INTERNAL_PREFIX = "/__autoforum_workspace/";
const require = createRequire(import.meta.url);
const reactResolutions = new Map([
  ["react", require.resolve("react")],
  ["react-dom", require.resolve("react-dom")],
  ["react-dom/client", require.resolve("react-dom/client")],
  ["react/jsx-runtime", require.resolve("react/jsx-runtime")],
  ["react/jsx-dev-runtime", require.resolve("react/jsx-dev-runtime")],
]);

let active = null;
let buildError = null;
let building = false;
let rebuildAgain = false;
let revision = 0;

function validSlug(value) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

async function insideWorkspace(candidate) {
  const root = await realpath(WORKSPACE);
  const resolved = await realpath(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("path_escaped_workspace");
  return resolved;
}

async function discoverPages() {
  const root = path.join(WORKSPACE, "pages");
  if (!existsSync(root)) return [];
  const pages = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validSlug(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const component = path.join(directory, "page.tsx");
    const descriptor = path.join(directory, "page.json");
    if (!existsSync(component) || !existsSync(descriptor)) continue;
    await insideWorkspace(component);
    const parsed = JSON.parse(await readFile(descriptor, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid pages/${entry.name}/page.json`);
    if (typeof parsed.title !== "string" || !parsed.title.trim() || parsed.title.length > 100) throw new Error(`Invalid title in pages/${entry.name}/page.json`);
    if (parsed.description !== undefined && (typeof parsed.description !== "string" || parsed.description.length > 240)) throw new Error(`Invalid description in pages/${entry.name}/page.json`);
    if (parsed.icon !== undefined && (typeof parsed.icon !== "string" || parsed.icon.length > 8)) throw new Error(`Invalid icon in pages/${entry.name}/page.json`);
    const server = path.join(directory, "server.ts");
    pages.push({
      slug: entry.name,
      title: parsed.title.trim(),
      description: parsed.description?.trim() ?? "",
      icon: parsed.icon?.trim() ?? "",
      component,
      server: existsSync(server) ? server : null,
    });
  }
  pages.sort((left, right) => left.title.localeCompare(right.title));
  return pages;
}

const reactPlugin = {
  name: "autoforum-react",
  setup(api) {
    api.onResolve({ filter: /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime)$/ }, (args) => ({ path: reactResolutions.get(args.path) }));
    api.onResolve({ filter: /^autoforum-shell-entry$/ }, () => ({ path: path.join(HERE, "shell-entry.jsx") }));
    api.onResolve({ filter: /^autoforum-shell-css$/ }, () => ({ path: path.join(HERE, "shell.css") }));
  },
};

const workspaceRequire = createRequire(path.join(WORKSPACE, "package.json"));
const workspacePackagesPlugin = {
  name: "autoforum-workspace-packages",
  setup(api) {
    api.onResolve({ filter: /^[^./]|^@/ }, (args) => {
      if (args.path.startsWith("node:")) return { path: args.path, external: true };
      try {
        const resolved = workspaceRequire.resolve(args.path);
        const moduleRoot = path.join(WORKSPACE, "modules") + path.sep;
        const pageRoot = path.join(WORKSPACE, "pages") + path.sep;
        if (resolved.startsWith(moduleRoot) || resolved.startsWith(pageRoot)) return { path: resolved };
      } catch {
        // Let esbuild report an unresolved workspace import normally.
      }
      return { path: args.path, external: true };
    });
  },
};

async function buildWorkspace() {
  if (building) {
    rebuildAgain = true;
    return;
  }
  building = true;
  do {
    rebuildAgain = false;
    const id = `${Date.now()}-${randomBytes(5).toString("hex")}`;
    const output = path.join(BUILD_ROOT, id);
    try {
      const pages = await discoverPages();
      await mkdir(output, { recursive: true });
      const imports = pages.map((page, index) => `import Page${index} from ${JSON.stringify(`./pages/${page.slug}/page.tsx`)};`).join("\n");
      const records = pages.map((page, index) => `{ slug: ${JSON.stringify(page.slug)}, title: ${JSON.stringify(page.title)}, description: ${JSON.stringify(page.description)}, icon: ${JSON.stringify(page.icon)}, component: Page${index} }`).join(",\n");
      // Styles are bundled in import order. The shell's stylesheet (Autoforum's design system, then the shell's own
      // chrome) goes first, so every page starts from the app's look and its own CSS, bundled after, can refine it.
      const entry = `import "autoforum-shell-css";\n${imports}\nimport { mountWorkspace } from "autoforum-shell-entry";\nmountWorkspace([${records}]);\n`;
      await build({
        absWorkingDir: WORKSPACE,
        stdin: { contents: entry, resolveDir: WORKSPACE, sourcefile: "autoforum-workspace-entry.jsx", loader: "jsx" },
        outfile: path.join(output, "app.js"),
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        jsx: "automatic",
        sourcemap: true,
        publicPath: INTERNAL_PREFIX,
        loader: { ".png": "file", ".jpg": "file", ".jpeg": "file", ".gif": "file", ".svg": "file", ".webp": "file", ".woff": "file", ".woff2": "file" },
        assetNames: "assets/[name]-[hash]",
        plugins: [reactPlugin],
        logLevel: "silent",
      });
      const handlers = new Map();
      for (const page of pages) {
        if (!page.server) continue;
        const outfile = path.join(output, `server-${page.slug}.mjs`);
        await build({ absWorkingDir: WORKSPACE, entryPoints: [page.server], outfile, bundle: true, format: "esm", platform: "node", target: "node22", sourcemap: true, packages: "external", external: ["node:*"], plugins: [workspacePackagesPlugin], logLevel: "silent" });
        const module = await import(`${pathToFileURL(outfile).href}?revision=${id}`);
        if (typeof module.default !== "function") throw new Error(`pages/${page.slug}/server.ts must default-export a request handler`);
        handlers.set(page.slug, module.default);
      }
      const previous = active?.directory;
      active = { directory: output, pages, handlers };
      buildError = null;
      revision += 1;
      if (previous) await rm(previous, { recursive: true, force: true }).catch(() => undefined);
      console.log(`Workspace shell built ${pages.length} page${pages.length === 1 ? "" : "s"}.`);
    } catch (error) {
      await rm(output, { recursive: true, force: true }).catch(() => undefined);
      buildError = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error("Workspace shell build failed; keeping the previous build.", error);
    }
  } while (rebuildAgain);
  building = false;
}

function contentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".css": "text/css; charset=utf-8", ".gif": "image/gif", ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".woff": "font/woff", ".woff2": "font/woff2",
  })[extension] ?? "application/octet-stream";
}

function send(res, status, body, type = "text/plain; charset=utf-8", method = "GET") {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { "content-type": type, "content-length": bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(method === "HEAD" ? undefined : bytes);
}

async function serveFile(res, filename, method) {
  try {
    const bytes = await readFile(filename);
    send(res, 200, bytes, contentType(filename), method);
  } catch (error) {
    if (error?.code === "ENOENT") send(res, 404, "Not found", undefined, method);
    else throw error;
  }
}

async function requestBody(req, maximum = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function runPageHandler(req, res, url, slug, handler) {
  const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await requestBody(req);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const relative = url.pathname.replace(`/api/pages/${slug}`, "") || "/";
  const request = new Request(`http://${req.headers.host ?? "workspace"}${relative}${url.search}`, {
    method: req.method,
    headers,
    body,
    duplex: body ? "half" : undefined,
  });
  const response = await handler(request);
  if (!(response instanceof Response)) throw new Error(`pages/${slug}/server.ts returned something other than a Response`);
  const responseHeaders = {};
  for (const [name, value] of response.headers) {
    if (!["connection", "content-length", "transfer-encoding"].includes(name.toLowerCase())) responseHeaders[name] = value;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, { ...responseHeaders, "content-length": bytes.length, "x-content-type-options": "nosniff" });
  res.end(req.method === "HEAD" ? undefined : bytes);
}

function shellHtml() {
  const stylesheet = active && existsSync(path.join(active.directory, "app.css")) ? `<link rel="stylesheet" href="${INTERNAL_PREFIX}app.css">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${stylesheet}<title>Project workspace</title></head><body><div id="root"></div><script type="module" src="${INTERNAL_PREFIX}app.js"></script></body></html>`;
}

async function handle(req, res) {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "workspace"}`);
    if (url.pathname === `${INTERNAL_PREFIX}status`) {
      const pages = active?.pages.map(({ slug, title, description, icon }) => ({ slug, title, description, icon })) ?? [];
      return send(res, 200, JSON.stringify({ revision, error: buildError, pages }), "application/json; charset=utf-8", req.method);
    }
    if (url.pathname.startsWith(INTERNAL_PREFIX)) {
      if (!active) return send(res, 503, buildError ?? "Workspace shell is still building.", undefined, req.method);
      const relative = decodeURIComponent(url.pathname.slice(INTERNAL_PREFIX.length));
      if (!relative || relative.includes("\\") || relative.split("/").includes("..")) return send(res, 400, "Invalid path", undefined, req.method);
      const filename = path.join(active.directory, ...relative.split("/"));
      if (filename !== active.directory && !filename.startsWith(`${active.directory}${path.sep}`)) return send(res, 400, "Invalid path", undefined, req.method);
      return await serveFile(res, filename, req.method);
    }
    const api = /^\/api\/pages\/([a-z0-9][a-z0-9-]{0,63})(?:\/|$)/.exec(url.pathname);
    if (api) {
      const handler = active?.handlers.get(api[1]);
      if (!handler) return send(res, 404, "Page API not found", undefined, req.method);
      return await runPageHandler(req, res, url, api[1], handler);
    }
    if (url.pathname.startsWith("/outputs/")) {
      if (!["GET", "HEAD"].includes(req.method ?? "GET")) return send(res, 405, "Method not allowed", undefined, req.method);
      const relative = decodeURIComponent(url.pathname.slice("/outputs/".length));
      if (!relative || relative.includes("\\") || relative.split("/").includes("..")) return send(res, 400, "Invalid path", undefined, req.method);
      const root = path.join(WORKSPACE, "outputs");
      const filename = path.join(root, ...relative.split("/"));
      if (!filename.startsWith(`${root}${path.sep}`)) return send(res, 400, "Invalid path", undefined, req.method);
      return await serveFile(res, filename, req.method);
    }
    if (!["GET", "HEAD"].includes(req.method ?? "GET")) return send(res, 405, "Method not allowed", undefined, req.method);
    if (!active) return send(res, 503, buildError ?? "Workspace shell is still building.", undefined, req.method);
    return send(res, 200, shellHtml(), "text/html; charset=utf-8", req.method);
  } catch (error) {
    console.error("Workspace shell request failed", error);
    const status = error?.message === "request_too_large" ? 413 : 500;
    return send(res, status, status === 413 ? "Request too large" : "Workspace request failed", undefined, req.method);
  }
}

await mkdir(BUILD_ROOT, { recursive: true });
await buildWorkspace();
for (const directory of ["pages", "modules"]) {
  const target = path.join(WORKSPACE, directory);
  if (!existsSync(target)) continue;
  watch(target, { recursive: true }, () => {
    clearTimeout(globalThis.__autoforumRebuildTimer);
    globalThis.__autoforumRebuildTimer = setTimeout(() => void buildWorkspace(), 180);
  });
}

http.createServer(handle).listen(PORT, "0.0.0.0", () => {
  console.log(`Autoforum workspace shell listening on 0.0.0.0:${PORT}`);
});
