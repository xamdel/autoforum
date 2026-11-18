import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { lazyStream, type Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const REGISTRATION_CLIENT = "dynamic_agent_client";
const APP_NAME = "Autoforum";
const CALLBACK_PATH = "/api/model-access/chatgpt/callback";
const AUTH_FILE = path.resolve(".autoforum", "secrets", "chatgpt-auth.json");

interface SavedChatgptAuth {
  hostId: string;
  clientId?: string;
  account?: { subject: string; email?: string; issuer: string };
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
  scopes?: string[];
  savedAt?: string;
}

interface PendingAuthorization {
  verifier: string;
  nonce: string;
  redirectUri: string;
  clientId: string;
  createdAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface IdClaims {
  sub: string;
  email?: string;
  iss: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  nonce: string;
}

const pending = new Map<string, PendingAuthorization>();
let discovery: { jwks_uri: string; revocation_endpoint?: string } | undefined;
let refreshing: Promise<string> | undefined;
let knownModelIds: string[] = [];

function saveAuth(auth: SavedChatgptAuth): void {
  auth.savedAt = new Date().toISOString();
  mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  const temporary = `${AUTH_FILE}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, AUTH_FILE);
}

function loadAuth(): SavedChatgptAuth {
  if (existsSync(AUTH_FILE)) return JSON.parse(readFileSync(AUTH_FILE, "utf8")) as SavedChatgptAuth;
  const created = { hostId: `urn:uuid:${randomUUID()}` };
  saveAuth(created);
  return created;
}

function clearTokens(auth: SavedChatgptAuth): void {
  delete auth.accessToken;
  delete auth.refreshToken;
  delete auth.expiresAt;
  delete auth.tokenType;
  delete auth.scopes;
}

function base64Url(value: Uint8Array | ArrayBuffer): string {
  return Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString("base64url");
}

function randomValue(): string {
  return base64Url(randomBytes(32));
}

function applyTokens(auth: SavedChatgptAuth, tokens: TokenResponse): void {
  auth.accessToken = tokens.access_token;
  if (tokens.refresh_token) auth.refreshToken = tokens.refresh_token;
  auth.tokenType = tokens.token_type;
  auth.expiresAt = Date.now() + Number(tokens.expires_in ?? 3_600) * 1_000;
  if (tokens.scope) auth.scopes = tokens.scope.split(/\s+/).filter(Boolean);
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const body = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok) {
    const error = new Error(`chatgpt_auth:${body.error_description ?? body.error ?? `HTTP ${response.status}`}`);
    Object.assign(error, { oauthError: body.error });
    throw error;
  }
  if (!body.access_token) throw new Error("chatgpt_auth:token_response_has_no_access_token");
  return body;
}

async function openIdConfiguration() {
  if (discovery) return discovery;
  const response = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error("chatgpt_auth:could_not_load_openid_configuration");
  discovery = await response.json() as { jwks_uri: string; revocation_endpoint?: string };
  if (!discovery?.jwks_uri) throw new Error("chatgpt_auth:openid_configuration_has_no_jwks_uri");
  return discovery;
}

async function verifyIdToken(token: string | undefined, clientId: string, nonce: string): Promise<IdClaims> {
  if (!token) throw new Error("chatgpt_auth:missing_id_token");
  const [headerPart, claimsPart, signaturePart] = token.split(".");
  if (!headerPart || !claimsPart || !signaturePart) throw new Error("chatgpt_auth:malformed_id_token");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as { alg?: string; kid?: string };
  const claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")) as IdClaims;
  const keysResponse = await fetch((await openIdConfiguration()).jwks_uri);
  if (!keysResponse.ok) throw new Error("chatgpt_auth:could_not_load_signing_keys");
  const { keys } = await keysResponse.json() as { keys: Array<JsonWebKey & { kid?: string }> };
  const jwk = keys.find((candidate) => candidate.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) throw new Error("chatgpt_auth:no_matching_signing_key");
  const algorithms: Record<string, [RsaHashedImportParams | EcKeyImportParams, AlgorithmIdentifier | EcdsaParams]> = {
    RS256: [{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, { name: "RSASSA-PKCS1-v1_5" }],
    ES256: [{ name: "ECDSA", namedCurve: "P-256" }, { name: "ECDSA", hash: "SHA-256" }],
  };
  const algorithm = header.alg ? algorithms[header.alg] : undefined;
  if (!algorithm) throw new Error(`chatgpt_auth:unsupported_id_token_algorithm:${header.alg ?? "missing"}`);
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm[0], false, ["verify"]);
  const validSignature = await crypto.subtle.verify(
    algorithm[1],
    key,
    Buffer.from(signaturePart, "base64url"),
    new TextEncoder().encode(`${headerPart}.${claimsPart}`),
  );
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!validSignature) throw new Error("chatgpt_auth:invalid_id_token_signature");
  if (claims.iss !== ISSUER) throw new Error("chatgpt_auth:unexpected_id_token_issuer");
  if (!audience.includes(clientId)) throw new Error("chatgpt_auth:unexpected_id_token_audience");
  if (audience.length > 1 && claims.azp !== clientId) throw new Error("chatgpt_auth:unexpected_id_token_authorized_party");
  if (!Number.isFinite(claims.exp) || claims.exp * 1_000 < Date.now() - 60_000) throw new Error("chatgpt_auth:expired_id_token");
  if (claims.nonce !== nonce) throw new Error("chatgpt_auth:id_token_nonce_mismatch");
  if (!claims.sub) throw new Error("chatgpt_auth:id_token_has_no_subject");
  return claims;
}

export function chatgptStatus() {
  const auth = loadAuth();
  return {
    signedIn: Boolean(auth.refreshToken),
    planUsage: Boolean(auth.refreshToken && auth.scopes?.includes(PLAN_SCOPE)),
    email: auth.account?.email ?? null,
    registered: Boolean(auth.clientId),
    accessExpiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : null,
    models: knownModelIds,
  };
}

export async function startChatgptSignIn(port: number): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("chatgpt_auth:invalid_callback_port");
  const auth = loadAuth();
  for (const [state, attempt] of pending) {
    if (Date.now() - attempt.createdAt > 15 * 60_000) pending.delete(state);
  }
  const state = randomValue();
  const verifier = randomValue();
  const nonce = randomValue();
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const clientId = auth.clientId ?? REGISTRATION_CLIENT;
  pending.set(state, { verifier, nonce, redirectUri, clientId, createdAt: Date.now() });
  const challenge = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const parameters = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: auth.hostId,
  });
  if (!auth.clientId) parameters.set("agent_name_hint", APP_NAME);
  else {
    if (auth.idToken) parameters.set("id_token_hint", auth.idToken);
    if (auth.account?.email) parameters.set("login_hint", auth.account.email);
  }
  return `${AUTHORIZE_URL}?${parameters}`;
}

export async function finishChatgptSignIn(parameters: URLSearchParams): Promise<string> {
  const state = parameters.get("state") ?? "";
  const attempt = pending.get(state);
  if (!attempt) throw new Error("chatgpt_auth:unknown_or_expired_sign_in");
  pending.delete(state);
  if (parameters.get("error")) {
    throw new Error(parameters.get("error") === "access_denied"
      ? "chatgpt_auth:sign_in_cancelled"
      : `chatgpt_auth:${parameters.get("error_description") ?? parameters.get("error")}`);
  }
  const code = parameters.get("code");
  if (!code) throw new Error("chatgpt_auth:missing_authorization_code");
  const returnedClientId = parameters.get("client_id");
  let clientId = attempt.clientId;
  if (attempt.clientId === REGISTRATION_CLIENT) {
    if (!returnedClientId) throw new Error("chatgpt_auth:registration_returned_no_client_id");
    clientId = returnedClientId;
  } else if (returnedClientId && returnedClientId !== attempt.clientId) {
    throw new Error("chatgpt_auth:client_id_mismatch");
  }

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: attempt.verifier,
    redirect_uri: attempt.redirectUri,
    resource: RESOURCE,
  });
  const claims = await verifyIdToken(tokens.id_token, clientId, attempt.nonce);
  const auth = loadAuth();
  if (auth.account && auth.clientId === clientId && auth.account.subject !== claims.sub) {
    throw new Error("chatgpt_auth:registered_account_mismatch");
  }
  auth.clientId = clientId;
  auth.account = { subject: claims.sub, email: claims.email, issuer: claims.iss };
  auth.idToken = tokens.id_token;
  applyTokens(auth, tokens);
  auth.scopes ??= SCOPE.split(/\s+/);
  saveAuth(auth);
  return auth.scopes?.includes(PLAN_SCOPE)
    ? `Signed in as ${claims.email ?? claims.sub}. ChatGPT plan access is ready.`
    : `Signed in as ${claims.email ?? claims.sub}, but ChatGPT plan access was not granted.`;
}

const terminalRefreshErrors = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export async function chatgptAccessToken(): Promise<string> {
  const auth = loadAuth();
  if (!auth.refreshToken || !auth.clientId || !auth.scopes?.includes(PLAN_SCOPE)) throw new Error("chatgpt_not_connected");
  if (auth.accessToken && (auth.expiresAt ?? 0) - Date.now() > 5 * 60_000) return auth.accessToken;
  refreshing ??= (async () => {
    try {
      const current = loadAuth();
      if (!current.refreshToken || !current.clientId) throw new Error("chatgpt_not_connected");
      const tokens = await tokenRequest({
        grant_type: "refresh_token",
        client_id: current.clientId,
        refresh_token: current.refreshToken,
        resource: RESOURCE,
      });
      const latest = loadAuth();
      applyTokens(latest, tokens);
      if (tokens.id_token) latest.idToken = tokens.id_token;
      saveAuth(latest);
      return latest.accessToken!;
    } catch (error) {
      const oauthError = (error as Error & { oauthError?: string }).oauthError;
      if (oauthError && terminalRefreshErrors.has(oauthError)) {
        const latest = loadAuth();
        clearTokens(latest);
        saveAuth(latest);
        throw new Error("chatgpt_sign_in_expired");
      }
      throw error;
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

export async function signOutChatgpt(): Promise<ReturnType<typeof chatgptStatus> & { revoked: boolean }> {
  const auth = loadAuth();
  let revoked = !auth.refreshToken;
  if (auth.refreshToken && auth.clientId) {
    try {
      const endpoint = (await openIdConfiguration()).revocation_endpoint;
      if (endpoint) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: auth.refreshToken, token_type_hint: "refresh_token", client_id: auth.clientId }),
        });
        revoked = response.ok;
      }
    } catch {
      revoked = false;
    }
  }
  clearTokens(auth);
  delete auth.idToken;
  saveAuth(auth);
  return { ...chatgptStatus(), revoked };
}

function chatgptProvider(openai: Provider): Provider {
  const asOpenAI = <Model extends { provider: string }>(model: Model) => ({ ...model, provider: "openai" });
  const withToken = async <Options,>(options: Options) => ({ ...options, apiKey: await chatgptAccessToken() });
  return {
    id: "chatgpt",
    name: "ChatGPT plan",
    baseUrl: RESOURCE,
    auth: {
      apiKey: {
        name: "Autoforum ChatGPT connection",
        resolve: async () => chatgptStatus().planUsage
          ? { auth: { apiKey: "chatgpt-sign-in" }, source: "Autoforum ChatGPT connection" }
          : undefined,
      },
    },
    getModels: () => openai.getModels()
      .filter((model) => model.api === "openai-responses")
      .map((model) => ({ ...model, provider: "chatgpt" })),
    stream: (model, context, options) => lazyStream(model, async () => openai.stream(asOpenAI(model) as never, context, await withToken(options) as never)),
    streamSimple: (model, context, options) => lazyStream(model, async () => openai.streamSimple(asOpenAI(model) as never, context, await withToken(options) as never)),
  };
}

export function registerChatgptProvider(runtime: ModelRuntime): void {
  const openai = runtime.getProvider("openai");
  if (!openai) throw new Error("pi_openai_provider_unavailable");
  const provider = chatgptProvider(openai);
  knownModelIds = provider.getModels().map((model) => model.id);
  runtime.registerNativeProvider(provider);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

async function requireOwner(context: Parameters<typeof readBrowserUser>[0], database: AppDatabase) {
  const actor = await readBrowserUser(context, database);
  if (!actor) return { response: context.json({ error: "unauthenticated" }, 401) };
  if (!actor.isOwner) return { response: context.json({ error: "owner_required" }, 403) };
  return { actor };
}

export function createChatgptRoutes(database: AppDatabase, port: number) {
  const routes = new Hono();

  routes.get("/", async (context) => {
    const owner = await requireOwner(context, database);
    return "response" in owner ? owner.response : context.json(chatgptStatus());
  });

  routes.post("/sign-in", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const owner = await requireOwner(context, database);
    if ("response" in owner) return owner.response;
    return context.json({ url: await startChatgptSignIn(port) });
  });

  routes.post("/sign-out", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const owner = await requireOwner(context, database);
    if ("response" in owner) return owner.response;
    return context.json(await signOutChatgpt());
  });

  routes.get("/callback", async (context) => {
    let status = 200;
    let heading = "ChatGPT connected";
    let message: string;
    try {
      message = await finishChatgptSignIn(new URL(context.req.url).searchParams);
    } catch (error) {
      status = 400;
      heading = "ChatGPT connection did not complete";
      message = error instanceof Error ? error.message : "chatgpt_auth:unknown_error";
    }
    const appOrigin = process.env.APP_ORIGIN ?? "http://app.autoforum.localhost:5173";
    return context.html(`<!doctype html><meta charset="utf-8"><title>Autoforum · ChatGPT</title>
      <body>
      <h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>
      <p><a href="${escapeHtml(appOrigin)}">Return to Autoforum</a>. You may close this tab.</p></body>`, status as 200 | 400);
  });

  return routes;
}
