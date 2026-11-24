import {
  createProvider,
  envApiKeyAuth,
  type Model,
  type ModelThinkingLevel,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openRouterCost, type OpenRouterPricing } from "@earendil-works/pi-ai/providers/openrouter-api";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const NOUS_INFERENCE_BASE_URL = "https://inference-api.nousresearch.com/v1";
const CHAT_COMPLETIONS_ENDPOINT = "/api/v1/chat/completions";
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface NousCatalogModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: OpenRouterPricing;
  top_provider?: { max_completion_tokens?: number };
  supported_parameters?: string[];
  endpoints?: string[];
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[];
  };
}

type NousCatalogLoader = (signal: AbortSignal) => Promise<Model<"openai-completions">[]>;
const catalogs = new WeakMap<ModelRuntime, { models: Model<"openai-completions">[]; load: NousCatalogLoader }>();

function thinkingLevelMap(entry: NousCatalogModel): ThinkingLevelMap | undefined {
  const efforts = entry.reasoning?.supported_efforts;
  if (!efforts?.length) return undefined;
  const supported = new Set(efforts);
  const map: ThinkingLevelMap = {};
  for (const level of THINKING_LEVELS) {
    const upstream = level === "off" ? "none" : level;
    map[level] = supported.has(upstream) ? upstream : null;
  }
  return map;
}

/** Convert the public Nous/OpenRouter-shaped catalog entry to the one chat shape Autoforum uses. */
export function nousCatalogModel(entry: NousCatalogModel): Model<"openai-completions"> | null {
  if (!entry.id || !entry.endpoints?.includes(CHAT_COMPLETIONS_ENDPOINT)) return null;
  const modalities = new Set(entry.architecture?.input_modalities ?? ["text"]);
  const input = (["text", "image"] as const).filter((modality) => modalities.has(modality));
  if (!input.includes("text")) return null;
  const reasoning = Boolean(
    entry.reasoning?.mandatory
    || entry.reasoning?.default_enabled
    || entry.reasoning?.supported_efforts?.length
    || entry.supported_parameters?.includes("reasoning")
    || entry.supported_parameters?.includes("reasoning_effort"),
  );
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    api: "openai-completions",
    provider: "nous",
    baseUrl: NOUS_INFERENCE_BASE_URL,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: thinkingLevelMap(entry) } : {}),
    input,
    cost: openRouterCost(entry.pricing),
    contextWindow: entry.context_length ?? 0,
    maxTokens: entry.top_provider?.max_completion_tokens ?? 0,
  };
}

async function fetchNousModels(signal: AbortSignal): Promise<Model<"openai-completions">[]> {
  const response = await fetch(`${NOUS_INFERENCE_BASE_URL}/models`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) throw new Error(`nous_model_catalog_failed:${response.status}`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("nous_model_catalog_invalid");
  }
  const models = body.data.flatMap((value) => {
    if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") return [];
    const model = nousCatalogModel(value as NousCatalogModel);
    return model ? [model] : [];
  });
  if (!models.length) throw new Error("nous_model_catalog_empty");
  return models;
}

/** Nous publishes its own catalog; borrowing another provider's list would leave removed models behind. */
export function registerNousProvider(runtime: ModelRuntime, load: NousCatalogLoader = fetchNousModels): void {
  const models: Model<"openai-completions">[] = [];
  catalogs.set(runtime, { models, load });
  runtime.registerNativeProvider(createProvider({
    id: "nous",
    name: "Nous Portal",
    baseUrl: NOUS_INFERENCE_BASE_URL,
    auth: { apiKey: envApiKeyAuth("Nous Portal API key", ["NOUS_API_KEY"]) },
    models,
    api: openAICompletionsApi(),
  }));
}

/** Replace Nous's dynamic catalog with the provider's current chat models. */
export async function refreshNousCatalog(runtime: ModelRuntime): Promise<void> {
  const catalog = catalogs.get(runtime);
  if (!catalog) throw new Error("nous_provider_not_registered");
  const models = await catalog.load(AbortSignal.timeout(15_000));
  catalog.models.splice(0, catalog.models.length, ...models);
  await runtime.refresh({ providers: ["nous"], allowNetwork: false });
}
