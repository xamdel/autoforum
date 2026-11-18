import { randomBytes } from "node:crypto";
import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import path from "node:path";

import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono, type Context, type MiddlewareHandler } from "hono";

import { exactBrowserOrigin, hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import { generateSecret, hashSecret } from "../auth/secrets.ts";
import type { AppDatabase } from "../db.ts";
import {
  getProjectPreviewTarget,
  PREVIEW_RELAY_HEADER,
  type ProjectPreviewKind,
  type ProjectSandboxIdentity,
} from "../sandbox/lifecycle.ts";

const SECURE_COOKIE = "__Host-autoforum_preview";
const DEVELOPMENT_COOKIE = "autoforum_preview_dev";
const LAUNCH_LIFETIME_MS = 30_000;
const SESSION_LIFETIME_MS = 15 * 60_000;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 30_000;

interface Launch {
  project: ProjectSandboxIdentity;
  userId: number;
  host: string;
  origin: string;
  forumOrigin: string;
  target: PreviewTarget;
  kind: ProjectPreviewKind;
  initialPath: string;
  expiresAt: number;
}

interface Session extends Launch {
  expiresAt: number;
}

export interface PreviewTarget {
  host: string;
  port: number;
  relayToken: string;
}

export type PreviewTargetResolver = (project: ProjectSandboxIdentity, kind: ProjectPreviewKind) => Promise<PreviewTarget>;

function secretKey(secret: string): string {
  return hashSecret(secret).toString("hex");
}

function requestHost(context: Context): string {
  const header = context.req.header("host");
  if (!header) return new URL(context.req.url).hostname.toLowerCase();
  if (header.startsWith("[")) return header.slice(1, header.indexOf("]")).toLowerCase();
  return header.split(":", 1)[0]!.toLowerCase();
}

function configuredPreviewBase(context: Context): URL {
  const configured = process.env.PREVIEW_BASE_ORIGIN;
  if (configured) {
    const parsed = new URL(configured);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("invalid_preview_base_origin");
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") throw new Error("preview_https_required");
    return parsed;
  }
  if (process.env.NODE_ENV !== "production") return new URL("http://preview.autoforum.localhost:3000");
  const request = new URL(context.req.url);
  return new URL(`${request.protocol}//preview.${request.hostname}${request.port ? `:${request.port}` : ""}`);
}

export function previewFrameSource(): string {
  const base = new URL(process.env.PREVIEW_BASE_ORIGIN
    ?? (process.env.NODE_ENV === "production" ? "https://preview.invalid" : "http://preview.autoforum.localhost:3000"));
  return `${base.protocol}//*.${base.host}`;
}

function viewerOrigin(context: Context, id: string): { host: string; origin: string } {
  const base = configuredPreviewBase(context);
  base.hostname = `${id}.${base.hostname}`;
  return { host: base.hostname.toLowerCase(), origin: base.origin };
}

function forumOrigin(context: Context): string {
  return exactBrowserOrigin(context) ?? process.env.APP_ORIGIN ?? new URL(context.req.url).origin;
}

export function previewPolicyHeaders(forum: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${forum}; sandbox allow-scripts allow-same-origin allow-downloads`,
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function applyPolicy(context: Context, forum: string): void {
  for (const [name, value] of Object.entries(previewPolicyHeaders(forum))) context.header(name, value);
}

function responseWithPolicy(status: number, body: string | Uint8Array, forum: string, headers?: Headers): Response {
  const output = new Headers(headers);
  for (const [name, value] of Object.entries(previewPolicyHeaders(forum))) output.set(name, value);
  const responseBody = typeof body === "string" ? body : Uint8Array.from(body).buffer;
  return new Response(responseBody, { status, headers: output });
}

function parseCookies(value: string | undefined): string[] {
  return (value ?? "").split(";").map((part) => part.trim()).filter(Boolean);
}

export function stripPreviewCredentials(value: string | undefined): string | undefined {
  const blocked = new Set([SECURE_COOKIE.toLowerCase(), DEVELOPMENT_COOKIE.toLowerCase(), "autoforum_session"]);
  const remaining = parseCookies(value).filter((part) => {
    const separator = part.indexOf("=");
    return separator > 0 && !blocked.has(part.slice(0, separator).trim().toLowerCase());
  });
  return remaining.length ? remaining.join("; ") : undefined;
}

function forwardedRequestHeaders(request: Request, host: string, bodyLength: number, relayToken: string): OutgoingHttpHeaders {
  const blocked = new Set([
    "authorization", "connection", "content-length", "cookie", "host", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
    "transfer-encoding", "upgrade", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
    PREVIEW_RELAY_HEADER,
  ]);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of request.headers) {
    if (!blocked.has(name.toLowerCase())) headers[name] = value;
  }
  const cookie = stripPreviewCredentials(request.headers.get("cookie") ?? undefined);
  if (cookie) headers.cookie = cookie;
  headers.host = host;
  headers["content-length"] = String(bodyLength);
  headers.connection = "close";
  headers[PREVIEW_RELAY_HEADER] = relayToken;
  return headers;
}

function safeSetCookie(value: string): boolean {
  const [pair, ...attributes] = value.split(";");
  const separator = pair?.indexOf("=") ?? -1;
  if (separator < 1) return false;
  const name = pair!.slice(0, separator).trim().toLowerCase();
  if (name === SECURE_COOKIE.toLowerCase() || name === DEVELOPMENT_COOKIE.toLowerCase() || name === "autoforum_session") return false;
  return !attributes.some((attribute) => attribute.trim().toLowerCase().startsWith("domain="));
}

function forwardedResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const allowed = [
    "accept-ranges", "content-disposition", "content-encoding", "content-language", "content-range",
    "content-type", "etag", "last-modified", "location", "vary",
  ];
  const output = new Headers();
  for (const name of allowed) {
    const value = headers[name];
    if (Array.isArray(value)) for (const item of value) output.append(name, item);
    else if (value !== undefined) output.set(name, String(value));
  }
  for (const cookie of headers["set-cookie"] ?? []) {
    if (safeSetCookie(cookie)) output.append("set-cookie", cookie);
  }
  return output;
}

async function requestBytes(request: Request): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new Error("preview_request_too_large");
  if (request.method === "GET" || request.method === "HEAD") return Buffer.alloc(0);
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length > MAX_REQUEST_BYTES) throw new Error("preview_request_too_large");
  return bytes;
}

async function proxyRequest(request: Request, target: PreviewTarget, host: string, body: Buffer) {
  const url = new URL(request.url);
  return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const upstream = http.request({
      host: target.host,
      port: target.port,
      agent: false,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: forwardedRequestHeaders(request, host, body.length, target.relayToken),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) response.destroy(new Error("preview_response_too_large"));
        else chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 502,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });
    upstream.setTimeout(PROXY_TIMEOUT_MS, () => upstream.destroy(new Error("preview_timeout")));
    upstream.on("error", reject);
    if (body.length) upstream.write(body);
    upstream.end();
  });
}

async function authorizedProject(database: AppDatabase, userId: number, projectId: number): Promise<ProjectSandboxIdentity | null> {
  const result = await database.pool.query<ProjectSandboxIdentity>(
    `select p.row_id as "projectId", p.public_id as "publicId"
       from project p join project_member m on m.project_id = p.row_id
       join forum_user u on u.row_id = m.user_id
      where p.row_id = $1 and m.user_id = $2 and u.is_owner = true and u.disabled_at is null`,
    [projectId, userId],
  );
  return result.rows[0] ?? null;
}

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function artifactInitialPath(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || !normalized.startsWith("artifacts/") || !/\.html?$/i.test(normalized)) return null;
  const relative = normalized.slice("artifacts/".length);
  if (!relative) return null;
  return `/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

/** One in-process launch/session map and one opaque proxy for sandbox applications. */
export function createPreviewFeature(
  database: AppDatabase,
  resolveTarget: PreviewTargetResolver = getProjectPreviewTarget,
): { routes: Hono; middleware: MiddlewareHandler } {
  const launches = new Map<string, Launch>();
  const sessions = new Map<string, Session>();

  function discardExpired(): void {
    const now = Date.now();
    for (const [key, launch] of launches) if (launch.expiresAt <= now) launches.delete(key);
    for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  }

  const routes = new Hono();
  routes.post("/projects/:projectId/preview/launch", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId) return context.json({ error: "project_not_found" }, 404);
    const project = await authorizedProject(database, actor.id, projectId);
    if (!project) return context.json({ error: "project_not_found" }, 404);
    const input = await context.req.json().catch(() => null) as { artifact?: unknown } | null;
    const requestedArtifact = input?.artifact;
    const initialPath = requestedArtifact === undefined ? "/" : artifactInitialPath(requestedArtifact);
    if (!initialPath) return context.json({ error: "invalid_artifact_path" }, 400);
    const kind: ProjectPreviewKind = requestedArtifact === undefined ? "application" : "artifact";
    let target: PreviewTarget;
    try { target = await resolveTarget(project, kind); }
    catch (error) {
      const message = error instanceof Error ? error.message : "sandbox_preview_unavailable";
      return context.json({ error: message }, 409);
    }

    discardExpired();
    const code = generateSecret();
    const viewer = viewerOrigin(context, randomBytes(16).toString("hex"));
    launches.set(secretKey(code), {
      project,
      userId: actor.id,
      ...viewer,
      forumOrigin: forumOrigin(context),
      target,
      kind,
      initialPath,
      expiresAt: Date.now() + LAUNCH_LIFETIME_MS,
    });
    return context.json({ url: `${viewer.origin}/.autoforum/launch?code=${encodeURIComponent(code)}` });
  });

  const middleware: MiddlewareHandler = async (context, next) => {
    const host = requestHost(context);
    let base: URL;
    try { base = configuredPreviewBase(context); }
    catch { return await next(); }
    const suffix = `.${base.hostname.toLowerCase()}`;
    if (!host.endsWith(suffix)) return await next();
    discardExpired();

    const path = new URL(context.req.url).pathname;
    if (path === "/.autoforum/launch") {
      const code = context.req.query("code");
      const key = code ? secretKey(code) : "";
      const launch = launches.get(key);
      if (!launch || launch.host !== host || launch.expiresAt <= Date.now()) {
        return responseWithPolicy(401, "Invalid or expired preview launch.", process.env.APP_ORIGIN ?? "'none'");
      }
      launches.delete(key);
      if (!await authorizedProject(database, launch.userId, launch.project.projectId)) {
        return responseWithPolicy(401, "Preview access is no longer available.", launch.forumOrigin);
      }
      const secret = generateSecret();
      sessions.set(secretKey(secret), { ...launch, expiresAt: Date.now() + SESSION_LIFETIME_MS });
      const secure = new URL(launch.origin).protocol === "https:";
      setCookie(context, secure ? SECURE_COOKIE : DEVELOPMENT_COOKIE, secret, {
        httpOnly: true,
        secure,
        sameSite: "Strict",
        path: "/",
        maxAge: Math.floor(SESSION_LIFETIME_MS / 1_000),
      });
      applyPolicy(context, launch.forumOrigin);
      return context.redirect(launch.initialPath, 302);
    }
    if (path.startsWith("/.autoforum/")) {
      return responseWithPolicy(404, "Not found.", process.env.APP_ORIGIN ?? "'none'");
    }

    const secret = getCookie(context, SECURE_COOKIE) ?? getCookie(context, DEVELOPMENT_COOKIE);
    const session = secret ? sessions.get(secretKey(secret)) : undefined;
    if (!session || session.host !== host || session.expiresAt <= Date.now()) {
      if (secret) {
        deleteCookie(context, SECURE_COOKIE, { path: "/" });
        deleteCookie(context, DEVELOPMENT_COOKIE, { path: "/" });
      }
      return responseWithPolicy(401, "Preview session unavailable.", process.env.APP_ORIGIN ?? "'none'");
    }
    if (!await authorizedProject(database, session.userId, session.project.projectId)) {
      sessions.delete(secretKey(secret!));
      return responseWithPolicy(401, "Preview access is no longer available.", session.forumOrigin);
    }
    if (context.req.header("upgrade")) return responseWithPolicy(426, "WebSockets are not supported.", session.forumOrigin);
    if (session.kind === "artifact" && !["GET", "HEAD"].includes(context.req.method)) {
      const headers = new Headers({ allow: "GET, HEAD" });
      return responseWithPolicy(405, "Artifact previews are read-only.", session.forumOrigin, headers);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method) && context.req.header("origin") !== session.origin) {
      return responseWithPolicy(403, "Preview origin refused.", session.forumOrigin);
    }

    try {
      const body = await requestBytes(context.req.raw);
      const upstream = await proxyRequest(context.req.raw, session.target, new URL(context.req.url).host, body);
      const headers = forwardedResponseHeaders(upstream.headers);
      return responseWithPolicy(upstream.status, Uint8Array.from(upstream.body), session.forumOrigin, headers);
    } catch (error) {
      const message = error instanceof Error && error.message.includes("too_large")
        ? error.message
        : "sandbox_preview_unavailable";
      const status = message.includes("too_large") ? 413 : 502;
      return responseWithPolicy(status, message, session.forumOrigin);
    }
  };

  return { routes, middleware };
}
