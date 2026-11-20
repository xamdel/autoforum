import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { searchWeb } from "../src/sources/search.ts";

test("web search requires hosted search and returns provider citations", async () => {
  let payload: unknown;
  let requestedModel: string | undefined;
  const runtime = {
    hasConfiguredAuth(provider: string) {
      return provider === "chatgpt";
    },
    getModel(provider: string, id: string) {
      requestedModel = id;
      return { provider, id, api: "openai-responses" };
    },
    async completeSimple(_model: unknown, _context: unknown, options: {
      onPayload(value: unknown): unknown;
      onProviderStreamEvent(value: unknown): void;
    }) {
      payload = options.onPayload({ model: "gpt-6-luna", stream: true });
      options.onProviderStreamEvent({
        type: "response.output_item.done",
        item: {
          type: "message",
          content: [{
            type: "output_text",
            annotations: [{ type: "url_citation", url: "https://example.com/paper?utm_source=openai", title: "Example paper" }],
          }],
        },
      });
      return {
        role: "assistant",
        content: [{ type: "text", text: "A relevant paper." }],
        api: "openai-responses",
        provider: "chatgpt",
        model: "gpt-6-luna",
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      } satisfies AssistantMessage;
    },
  } as unknown as ModelRuntime;

  const result = await searchWeb("example research", 3, runtime);
  assert.equal(requestedModel, "gpt-6-luna");
  assert.equal(result.provider, "chatgpt");
  assert.deepEqual(result.results, [{ url: "https://example.com/paper", title: "Example paper" }]);
  assert.deepEqual((payload as { tools: unknown }).tools, [
    { type: "web_search", search_context_size: "low", external_web_access: true },
  ]);
  assert.equal((payload as { tool_choice: string }).tool_choice, "required");
});

test("web search preserves provider errors", async () => {
  const runtime = {
    hasConfiguredAuth(provider: string) {
      return provider === "chatgpt";
    },
    getModel(provider: string, id: string) {
      return { provider, id, api: "openai-responses" };
    },
    async completeSimple() {
      return {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "chatgpt",
        model: "gpt-6-luna",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "The selected model is unavailable.",
        timestamp: Date.now(),
      } satisfies AssistantMessage;
    },
  } as unknown as ModelRuntime;

  await assert.rejects(
    searchWeb("example research", 3, runtime),
    /The selected model is unavailable\./,
  );
});
