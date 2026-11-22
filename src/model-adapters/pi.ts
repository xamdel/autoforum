import path from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { z } from "zod";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import type { ServiceConfiguration } from "../service-access/services.ts";
import { registerChatgptProvider } from "./chatgpt.ts";
import {
  NOUS_INFERENCE_BASE_URL,
  refreshNousCatalog,
  registerNousProvider,
} from "./nous.ts";

let runtime: Promise<ModelRuntime> | undefined;
const complexApiKeyProviders = new Set(["amazon-bedrock", "cloudflare-ai-gateway", "cloudflare-workers-ai", "google-vertex"]);
const providerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const apiKeyInput = z.object({ key: z.string().trim().min(1).max(20_000) }).strict();

/** Provider-bound service routes that may reuse the matching host model API key. */
const sandboxModelServices: Record<string, ServiceConfiguration> = {
  openrouter: {
    name: "model-openrouter",
    upstream: "https://openrouter.ai/api/v1",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    credentialEnv: "OPENROUTER_API_KEY",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  openai: {
    name: "model-openai",
    upstream: "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
    credentialEnv: "OPENAI_API_KEY",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  anthropic: {
    name: "model-anthropic",
    upstream: "https://api.anthropic.com",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    credentialEnv: "ANTHROPIC_API_KEY",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  google: {
    name: "model-google",
    upstream: "https://generativelanguage.googleapis.com",
    baseUrlEnv: "GOOGLE_BASE_URL",
    credentialEnv: "GOOGLE_API_KEY",
    authHeader: "x-goog-api-key",
    authPrefix: "",
  },
  nous: {
    name: "model-nous",
    upstream: NOUS_INFERENCE_BASE_URL,
    baseUrlEnv: "NOUS_INFERENCE_BASE_URL",
    credentialEnv: "NOUS_API_KEY",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
};

export function sandboxModelService(providerId: string): ServiceConfiguration | null {
  const service = sandboxModelServices[providerId];
  return service ? { ...service } : null;
}

/** The one Pi model registry shared by forum agents and the Scribe in this process. */
export function piModelRuntime(): Promise<ModelRuntime> {
  runtime ??= ModelRuntime.create({
    authPath: path.resolve(".autoforum", "pi-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  }).then((created) => {
    registerChatgptProvider(created);
    registerNousProvider(created);
    if (created.hasConfiguredAuth("nous")) void refreshNousCatalog(created).catch(() => undefined);
    return created;
  });
  return runtime;
}

export interface ModelApiKeyProvider {
  id: string;
  name: string;
  authName: string;
  configured: boolean;
  source: "stored" | "environment" | "other" | null;
  sourceLabel: string | null;
  sandboxService: ServiceConfiguration | null;
}

function simpleApiKeyProviders(models: ModelRuntime) {
  return models.getProviders().filter((provider) =>
    provider.id !== "chatgpt" &&
    !complexApiKeyProviders.has(provider.id) &&
    Boolean(provider.auth.apiKey?.login));
}

/** Non-secret provider status for model pickers; only the owner can change the stored keys. */
export async function listModelApiKeys(models: ModelRuntime): Promise<ModelApiKeyProvider[]> {
  const stored = new Map((await models.listCredentials()).map((credential) => [credential.providerId, credential.type]));
  return simpleApiKeyProviders(models).map((provider) => {
    const auth = models.getProviderAuthStatus(provider.id);
    const storedType = stored.get(provider.id);
    const source = storedType === "api_key"
      ? "stored"
      : auth.configured && auth.source === "environment" ? "environment"
        : auth.configured ? "other" : null;
    return {
      id: provider.id,
      name: provider.name,
      authName: provider.auth.apiKey!.name,
      configured: auth.configured,
      source,
      sourceLabel: auth.configured && "label" in auth ? auth.label ?? null : null,
      sandboxService: models.isUsingOAuth(provider.id) ? null : sandboxModelService(provider.id),
    } satisfies ModelApiKeyProvider;
  }).sort((left, right) => left.name.localeCompare(right.name));
}

/** Resolves only ordinary API-key auth; subscription/OAuth credentials never enter service access. */
export async function resolveModelApiKey(providerId: string): Promise<string | null> {
  const models = await piModelRuntime();
  if (!sandboxModelService(providerId) || models.isUsingOAuth(providerId)) return null;
  const provider = simpleApiKeyProviders(models).find((candidate) => candidate.id === providerId);
  if (!provider) return null;
  const key = (await models.getAuth(providerId))?.auth.apiKey?.trim();
  return key || null;
}

/** Use Pi's own credential flow so the key is locked, persisted, and immediately live. */
export async function saveModelApiKey(models: ModelRuntime, providerId: string, key: string): Promise<void> {
  const provider = simpleApiKeyProviders(models).find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error("model_api_key_provider_not_supported");
  let prompted = false;
  await models.login(providerId, "api_key", {
    async prompt(prompt) {
      if (prompted || prompt.type !== "secret") throw new Error("model_api_key_provider_requires_additional_setup");
      prompted = true;
      return key;
    },
    notify() {},
  });
  if (!prompted) throw new Error("model_api_key_provider_requires_additional_setup");
  if (providerId === "nous") void refreshNousCatalog(models).catch(() => undefined);
}

export async function removeModelApiKey(models: ModelRuntime, providerId: string): Promise<void> {
  const credential = (await models.listCredentials()).find((candidate) => candidate.providerId === providerId);
  if (credential?.type !== "api_key") throw new Error("model_api_key_not_stored");
  await models.logout(providerId);
}

export function createModelApiKeyRoutes(database: AppDatabase) {
  const routes = new Hono();
  const requireOwner = async (context: Parameters<typeof readBrowserUser>[0]) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    return null;
  };

  routes.get("/", async (context) => {
    const actor = await readBrowserUser(context, database);
    return actor
      ? context.json({ providers: await listModelApiKeys(await piModelRuntime()) })
      : context.json({ error: "unauthenticated" }, 401);
  });

  routes.put("/:provider", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const denied = await requireOwner(context);
    if (denied) return denied;
    const provider = providerIdSchema.safeParse(context.req.param("provider"));
    const input = apiKeyInput.safeParse(await context.req.json().catch(() => null));
    if (!provider.success || !input.success) return context.json({ error: "invalid_input" }, 400);
    try {
      await saveModelApiKey(await piModelRuntime(), provider.data, input.data.key);
      return context.json({ providers: await listModelApiKeys(await piModelRuntime()) });
    } catch (error) {
      const code = error instanceof Error && error.message.startsWith("model_api_key_")
        ? error.message : "model_api_key_save_failed";
      return context.json({ error: code }, code === "model_api_key_provider_not_supported" ? 404 : 400);
    }
  });

  routes.delete("/:provider", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const denied = await requireOwner(context);
    if (denied) return denied;
    const provider = providerIdSchema.safeParse(context.req.param("provider"));
    if (!provider.success) return context.json({ error: "invalid_input" }, 400);
    try {
      await removeModelApiKey(await piModelRuntime(), provider.data);
      return context.json({ providers: await listModelApiKeys(await piModelRuntime()) });
    } catch (error) {
      const code = error instanceof Error && error.message === "model_api_key_not_stored"
        ? error.message : "model_api_key_remove_failed";
      return context.json({ error: code }, 400);
    }
  });

  return routes;
}
