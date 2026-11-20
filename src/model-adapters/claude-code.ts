import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";
import { z } from "zod";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";

export interface ClaudeCompatibleTool {
  name: string;
  description: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ): Promise<{ content: unknown[] }>;
}

export interface ClaudeScribeOptions {
  prompt: string;
  systemPrompt: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools: ClaudeCompatibleTool[];
  abortController: AbortController;
  onToolActivity?(activity: ClaudeToolActivity): void;
  onEvent?(message: SDKMessage): void;
}

export interface ClaudeToolActivity {
  phase: "start" | "end";
  callId: string;
  toolName: string;
  input?: Record<string, unknown>;
}

export interface ClaudeScribeResult {
  text: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    reasoning: number;
  };
  reportedCost: number;
}

const SIGN_IN = "claude_code_not_signed_in: run `claude` in a terminal on this computer and sign in with /login";
const CLAUDE_DIR = path.resolve(".autoforum", "claude-code");

/** Claude Code inherits the user's login but never an API key belonging to Autoforum. */
export function claudeCodeEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = { ...environment, CLAUDE_AGENT_SDK_CLIENT_APP: "autoforum/1" };
  delete isolated.ANTHROPIC_API_KEY;
  delete isolated.ANTHROPIC_AUTH_TOKEN;
  return isolated;
}

function baseOptions(cwd: string): Options {
  return {
    cwd,
    env: claudeCodeEnvironment(),
    settingSources: [],
    tools: [],
    skills: [],
    strictMcpConfig: true,
    settings: { disableClaudeAiConnectors: true },
  };
}

function inputStream() {
  let wake: (() => void) | undefined;
  let closed = false;
  const messages: SDKUserMessage[] = [];
  return {
    push(text: string) {
      messages.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *read() {
      while (!closed) {
        while (messages.length) yield messages.shift()!;
        if (!closed) await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
}

function toolServer(
  tools: ClaudeCompatibleTool[],
  signal: AbortSignal,
  onToolActivity?: (activity: ClaudeToolActivity) => void,
) {
  const available = new Map(tools.map((candidate) => [candidate.name, candidate]));
  const run = (name: string) => async (params: Record<string, unknown>) => {
    const selected = available.get(name);
    if (!selected) return { content: [{ type: "text" as const, text: `tool_not_available:${name}` }], isError: true };
    const callId = `${name}-${randomUUID()}`;
    onToolActivity?.({ phase: "start", callId, toolName: name, input: params });
    try {
      const result = await selected.execute(callId, params, signal, undefined, undefined as never);
      return { content: result.content as never };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    } finally {
      onToolActivity?.({ phase: "end", callId, toolName: name });
    }
  };
  const pathValue = z.string().max(500).describe("Path relative to /workspace");
  const description = (name: string) => available.get(name)?.description ?? name;
  return createSdkMcpServer({
    name: "autoforum",
    alwaysLoad: true,
    tools: [
      tool("read_address", description("read_address"), { address: z.string().max(100) }, run("read_address")),
      tool("search_forum", description("search_forum"), { query: z.string().min(1).max(500) }, run("search_forum")),
      tool("web_search", description("web_search"), {
        query: z.string().min(1).max(500),
        maxResults: z.number().int().min(1).max(15).optional(),
      }, run("web_search")),
      tool("read_web", description("read_web"), {
        url: z.string().min(1).max(2_000),
        page: z.number().int().min(1).max(300).optional(),
        offset: z.number().int().min(0).max(2_000_000).optional(),
      }, run("read_web")),
      tool("save_source", description("save_source"), {
        url: z.string().min(1).max(2_000),
      }, run("save_source")),
      tool("read_source", description("read_source"), {
        address: z.string().max(100),
        page: z.number().int().min(1).max(300).optional(),
        offset: z.number().int().min(0).max(2_000_000).optional(),
      }, run("read_source")),
      tool("list_workspace", description("list_workspace"), { path: pathValue.optional() }, run("list_workspace")),
      tool("read_workspace_file", description("read_workspace_file"), { path: pathValue.min(1) }, run("read_workspace_file")),
      tool("write_workspace_file", description("write_workspace_file"), {
        path: pathValue.min(1),
        content: z.string().max(512 * 1_024),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      }, run("write_workspace_file")),
      tool("run_workspace_command", description("run_workspace_command"), {
        argv: z.array(z.string().max(100_000)).min(1).max(100),
        cwd: pathValue.min(1).optional(),
        timeoutMs: z.number().int().min(1).max(10 * 60 * 1_000).optional(),
      }, run("run_workspace_command")),
    ],
  });
}

function usageFrom(modelUsage: Record<string, {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}>): ClaudeScribeResult["usage"] & { reportedCost: number } {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, reportedCost: 0 };
  for (const model of Object.values(modelUsage)) {
    usage.input += model.inputTokens;
    usage.output += model.outputTokens;
    usage.cacheRead += model.cacheReadInputTokens;
    usage.cacheWrite += model.cacheCreationInputTokens;
    usage.reasoning += model.thinkingTokens ?? 0;
    usage.reportedCost += model.costUSD;
  }
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}

function looksLikeAuthenticationFailure(message: string): boolean {
  return /log ?in|authenticat|oauth|api key|credential/i.test(message);
}

export async function runClaudeScribe(options: ClaudeScribeOptions): Promise<ClaudeScribeResult> {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  const server = toolServer(options.tools, options.abortController.signal, options.onToolActivity);
  const effort = options.thinkingLevel === "off"
    ? undefined
    : options.thinkingLevel === "minimal" ? "low" : options.thinkingLevel;
  const session = query({
    prompt: options.prompt,
    options: {
      ...baseOptions(CLAUDE_DIR),
      abortController: options.abortController,
      model: options.model,
      ...(effort ? { effort, thinking: { type: "adaptive" as const, display: "summarized" as const } }
        : { thinking: { type: "disabled" as const } }),
      systemPrompt: options.systemPrompt,
      mcpServers: { autoforum: server },
      allowedTools: options.tools.map((candidate) => `mcp__autoforum__${candidate.name}`),
      permissionMode: "dontAsk",
      persistSession: false,
    },
  });
  try {
    for await (const message of session) {
      options.onEvent?.(message);
      if (message.type !== "result") continue;
      const accounting = usageFrom(message.modelUsage);
      if (message.subtype !== "success" || message.is_error) {
        const detail = message.subtype === "success"
          ? message.result
          : message.errors.join("; ") || message.subtype;
        throw new Error(looksLikeAuthenticationFailure(detail) ? SIGN_IN : detail);
      }
      const text = message.result.trim();
      if (!text) throw new Error("scribe_returned_no_text");
      return {
        text,
        usage: {
          input: accounting.input,
          output: accounting.output,
          cacheRead: accounting.cacheRead,
          cacheWrite: accounting.cacheWrite,
          totalTokens: accounting.totalTokens,
          reasoning: accounting.reasoning,
        },
        reportedCost: accounting.reportedCost,
      };
    }
    if (options.abortController.signal.aborted) throw new Error("scribe_stopped");
    throw new Error("claude_code_ended_without_a_result");
  } finally {
    session.close();
  }
}

export interface ClaudeCodeAccount {
  signedIn: boolean;
  email: string | null;
  subscription: string | null;
  error: string | null;
}

let cachedAccount: { checkedAt: number; account: ClaudeCodeAccount } | undefined;

/** Ask the official Claude Code process for public account metadata; Autoforum never reads its credential. */
export async function claudeCodeAccount(force = false): Promise<ClaudeCodeAccount> {
  if (!force && cachedAccount && Date.now() - cachedAccount.checkedAt < 60_000) return cachedAccount.account;
  mkdirSync(CLAUDE_DIR, { recursive: true });
  const input = inputStream();
  const session = query({ prompt: input.read(), options: baseOptions(CLAUDE_DIR) });
  let account: ClaudeCodeAccount;
  try {
    const info = await Promise.race([
      session.accountInfo(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("claude_code_did_not_answer")), 30_000)),
    ]);
    const signedIn = Boolean(info.email || info.subscriptionType || (info.tokenSource && info.tokenSource !== "none"));
    account = {
      signedIn,
      email: info.email ?? null,
      subscription: info.subscriptionType ?? null,
      error: signedIn ? null : SIGN_IN,
    };
  } catch (error) {
    account = { signedIn: false, email: null, subscription: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    input.close();
    session.close();
  }
  cachedAccount = { checkedAt: Date.now(), account };
  return account;
}

export function createClaudeCodeRoutes(database: AppDatabase) {
  const routes = new Hono();
  const owner = async (context: Parameters<typeof readBrowserUser>[0]) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    return null;
  };

  routes.get("/", async (context) => {
    const denied = await owner(context);
    return denied ?? context.json(await claudeCodeAccount());
  });

  routes.post("/refresh", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const denied = await owner(context);
    return denied ?? context.json(await claudeCodeAccount(true));
  });

  return routes;
}
