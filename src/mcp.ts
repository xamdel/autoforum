import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";

import type { EnqueueAgentTurns } from "./agents/turns.ts";
import type { BrowserUser } from "./auth/browser.ts";
import { authenticateMcpCredential } from "./auth/mcp-credentials.ts";
import type { AppDatabase } from "./db.ts";
import { publishInputSchema, publishProjectPost } from "./forum/publish.ts";
import { listMentions, readForumAddress, searchForum } from "./forum/queries.ts";
import { listProjectSubforums } from "./forum/subforums.ts";
import { listProjectThreads, publishProjectThread, publishThreadInputSchema } from "./forum/threads.ts";
import { isProjectMember, listProjectsForUser } from "./projects.ts";
import { readSourceAddress } from "./sources/reader.ts";

const idSchema = z.number().int().positive();
const projectInputSchema = z.object({ projectId: idSchema }).strict();
const readAddressInputSchema = projectInputSchema.extend({ address: z.string().min(1).max(100) }).strict();
const searchInputSchema = projectInputSchema.extend({ query: z.string().trim().min(1).max(500) }).strict();
const mentionsInputSchema = projectInputSchema.extend({ after: z.string().min(1).max(100).optional() }).strict();
const publishToolInputSchema = publishInputSchema.extend({ projectId: idSchema, threadId: idSchema }).strict();
const createThreadToolInputSchema = publishThreadInputSchema.extend({ projectId: idSchema }).strict();
const SOURCE_TEXT_LIMIT = 16_000;

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function requireProject(database: AppDatabase, actor: BrowserUser, projectId: number): Promise<void> {
  if (!await isProjectMember(database, actor.id, projectId)) throw new Error("project_not_found");
}

export function createMcpServer(
  database: AppDatabase,
  actor: BrowserUser,
  enqueueTurns: EnqueueAgentTurns = async () => undefined,
): McpServer {
  const server = new McpServer({ name: "autoforum", version: "1.0.0" }, { maxToolInputElements: 500 });

  server.registerTool("list_projects", {
    description: "List Autoforum projects available to this external agent.",
    annotations: { readOnlyHint: true },
  }, async () => result({ projects: await listProjectsForUser(database, actor.id) }));

  server.registerTool("list_threads", {
    description: "List the threads in one accessible project.",
    inputSchema: projectInputSchema,
    annotations: { readOnlyHint: true },
  }, async ({ projectId }) => {
    await requireProject(database, actor, projectId);
    return result({ threads: await listProjectThreads(database, projectId) });
  });

  server.registerTool("list_subforums", {
    description: "List the subforums in one accessible project so a new thread can be placed deliberately.",
    inputSchema: projectInputSchema,
    annotations: { readOnlyHint: true },
  }, async ({ projectId }) => {
    await requireProject(database, actor, projectId);
    return result({ subforums: await listProjectSubforums(database, projectId) });
  });

  server.registerTool("read_address", {
    description: "Read a bounded representation of one project-local address such as post:12 or claim:8.",
    inputSchema: readAddressInputSchema,
    annotations: { readOnlyHint: true },
  }, async ({ projectId, address }) => {
    await requireProject(database, actor, projectId);
    const record = await readForumAddress(database, projectId, address);
    if (!record) throw new Error("address_not_found");
    return result({ record });
  });

  server.registerTool("search_forum", {
    description: "Search threads, posts, discourse objects, sources, and excerpts in one accessible project.",
    inputSchema: searchInputSchema,
    annotations: { readOnlyHint: true },
  }, async ({ projectId, query }) => {
    await requireProject(database, actor, projectId);
    return result({ results: await searchForum(database, projectId, query) });
  });

  server.registerTool("read_source", {
    description: "Fetch bounded untrusted text from one registered public source address without persisting it.",
    inputSchema: readAddressInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ projectId, address }) => {
    await requireProject(database, actor, projectId);
    const source = await readSourceAddress(database, projectId, address);
    const truncated = source.text.length > SOURCE_TEXT_LIMIT;
    return result({
      source: {
        ...source,
        text: truncated ? `${source.text.slice(0, SOURCE_TEXT_LIMIT)}\n[truncated]` : source.text,
        truncated,
      },
    });
  });

  server.registerTool("publish_post", {
    description: "Atomically publish one reply with optional excerpts and discourse objects in an accessible thread.",
    inputSchema: publishToolInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ projectId, threadId, ...post }) => {
    const published = await publishProjectPost(database, {
      projectId,
      threadId,
      author: actor,
      post,
    }, enqueueTurns);
    return result({ post: published.post, created: published.created });
  });

  server.registerTool("create_thread", {
    description: "Create a thread and structured opening post in an accessible subforum. Agent-created threads begin with one authorized agent turn.",
    inputSchema: createThreadToolInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ projectId, ...thread }) => {
    const published = await publishProjectThread(database, {
      projectId,
      author: actor,
      thread,
      agentTurnLimit: actor.kind === "agent" ? 1 : undefined,
    }, enqueueTurns);
    return result({ thread: published.thread, post: published.post, created: published.created });
  });

  server.registerTool("list_mentions", {
    description: "List posts that mention this external agent, optionally after a post address cursor.",
    inputSchema: mentionsInputSchema,
    annotations: { readOnlyHint: true },
  }, async ({ projectId, after }) => {
    await requireProject(database, actor, projectId);
    return result({ mentions: await listMentions(database, projectId, actor.id, after) });
  });

  return server;
}

function protocolError(status: number, message: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    error: { code: status === 405 ? -32_000 : -32_001, message },
    id: null,
  }, { status });
}

/** Stateless Streamable HTTP: every request reauthenticates and owns its short-lived transport. */
export function createMcpRoutes(database: AppDatabase, enqueueTurns: EnqueueAgentTurns = async () => undefined) {
  const routes = new Hono();

  routes.all("/", async (context) => {
    const actor = await authenticateMcpCredential(database, context.req.header("Authorization"));
    if (!actor) {
      return new Response(JSON.stringify({ error: "unauthenticated" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer realm=\"autoforum-mcp\"",
        },
      });
    }
    if (context.req.method !== "POST") return protocolError(405, "Method not allowed.");

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(database, actor, enqueueTurns);
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(context.req.raw);
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  return routes;
}
