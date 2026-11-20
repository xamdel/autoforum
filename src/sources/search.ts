import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { piModelRuntime } from "../model-adapters/pi.ts";
import { webSearchPrompt } from "../prompts.ts";

const DEFAULT_SEARCH_MODEL = "gpt-6-luna";

export interface WebSearchResult {
  url: string;
  title: string | null;
}

export interface WebSearchResponse {
  summary: string;
  results: WebSearchResult[];
  provider: string;
  model: string;
  usage: Usage;
}

function configuredSearchModel(runtime: ModelRuntime): Model<string> {
  const provider = runtime.hasConfiguredAuth("chatgpt") ? "chatgpt"
    : runtime.hasConfiguredAuth("openai") ? "openai"
      : null;
  if (!provider) throw new Error("web_search_not_configured");
  const requested = process.env.AUTOFORUM_WEB_SEARCH_MODEL?.trim() || DEFAULT_SEARCH_MODEL;
  const model = runtime.getModel(provider, requested);
  if (!model || model.api !== "openai-responses") throw new Error(`web_search_model_not_found:${provider}/${requested}`);
  return model as Model<string>;
}

function textOf(message: AssistantMessage): string {
  return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
}

function collectCitations(value: unknown, found: Map<string, string | null>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectCitations(item, found));
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "url_citation") {
    const citation = record.url_citation && typeof record.url_citation === "object"
      ? record.url_citation as Record<string, unknown>
      : record;
    if (typeof citation.url === "string" && /^https?:\/\//i.test(citation.url)) {
      found.set(citation.url.replace(/([?&])utm_source=openai(?:&|$)/, "$1").replace(/[?&]$/, ""),
        typeof citation.title === "string" && citation.title.trim() ? citation.title.trim() : null);
    }
  }
  if (record.type === "web_search_call" && record.action && typeof record.action === "object") {
    const sources = (record.action as Record<string, unknown>).sources;
    if (Array.isArray(sources)) {
      for (const source of sources) {
        if (!source || typeof source !== "object") continue;
        const item = source as Record<string, unknown>;
        if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) {
          found.set(item.url, typeof item.title === "string" && item.title.trim() ? item.title.trim() : null);
        }
      }
    }
  }
  Object.values(record).forEach((item) => collectCitations(item, found));
}

/** Performs one provider-independent search for forum agents through the installation's OpenAI access. */
export async function searchWeb(query: string, maxResults = 8, runtimeOverride?: ModelRuntime): Promise<WebSearchResponse> {
  const requested = query.trim();
  if (!requested) throw new Error("web_search_query_required");
  const limit = Math.max(1, Math.min(Math.trunc(maxResults), 15));
  const runtime = runtimeOverride ?? await piModelRuntime();
  const model = configuredSearchModel(runtime);
  const citations = new Map<string, string | null>();
  const message = await runtime.completeSimple(model, {
    messages: [{
      role: "user",
      content: webSearchPrompt(requested, limit),
      timestamp: Date.now(),
    }],
  }, {
    reasoning: "low",
    maxTokens: 2_500,
    timeoutMs: 90_000,
    onPayload(payload) {
      if (!payload || typeof payload !== "object") return payload;
      return {
        ...payload as Record<string, unknown>,
        tools: [{ type: "web_search", search_context_size: "low", external_web_access: true }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
      };
    },
    onProviderStreamEvent(event) {
      collectCitations(event, citations);
    },
  });
  if (message.stopReason === "error") {
    throw new Error(message.errorMessage?.trim() || "web_search_provider_error");
  }
  const summary = textOf(message);
  if (!summary) throw new Error("web_search_returned_no_text");
  return {
    summary,
    results: [...citations].slice(0, limit).map(([url, title]) => ({ url, title })),
    provider: model.provider,
    model: model.id,
    usage: message.usage,
  };
}
