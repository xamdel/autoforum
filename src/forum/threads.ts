import { Hono } from "hono";
import type { PoolClient } from "pg";
import { z } from "zod";

import { setThreadTurnLimit, type EnqueueAgentTurns } from "../agents/turns.ts";
import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import { isProjectMember } from "../projects.ts";
import { listThreadResults } from "./results.ts";
import { formatAddress, parseAddress, reserveProjectAddresses } from "./addresses.ts";
import { publishInputSchema, publishPost, type PublishPostResult } from "./publish.ts";

export const publishThreadInputSchema = publishInputSchema.omit({ replyTo: true }).extend({
  subforumId: z.number().int().positive(),
  title: z.string().trim().min(1).max(240),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
}).strict();
export type PublishThreadInput = z.infer<typeof publishThreadInputSchema>;

export interface PublishThreadResult extends PublishPostResult {
  threadId: number;
  thread: string;
}

interface PublishThreadOptions {
  projectId: number;
  author: { id: number; isOwner: boolean };
  thread: PublishThreadInput;
  agentTurnLimit?: number;
}

/** Creates a thread and its structured opening post. The caller owns the transaction. */
export async function publishThread(client: PoolClient, input: PublishThreadOptions): Promise<PublishThreadResult> {
  const membership = await client.query<{ defaultAgentTurnLimit: number }>(
    `select p.default_agent_turn_limit as "defaultAgentTurnLimit"
       from project_member m join project p on p.row_id = m.project_id
      where m.project_id = $1 and m.user_id = $2`,
    [input.projectId, input.author.id],
  );
  if (!membership.rows[0]) throw new Error("project_not_found");
  const agentTurnLimit = input.agentTurnLimit ?? membership.rows[0].defaultAgentTurnLimit;
  if (!Number.isSafeInteger(agentTurnLimit) || agentTurnLimit < 0) throw new Error("invalid_agent_turn_limit");
  const subforum = await client.query(
    "select 1 from subforum where row_id = $1 and project_id = $2",
    [input.thread.subforumId, input.projectId],
  );
  if (!subforum.rows[0]) throw new Error("subforum_not_found");

  const localId = await reserveProjectAddresses(client, input.projectId, 1);
  const inserted = await client.query<{ id: number }>(
    `insert into thread
       (project_id, subforum_id, local_id, title, tags, created_by_user_id, agent_turn_limit)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning row_id as id`,
    [input.projectId, input.thread.subforumId, localId, input.thread.title,
      [...new Set(input.thread.tags)], input.author.id, agentTurnLimit],
  );
  const threadId = inserted.rows[0]?.id;
  if (!threadId) throw new Error("thread_insert_failed");
  const published = await publishPost(client, {
    projectId: input.projectId,
    threadId,
    author: input.author,
    post: {
      body: input.thread.body,
      excerpts: input.thread.excerpts,
      objects: input.thread.objects,
    },
  });
  return { threadId, thread: formatAddress("thread", localId), ...published };
}

/** Runs the complete thread-publication transaction shared by browser, MCP, and model callers. */
export async function publishProjectThread(
  database: AppDatabase,
  input: PublishThreadOptions,
  enqueueTurns: EnqueueAgentTurns = async () => undefined,
): Promise<PublishThreadResult> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    const published = await publishThread(client, input);
    await client.query("commit");
    await enqueueTurns(published.turnIds).catch((error) => console.error("Could not enqueue agent turns", error));
    return published;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
const updateThreadInput = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  pinned: z.boolean().optional(),
  agentTurnLimit: z.number().int().min(0).max(10_000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function listProjectThreads(database: AppDatabase, projectId: number) {
  const result = await database.pool.query(
    `select t.row_id as id, t.local_id as "localId", t.subforum_id as "subforumId",
            s.name as "subforumName", t.title, t.tags, t.pinned,
            t.created_at as "createdAt", u.handle as "createdBy",
            count(p.row_id)::int as "postCount", max(p.created_at) as "lastPostAt"
       from thread t
       join subforum s on s.row_id = t.subforum_id
       join forum_user u on u.row_id = t.created_by_user_id
       left join post p on p.thread_id = t.row_id
      where t.project_id = $1
      group by t.row_id, s.name, u.handle
      order by t.pinned desc, max(p.created_at) desc, t.created_at desc`,
    [projectId],
  );
  return result.rows.map((row) => ({ ...row, address: formatAddress("thread", row.localId) }));
}

export function createThreadRoutes(database: AppDatabase, enqueueTurns: EnqueueAgentTurns = async () => undefined) {
  const routes = new Hono();

  routes.get("/projects/:projectId/threads", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    return context.json({ threads: await listProjectThreads(database, projectId) });
  });

  routes.post("/projects/:projectId/threads", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId) return context.json({ error: "project_not_found" }, 404);
    const input = publishThreadInputSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);

    try {
      const published = await publishProjectThread(database, {
        projectId,
        author: actor,
        thread: input.data,
        agentTurnLimit: actor.kind === "agent" ? 1 : undefined,
      }, enqueueTurns);
      return context.json({
        thread: { id: published.threadId, address: published.thread },
        post: published.post,
        created: published.created,
        turnIds: published.turnIds,
      }, 201);
    } catch (error) {
      if (error instanceof Error && /^(invalid_|unknown_|address_|source_|reply_|object_|relation_|duplicate_|expected_|thread_|subforum_|project_)/.test(error.message)) {
        const status = error.message === "project_not_found" ? 404 : 400;
        return context.json({ error: error.message }, status);
      }
      throw error;
    }
  });

  routes.get("/projects/:projectId/threads/:threadId", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    const threadId = positiveId(context.req.param("threadId"));
    if (!projectId || !threadId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "thread_not_found" }, 404);
    }
    const threadResult = await database.pool.query(
      `select t.row_id as id, t.local_id as "localId", t.subforum_id as "subforumId",
              s.name as "subforumName", t.title, t.tags, t.pinned,
              t.agent_turn_limit as "agentTurnLimit",
              (select count(*)::int from agent_turn a join post trigger on trigger.row_id = a.trigger_post_id
                where trigger.thread_id = t.row_id
                  and (a.status in ('queued', 'running', 'completed', 'failed')
                    or (a.status = 'stopped' and a.started_at is not null))) as "agentTurnCount",
              (select count(*)::int from agent_turn a join post trigger on trigger.row_id = a.trigger_post_id
                where trigger.thread_id = t.row_id and a.status = 'pending') as "pendingTurnCount",
              t.created_at as "createdAt", u.handle as "createdBy"
         from thread t
         join subforum s on s.row_id = t.subforum_id
         join forum_user u on u.row_id = t.created_by_user_id
        where t.row_id = $1 and t.project_id = $2`,
      [threadId, projectId],
    );
    const thread = threadResult.rows[0];
    if (!thread) return context.json({ error: "thread_not_found" }, 404);
    const [postResult, objectResult, excerptResult, results] = await Promise.all([
      database.pool.query(
        `select p.row_id as id, p.local_id as "localId", p.author_user_id as "authorId",
                u.handle as author, p.reply_to_post_id as "replyToPostId", p.body, p.refs,
                p.created_at as "createdAt", a.provider as "agentProvider",
                a.model as "agentModel", a.thinking_level as "agentThinkingLevel"
           from post p join forum_user u on u.row_id = p.author_user_id
           left join agent_turn a on a.output_post_id = p.row_id and a.status = 'completed'
          where p.thread_id = $1 and p.project_id = $2
          order by p.local_id`,
        [threadId, projectId],
      ),
      database.pool.query(
        `select d.row_id as id, d.local_id as "localId", d.kind, d.label, d.body,
                d.expected_outputs as "expectedOutputs", d.born_in_post_id as "bornInPostId",
                d.relation_type as "relationType", d.subjects, d.objects, d.refs,
                u.handle as creator, d.created_at as "createdAt"
           from discourse_object d join forum_user u on u.row_id = d.creator_user_id
           join post p on p.row_id = d.born_in_post_id
          where p.thread_id = $1 and d.project_id = $2
          order by d.local_id`,
        [threadId, projectId],
      ),
      database.pool.query(
        `select e.row_id as id, e.local_id as "localId", e.content, e.locator,
                e.captured_from as "capturedFrom", e.born_in_post_id as "bornInPostId",
                s.local_id as "sourceLocalId", s.title as "sourceTitle", e.created_at as "createdAt"
           from excerpt e join source s on s.row_id = e.source_id
           join post p on p.row_id = e.born_in_post_id
          where p.thread_id = $1 and e.project_id = $2
          order by e.local_id`,
        [threadId, projectId],
      ),
      listThreadResults(database, projectId, threadId),
    ]);
    const citedExcerptIds = [...new Set(postResult.rows
      .flatMap((row) => row.refs as string[])
      .map((address) => parseAddress(address))
      .filter((address) => address?.prefix === "excerpt" && !address.fragment)
      .map((address) => address!.localId))];
    const citationResult = citedExcerptIds.length ? await database.pool.query(
      `select e.local_id as "excerptLocalId", s.local_id as "sourceLocalId", s.title as "sourceTitle"
         from excerpt e join source s on s.row_id = e.source_id
        where e.project_id = $1 and e.local_id = any($2::bigint[])
        order by e.local_id`,
      [projectId, citedExcerptIds],
    ) : { rows: [] };
    const postAddresses = new Map(postResult.rows.map((row) => [row.id, formatAddress("post", row.localId)]));
    return context.json({
      thread: { ...thread, address: formatAddress("thread", thread.localId) },
      posts: postResult.rows.map((row) => {
        const { agentProvider, agentModel, agentThinkingLevel, ...post } = row;
        return {
          ...post,
          address: formatAddress("post", row.localId),
          replyToAddress: row.replyToPostId ? postAddresses.get(row.replyToPostId) ?? null : null,
          agentTurn: agentProvider && agentModel && agentThinkingLevel
            ? { provider: agentProvider, model: agentModel, thinkingLevel: agentThinkingLevel }
            : null,
        };
      }),
      objects: objectResult.rows.map((row) => ({ ...row, address: formatAddress(row.kind === "relation" ? "rel" : row.kind, row.localId) })),
      excerpts: excerptResult.rows.map((row) => ({
        ...row,
        address: formatAddress("excerpt", row.localId),
        sourceAddress: formatAddress("source", row.sourceLocalId),
      })),
      excerptCitations: citationResult.rows.map((row) => ({
        excerptAddress: formatAddress("excerpt", row.excerptLocalId),
        sourceAddress: formatAddress("source", row.sourceLocalId),
        sourceTitle: row.sourceTitle,
      })),
      results,
    });
  });

  routes.patch("/projects/:projectId/threads/:threadId", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    const threadId = positiveId(context.req.param("threadId"));
    if (!projectId || !threadId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "thread_not_found" }, 404);
    }
    const input = updateThreadInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    if (input.data.agentTurnLimit !== undefined && !actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update thread set
           title = coalesce($3, title), tags = coalesce($4, tags), pinned = coalesce($5, pinned)
         where row_id = $1 and project_id = $2
         returning row_id`,
        [threadId, projectId, input.data.title ?? null, input.data.tags ? [...new Set(input.data.tags)] : null, input.data.pinned ?? null],
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return context.json({ error: "thread_not_found" }, 404);
      }
      const state = input.data.agentTurnLimit === undefined
        ? null
        : await setThreadTurnLimit(client, projectId, threadId, input.data.agentTurnLimit);
      await client.query("commit");
      if (state?.queuedIds.length) {
        await enqueueTurns(state.queuedIds).catch((error) => console.error("Could not enqueue admitted agent turns", error));
      }
      return context.json({ ok: true, state });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (error instanceof Error && error.message.startsWith("agent_turn_limit_below_admitted:")) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    } finally {
      client.release();
    }
  });

  return routes;
}
