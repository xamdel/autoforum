import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";

import type { AppDatabase } from "../db.ts";
import type { AgentLog } from "../logging/agents.ts";
import { formatAddress, parseAddress, previewAddress } from "../forum/addresses.ts";
import { publishInputSchema, publishPost, validatePublishPost, type PublishInput } from "../forum/publish.ts";
import { searchForum } from "../forum/queries.ts";
import { publishProjectThread, publishThreadInputSchema } from "../forum/threads.ts";
import { piModelRuntime } from "../model-adapters/pi.ts";
import { agentSystemPrompt } from "../prompts.ts";
import type { startQueue } from "../queue.ts";
import { ensureProjectSource } from "../sources/library.ts";
import { readRemoteSource } from "../sources/reader.ts";
import { searchWeb } from "../sources/search.ts";
import { buildAgentContext } from "./context.ts";
import { parseAgentProfile } from "./profiles.ts";
import type { EnqueueAgentTurns } from "./turns.ts";

const MAX_TOOL_CALLS = 80;
const MAX_MODEL_STEPS = 30;
const MAX_OUTPUT_TOKENS = 32_000;
const TURN_TIMEOUT_MS = 15 * 60 * 1_000;
const STOP_POLL_MS = 750;
const SOURCE_TOOL_LIMIT = 16_000;

type Queue = Awaited<ReturnType<typeof startQueue>>;

interface ClaimedTurn {
  id: number;
  projectId: number;
  agentUserId: number;
  triggerPostId: number;
  provider: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  threadId: number;
  subforumId: number;
  triggerLocalId: number;
  agentHandle: string;
  profile: unknown;
}

const agentReplySchema = publishInputSchema.omit({ replyTo: true });
const agentReplyTypeBox = Type.Unsafe<z.infer<typeof agentReplySchema>>(
  z.toJSONSchema(agentReplySchema, { target: "draft-2020-12", io: "input", unrepresentable: "throw" }),
);
const agentThreadSchema = publishThreadInputSchema.omit({ subforumId: true });
const agentThreadTypeBox = Type.Unsafe<z.infer<typeof agentThreadSchema>>(
  z.toJSONSchema(agentThreadSchema, { target: "draft-2020-12", io: "input", unrepresentable: "throw" }),
);

function log(log: AgentLog, event: string, details: Record<string, unknown>): void {
  void log.write(event, details).catch((error) => console.error("Could not write agent log", error));
}

function sourceToolResult(source: Awaited<ReturnType<typeof readRemoteSource>>, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid_source_offset");
  if (offset > source.text.length) throw new Error("source_offset_not_found");
  const text = source.text.slice(offset, offset + SOURCE_TOOL_LIMIT);
  const nextOffset = offset + text.length < source.text.length ? offset + text.length : null;
  return { ...source, text, offset, nextOffset };
}

async function claimTurn(database: AppDatabase, turnId: number): Promise<ClaimedTurn | null> {
  const claimed = await database.pool.query<{
    id: number;
    projectId: number;
    agentUserId: number;
    triggerPostId: number;
    provider: string;
    model: string;
    thinkingLevel: ClaimedTurn["thinkingLevel"];
  }>(
    `update agent_turn set status = 'running', started_at = now()
      where row_id = $1 and status = 'queued' and stop_requested_at is null
    returning row_id as id, project_id as "projectId", agent_user_id as "agentUserId",
              trigger_post_id as "triggerPostId", provider, model, thinking_level as "thinkingLevel"`,
    [turnId],
  );
  const turn = claimed.rows[0];
  if (!turn) return null;
  const details = await database.pool.query<{
    threadId: number;
    subforumId: number;
    triggerLocalId: number;
    agentHandle: string;
    profile: unknown;
  }>(
    `select p.thread_id as "threadId", t.subforum_id as "subforumId", p.local_id as "triggerLocalId",
            u.handle as "agentHandle", u.agent_config as profile
       from post p join thread t on t.row_id = p.thread_id join forum_user u on u.row_id = $2
      where p.row_id = $1 and p.project_id = $3`,
    [turn.triggerPostId, turn.agentUserId, turn.projectId],
  );
  const detail = details.rows[0];
  if (!detail) throw new Error("turn_records_not_found");
  return { ...turn, ...detail };
}

async function stopWasRequested(database: AppDatabase, turnId: number): Promise<boolean> {
  const result = await database.pool.query<{ stopped: boolean }>(
    `select stop_requested_at is not null as stopped from agent_turn where row_id = $1`,
    [turnId],
  );
  return result.rows[0]?.stopped ?? true;
}

function toolText(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: undefined };
}

function lastAssistantText(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => {
        const candidate = block as { type?: string; text?: unknown };
        return candidate.type === "text" && typeof candidate.text === "string";
      })
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

function usageFrom(messages: readonly unknown[]) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0 };
  let reportedCost = 0;
  for (const item of messages) {
    const message = item as {
      role?: string;
      usage?: {
        input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
        reasoning?: number; cost?: { total?: number };
      };
    };
    if (message.role !== "assistant" || !message.usage) continue;
    usage.input += message.usage.input;
    usage.output += message.usage.output;
    usage.cacheRead += message.usage.cacheRead;
    usage.cacheWrite += message.usage.cacheWrite;
    usage.totalTokens += message.usage.totalTokens;
    usage.reasoning += message.usage.reasoning ?? 0;
    reportedCost += message.usage.cost?.total ?? 0;
  }
  return { usage, reportedCost };
}

function eventForLog(event: AgentSessionEvent): Record<string, unknown> | null {
  if (event.type === "message_end") return { type: event.type, message: event.message };
  if (event.type === "tool_execution_start") return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
  if (event.type === "tool_execution_end") return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError };
  if (event.type === "agent_settled") return { type: event.type, aborted: event.aborted };
  return null;
}

async function finishStopped(database: AppDatabase, turnId: number): Promise<void> {
  await database.pool.query(
    `update agent_turn set status = 'stopped', finished_at = now()
      where row_id = $1 and status = 'running'`,
    [turnId],
  );
}

async function finishFailed(database: AppDatabase, turnId: number, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await database.pool.query(
    `update agent_turn set status = 'failed', error = $2, finished_at = now()
      where row_id = $1 and status = 'running'`,
    [turnId, message.slice(0, 4_000)],
  );
}

async function executeTurn(
  database: AppDatabase,
  modelRuntime: ModelRuntime,
  agentLog: AgentLog,
  enqueueTurns: EnqueueAgentTurns,
  turnId: number,
  jobSignal: AbortSignal,
): Promise<void> {
  let turn: ClaimedTurn | null = null;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    turn = await claimTurn(database, turnId);
    if (!turn) return;
    const profile = parseAgentProfile(turn.profile);
    const model = modelRuntime.getModel(turn.provider, turn.model);
    if (!model) throw new Error(`model_not_found:${turn.provider}/${turn.model}`);
    const contextText = await buildAgentContext(database, turn.projectId, turn.triggerPostId, turn.agentUserId);
    const systemPrompt = agentSystemPrompt(profile.systemPrompt);
    log(agentLog, "agent.request", {
      turnId: turn.id,
      projectId: turn.projectId,
      provider: turn.provider,
      model: turn.model,
      thinkingLevel: turn.thinkingLevel,
      systemPrompt,
      contextText,
    });

    let draft: Omit<PublishInput, "replyTo"> | null = null;
    const readWebUrls = new Set<string>();
    const searchAccounting = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, reportedCost: 0 };
    let toolCalls = 0;
    const countTool = () => {
      toolCalls += 1;
      if (toolCalls > MAX_TOOL_CALLS) throw new Error("tool_call_limit_reached");
    };
    const readAddress = defineTool({
      name: "read_address",
      label: "Read address",
      description: "Read a bounded preview of one project address.",
      parameters: Type.Object({ address: Type.String({ maxLength: 100 }) }, { additionalProperties: false }),
      async execute(_id, input) {
        countTool();
        const client = await database.pool.connect();
        try {
          const preview = await previewAddress(client, turn!.projectId, input.address, 12_000);
          if (!preview) throw new Error("address_not_found");
          return toolText(preview);
        } finally {
          client.release();
        }
      },
    });
    const search = defineTool({
      name: "search_forum",
      label: "Search forum",
      description: "Full-text search this project when the supplied context is insufficient.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
      async execute(_id, input) {
        countTool();
        return toolText(await searchForum(database, turn!.projectId, input.query));
      },
    });
    const webSearch = defineTool({
      name: "web_search",
      label: "Search web",
      description: "Search the public web for research sources. Results are leads; read relevant URLs with read_web before relying on them.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 500 }),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 15 })),
      }, { additionalProperties: false }),
      async execute(_id, input) {
        countTool();
        const result = await searchWeb(input.query, input.maxResults ?? 8);
        searchAccounting.input += result.usage.input;
        searchAccounting.output += result.usage.output;
        searchAccounting.cacheRead += result.usage.cacheRead;
        searchAccounting.cacheWrite += result.usage.cacheWrite;
        searchAccounting.totalTokens += result.usage.totalTokens;
        searchAccounting.reasoning += result.usage.reasoning ?? 0;
        searchAccounting.reportedCost += result.usage.cost.total;
        log(agentLog, "agent.web_search", {
          turnId: turn!.id,
          query: input.query,
          provider: result.provider,
          model: result.model,
          resultCount: result.results.length,
          usage: result.usage,
        });
        return toolText({ summary: result.summary, results: result.results });
      },
    });
    const readWeb = defineTool({
      name: "read_web",
      label: "Read web source",
      description: "Read and temporarily cache bounded text from a public web page or PDF. This does not add the page to the project Library. PDF reads may select one page.",
      parameters: Type.Object({
        url: Type.String({ minLength: 1, maxLength: 2_000 }),
        page: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_000_000 })),
      }, { additionalProperties: false }),
      async execute(_id, input) {
        countTool();
        const source = await readRemoteSource(input.url, { page: input.page });
        readWebUrls.add(new URL(input.url).href);
        readWebUrls.add(new URL(source.finalUrl).href);
        return toolText(sourceToolResult(source, input.offset ?? 0));
      },
    });
    const saveSource = defineTool({
      name: "save_source",
      label: "Save source",
      description: "Add a public web document read during this turn to the project Library. Use this only for a source worth retaining or citing, and supply its accurate human-readable title.",
      parameters: Type.Object({
        url: Type.String({ minLength: 1, maxLength: 2_000 }),
        title: Type.String({ minLength: 1, maxLength: 500 }),
      }, { additionalProperties: false }),
      async execute(_id, input) {
        countTool();
        const locator = new URL(input.url).href;
        if (!readWebUrls.has(locator)) throw new Error("source_must_be_read_before_saving");
        const registered = await ensureProjectSource(database, {
          projectId: turn!.projectId,
          addedByUserId: turn!.agentUserId,
          locator,
          title: input.title,
        });
        return toolText(registered);
      },
    });
    const readSource = defineTool({
      name: "read_source",
      label: "Read source",
      description: "Read bounded text from one registered public source. PDF reads may select one page; long text may continue from an offset.",
      parameters: Type.Object({
        address: Type.String({ maxLength: 100 }),
        page: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_000_000 })),
      }, { additionalProperties: false }),
      async execute(_id, input) {
        countTool();
        const parsed = parseAddress(input.address);
        if (!parsed || parsed.prefix !== "source" || parsed.fragment) throw new Error("invalid_source_address");
        const result = await database.pool.query<{ locator: string }>(
          "select locator from source where project_id = $1 and local_id = $2",
          [turn!.projectId, parsed.localId],
        );
        if (!result.rows[0]) throw new Error("source_not_found");
        const source = await readRemoteSource(result.rows[0].locator, { page: input.page });
        return toolText({ address: input.address, ...sourceToolResult(source, input.offset ?? 0) });
      },
    });
    const publishReply = defineTool({
      name: "publish_reply",
      label: "Publish reply",
      description: "Validate and set the single final forum reply for this turn. It is committed only after the model turn finishes successfully. This remains available after the research-tool limit; if validation rejects the input, correct it and retry.",
      parameters: agentReplyTypeBox,
      async execute(_id, input) {
        if (draft) throw new Error("final_reply_already_set");
        const candidate = agentReplySchema.parse(input);
        const client = await database.pool.connect();
        try {
          await validatePublishPost(client, {
            projectId: turn!.projectId,
            threadId: turn!.threadId,
            author: { id: turn!.agentUserId, isOwner: false },
            post: { ...candidate, replyTo: formatAddress("post", turn!.triggerLocalId) },
          });
        } finally {
          client.release();
        }
        draft = candidate;
        return toolText("Final reply accepted and will be published when this turn completes.");
      },
    });
    const createThread = defineTool({
      name: "create_thread",
      label: "Create thread",
      description: "Start a distinct discussion in the current subforum. Search first to avoid duplicates. The thread is published immediately and starts with one authorized agent turn.",
      parameters: agentThreadTypeBox,
      async execute(_id, input) {
        countTool();
        const thread = agentThreadSchema.parse(input);
        const published = await publishProjectThread(database, {
          projectId: turn!.projectId,
          author: { id: turn!.agentUserId, isOwner: false },
          thread: { ...thread, subforumId: turn!.subforumId },
          agentTurnLimit: 1,
        }, enqueueTurns);
        return toolText({
          thread: published.thread,
          post: published.post,
          created: published.created,
          queuedTurnIds: published.turnIds,
        });
      },
    });

    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const agentDir = path.resolve(".autoforum", "pi-agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: turn.thinkingLevel,
      noTools: "builtin",
      customTools: [readAddress, search, webSearch, readWeb, saveSource, readSource, createThread, publishReply],
      resourceLoader,
      sessionManager: SessionManager.inMemory(process.cwd()),
      settingsManager,
    }));
    let modelSteps = 0;
    let outputTokens = 0;
    let limitError: string | null = null;
    const unsubscribe = session.subscribe((event) => {
      const entry = eventForLog(event);
      if (entry) log(agentLog, "agent.event", { turnId: turn!.id, ...entry });
      if (event.type === "message_end" && event.message.role === "assistant") {
        modelSteps += 1;
        outputTokens += event.message.usage.output;
        if (modelSteps > MAX_MODEL_STEPS) limitError = "model_step_limit_reached";
        if (outputTokens > MAX_OUTPUT_TOKENS) limitError = "output_token_limit_reached";
        if (limitError) abort();
      }
    });
    function abort(): void {
      void session?.abort().catch((error) => log(agentLog, "agent.abort_failed", {
        turnId: turn!.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    jobSignal.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort();
    }, TURN_TIMEOUT_MS);
    timeout.unref();
    const poll = setInterval(() => void stopWasRequested(database, turn!.id).then((stopped) => {
      if (stopped) abort();
    }).catch(() => undefined), STOP_POLL_MS);
    poll.unref();
    try {
      await session.prompt(contextText);
    } finally {
      clearTimeout(timeout);
      clearInterval(poll);
      jobSignal.removeEventListener("abort", abort);
      unsubscribe();
    }
    if (await stopWasRequested(database, turn.id)) {
      await finishStopped(database, turn.id);
      return;
    }
    if (limitError) throw new Error(limitError);
    if (timedOut) throw new Error("turn_timeout");
    if (jobSignal.aborted) throw new Error("queue_job_aborted");
    const messages = session.state.messages;
    const fallback = lastAssistantText(messages);
    const selectedDraft = draft as Omit<PublishInput, "replyTo"> | null;
    const finalPost: PublishInput = selectedDraft
      ? { ...selectedDraft, replyTo: formatAddress("post", turn.triggerLocalId) }
      : { body: fallback || "I could not produce a reply.", replyTo: formatAddress("post", turn.triggerLocalId), objects: [], excerpts: [] };
    const accounting = usageFrom(messages);
    accounting.usage.input += searchAccounting.input;
    accounting.usage.output += searchAccounting.output;
    accounting.usage.cacheRead += searchAccounting.cacheRead;
    accounting.usage.cacheWrite += searchAccounting.cacheWrite;
    accounting.usage.totalTokens += searchAccounting.totalTokens;
    accounting.usage.reasoning += searchAccounting.reasoning;
    accounting.reportedCost += searchAccounting.reportedCost;
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const published = await publishPost(client, {
        projectId: turn.projectId,
        threadId: turn.threadId,
        author: { id: turn.agentUserId, isOwner: false },
        post: finalPost,
      });
      const completed = await client.query(
        `update agent_turn
            set status = 'completed', output_post_id = $2, usage = $3,
                reported_cost = $4, finished_at = now()
          where row_id = $1 and status = 'running' and stop_requested_at is null`,
        [turn.id, published.postId, accounting.usage, accounting.reportedCost],
      );
      if (completed.rowCount !== 1) throw new Error("turn_stopped_before_publication");
      await client.query("commit");
      if (published.turnIds.length) {
        await enqueueTurns(published.turnIds).catch((error) => console.error("Could not enqueue agent handoffs", error));
      }
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    log(agentLog, "agent.completed", { turnId: turn.id, messages, ...accounting });
  } catch (error) {
    if (turn) {
      if (await stopWasRequested(database, turn.id).catch(() => false)) await finishStopped(database, turn.id);
      else await finishFailed(database, turn.id, error);
      log(agentLog, "agent.failed", {
        turnId: turn.id,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
    } else {
      await finishFailed(database, turnId, error);
      log(agentLog, "agent.failed", {
        turnId,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
    }
  } finally {
    session?.dispose();
  }
}

/** Registers the single local worker and reconciles turns interrupted by a process restart. */
export async function startAgentRunner(
  database: AppDatabase,
  queue: Queue,
  agentLog: AgentLog,
): Promise<void> {
  await database.pool.query(
    `update agent_turn set status = 'failed', error = 'interrupted_by_restart', finished_at = now()
      where status = 'running'`,
  );
  const modelRuntime = await piModelRuntime();
  await queue.workAgentTurns((turnId, signal) => executeTurn(database, modelRuntime, agentLog, queue.enqueueAgentTurns, turnId, signal));
  const queued = await database.pool.query<{ id: number }>(
    "select row_id as id from agent_turn where status = 'queued' order by created_at, row_id",
  );
  await queue.enqueueAgentTurns(queued.rows.map((row) => row.id));
}
