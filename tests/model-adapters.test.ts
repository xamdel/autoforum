import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { agentProfileSchema, parseAgentProfile } from "../src/agents/profiles.ts";
import { registerChatgptProvider } from "../src/model-adapters/chatgpt.ts";
import { listCatalogModels } from "../src/model-adapters/catalog.ts";
import { claudeCodeEnvironment } from "../src/model-adapters/claude-code.ts";
import {
  NOUS_INFERENCE_BASE_URL,
  nousCatalogModel,
  refreshNousCatalog,
  registerNousProvider,
} from "../src/model-adapters/nous.ts";
import { listModelApiKeys, removeModelApiKey, sandboxModelService, saveModelApiKey } from "../src/model-adapters/pi.ts";

test("Claude Code inherits the host login but not Autoforum's Anthropic API credentials", () => {
  const environment = claudeCodeEnvironment({
    PATH: "tools",
    ANTHROPIC_API_KEY: "api-secret",
    ANTHROPIC_AUTH_TOKEN: "auth-secret",
  });
  assert.equal(environment.PATH, "tools");
  assert.equal(environment.CLAUDE_AGENT_SDK_CLIENT_APP, "autoforum/1");
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("ChatGPT plan access is a first-class Pi provider", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-models-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    registerChatgptProvider(runtime);
    const provider = runtime.getProvider("chatgpt");
    assert.equal(provider?.name, "ChatGPT plan");
    assert.ok(provider?.getModels().length);
    assert.ok(provider?.getModels().every((model) => model.provider === "chatgpt"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the model catalog exposes picker metadata without provider credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-catalog-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    registerChatgptProvider(runtime);
    const catalog = listCatalogModels(runtime, "chatgpt");
    assert.ok(catalog?.length);
    assert.ok(catalog?.every((model) =>
      model.id && model.name && Array.isArray(model.input) && typeof model.reasoning === "boolean"));
    assert.equal(listCatalogModels(runtime, "not-a-provider"), null);
    assert.deepEqual(listCatalogModels(runtime, "claude-code")?.map((model) => model.id), ["haiku", "opus", "sonnet"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Nous Portal is an ordinary OpenAI-compatible API-key provider without a borrowed catalog", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-nous-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    registerNousProvider(runtime);
    const provider = runtime.getProvider("nous");
    assert.equal(provider?.name, "Nous Portal");
    assert.deepEqual(provider?.getModels(), []);
    const names = (await listModelApiKeys(runtime)).map((entry) => entry.name);
    assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Nous catalog entries preserve the model capabilities Autoforum needs", () => {
  const model = nousCatalogModel({
    id: "nous/example-model",
    name: "Example model",
    context_length: 128_000,
    architecture: { input_modalities: ["text", "image"] },
    pricing: { prompt: "0.000001", completion: "0.000002" },
    top_provider: { max_completion_tokens: 16_384 },
    supported_parameters: ["reasoning_effort"],
    endpoints: ["/api/v1/chat/completions"],
    reasoning: { supported_efforts: ["none", "low", "high"] },
  });
  assert.deepEqual(model && {
    id: model.id,
    name: model.name,
    provider: model.provider,
    input: model.input,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }, {
    id: "nous/example-model",
    name: "Example model",
    provider: "nous",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  });
});

test("Nous refresh replaces its public catalog without requiring provider credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-nous-refresh-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    let ids = ["nous/first", "nous/removed"];
    registerNousProvider(runtime, async () => ids.map((id) => nousCatalogModel({
      id,
      endpoints: ["/api/v1/chat/completions"],
    })!));

    await refreshNousCatalog(runtime);
    assert.deepEqual(runtime.getModels("nous").map((model) => model.id), ids);

    ids = ["nous/second"];
    await refreshNousCatalog(runtime);
    assert.deepEqual(runtime.getModels("nous").map((model) => model.id), ids);
    assert.equal(runtime.hasConfiguredAuth("nous"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude Code is deliberately a Scribe harness, not a forum-agent provider", () => {
  const common = { model: "sonnet", thinkingLevel: "high", systemPrompt: "Be useful." };
  assert.equal(agentProfileSchema.safeParse({ ...common, provider: "claude-code" }).success, false);
  assert.equal(agentProfileSchema.safeParse({ ...common, provider: "chatgpt" }).success, true);
  assert.equal(agentProfileSchema.safeParse({ ...common, provider: "anthropic" }).success, true);
});

test("legacy mention switches are ignored when stored agent profiles are read", () => {
  assert.deepEqual(parseAgentProfile({
    provider: "openrouter",
    model: "vendor/model",
    thinkingLevel: "low",
    systemPrompt: "Be useful.",
    enabled: false,
  }), {
    provider: "openrouter",
    model: "vendor/model",
    thinkingLevel: "low",
    systemPrompt: "Be useful.",
  });
});

test("owner-entered model API keys stay in Pi's host credential store", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-model-key-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const secret = "test-secret-that-must-not-appear-in-status";
    await saveModelApiKey(runtime, "openrouter", secret);

    const openrouter = (await listModelApiKeys(runtime)).find((provider) => provider.id === "openrouter");
    assert.deepEqual(openrouter && { configured: openrouter.configured, source: openrouter.source }, {
      configured: true,
      source: "stored",
    });
    assert.equal(JSON.stringify(openrouter).includes(secret), false);
    assert.deepEqual(await runtime.listCredentials(), [{ providerId: "openrouter", type: "api_key" }]);

    await removeModelApiKey(runtime, "openrouter");
    assert.deepEqual(await runtime.listCredentials(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandbox model routes are fixed by the host and exclude subscription providers", () => {
  assert.deepEqual(sandboxModelService("openrouter"), {
    name: "model-openrouter",
    upstream: "https://openrouter.ai/api/v1",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    credentialEnv: "OPENROUTER_API_KEY",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  });
  assert.equal(sandboxModelService("chatgpt"), null);
  assert.equal(sandboxModelService("claude-code"), null);
  assert.equal(sandboxModelService("unknown"), null);
  assert.deepEqual(sandboxModelService("nous"), {
    name: "model-nous",
    upstream: NOUS_INFERENCE_BASE_URL,
    baseUrlEnv: "NOUS_INFERENCE_BASE_URL",
    credentialEnv: "NOUS_API_KEY",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  });
});
