import { Hono } from "hono";
import type { PoolClient } from "pg";
import { z } from "zod";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import { parseAgentProfile } from "./profiles.ts";

export type EnqueueAgentTurns = (turnIds: number[]) => Promise<void>;

export interface AgentRunnerControl {
  areAgentTurnsPaused(): boolean;
  setAgentTurnsPaused(paused: boolean): Promise<void>;
}

interface CreateMentionTurnsInput {
  projectId: number;
  triggerPostId: number;
  requestedByUserId: number;
  mentionedUserIds: readonly number[];
  requesterIsOwner: boolean;
}

interface LockedThread {
  id: number;
  limit: number;
}

interface LockedProject {
  id: number;
  limit: number;
}

async function lockProject(client: PoolClient, projectId: number): Promise<LockedProject> {
  const result = await client.query<LockedProject>(
    `select row_id as id, agent_turn_limit as "limit"
       from project where row_id = $1
       for update`,
    [projectId],
  );
  if (!result.rows[0]) throw new Error("project_not_found");
  return result.rows[0];
}

async function lockThread(client: PoolClient, projectId: number, threadId: number): Promise<LockedThread> {
  const result = await client.query<LockedThread>(
    `select row_id as id, agent_turn_limit as "limit"
       from thread where row_id = $1 and project_id = $2
       for update`,
    [threadId, projectId],
  );
  if (!result.rows[0]) throw new Error("thread_not_found");
  return result.rows[0];
}

async function lockTriggerThread(client: PoolClient, projectId: number, triggerPostId: number): Promise<LockedThread> {
  const result = await client.query<LockedThread>(
    `select t.row_id as id, t.agent_turn_limit as "limit"
       from thread t join post p on p.thread_id = t.row_id
      where p.row_id = $1 and p.project_id = $2
      for update of t`,
    [triggerPostId, projectId],
  );
  if (!result.rows[0]) throw new Error("trigger_post_not_found");
  return result.rows[0];
}

async function admittedTurnCount(client: PoolClient, threadId: number): Promise<number> {
  const result = await client.query<{ count: number }>(
    `select count(*)::int as count
       from agent_turn a join post p on p.row_id = a.trigger_post_id
      where p.thread_id = $1
        and (a.status in ('queued', 'running', 'completed', 'failed')
          or (a.status = 'stopped' and a.started_at is not null))`,
    [threadId],
  );
  return result.rows[0]?.count ?? 0;
}

async function pendingTurnCount(client: PoolClient, threadId: number): Promise<number> {
  const result = await client.query<{ count: number }>(
    `select count(*)::int as count
       from agent_turn a join post p on p.row_id = a.trigger_post_id
      where p.thread_id = $1 and a.status = 'pending'`,
    [threadId],
  );
  return result.rows[0]?.count ?? 0;
}

async function projectAdmittedTurnCount(client: PoolClient, projectId: number): Promise<number> {
  const result = await client.query<{ count: number }>(
    `select count(*)::int as count
       from agent_turn a
      where a.project_id = $1
        and (a.status in ('queued', 'running', 'completed', 'failed')
          or (a.status = 'stopped' and a.started_at is not null))`,
    [projectId],
  );
  return result.rows[0]?.count ?? 0;
}

async function promotePendingTurns(client: PoolClient, threadId: number, count: number): Promise<number[]> {
  if (count <= 0) return [];
  const waiting = await client.query<{ id: number }>(
    `select a.row_id as id
       from agent_turn a join post p on p.row_id = a.trigger_post_id
      where p.thread_id = $1 and a.status = 'pending'
      order by a.created_at, a.row_id
      limit $2
      for update of a`,
    [threadId, count],
  );
  const ids = waiting.rows.map((row) => row.id);
  if (!ids.length) return [];
  await client.query("update agent_turn set status = 'queued' where row_id = any($1::bigint[]) and status = 'pending'", [ids]);
  return ids;
}

/** Admits the oldest project turns whose own threads still have room. The project row serializes all admissions. */
async function promotePendingProjectTurns(client: PoolClient, projectId: number, count: number): Promise<number[]> {
  if (count <= 0) return [];
  const waiting = await client.query<{ id: number; threadId: number; threadLimit: number; threadAdmitted: number }>(
    `select a.row_id as id, p.thread_id as "threadId", t.agent_turn_limit as "threadLimit",
            (select count(*)::int
               from agent_turn admitted join post admitted_post on admitted_post.row_id = admitted.trigger_post_id
              where admitted_post.thread_id = p.thread_id
                and (admitted.status in ('queued', 'running', 'completed', 'failed')
                  or (admitted.status = 'stopped' and admitted.started_at is not null))) as "threadAdmitted"
       from agent_turn a
       join post p on p.row_id = a.trigger_post_id
       join thread t on t.row_id = p.thread_id
      where a.project_id = $1 and a.status = 'pending'
      order by a.created_at, a.row_id
      for update of a`,
    [projectId],
  );
  const selectedByThread = new Map<number, number>();
  const ids: number[] = [];
  for (const turn of waiting.rows) {
    const selected = selectedByThread.get(turn.threadId) ?? 0;
    if (turn.threadAdmitted + selected >= turn.threadLimit) continue;
    ids.push(turn.id);
    selectedByThread.set(turn.threadId, selected + 1);
    if (ids.length === count) break;
  }
  if (!ids.length) return [];
  await client.query(
    "update agent_turn set status = 'queued' where row_id = any($1::bigint[]) and status = 'pending'",
    [ids],
  );
  return ids;
}

export interface ThreadTurnState {
  limit: number;
  admitted: number;
  pending: number;
  queuedIds: number[];
}

export interface ProjectTurnState {
  limit: number;
  admitted: number;
  queuedIds: number[];
}

/** Sets the cumulative project allowance and admits the oldest waiting turns whose threads have room. */
export async function setProjectTurnLimit(
  client: PoolClient,
  projectId: number,
  requestedLimit: number,
): Promise<ProjectTurnState> {
  const project = await lockProject(client, projectId);
  const admitted = await projectAdmittedTurnCount(client, project.id);
  if (requestedLimit < admitted) throw new Error(`project_agent_turn_limit_below_admitted:${admitted}`);
  await client.query("update project set agent_turn_limit = $2 where row_id = $1", [project.id, requestedLimit]);
  const queuedIds = await promotePendingProjectTurns(client, project.id, requestedLimit - admitted);
  return { limit: requestedLimit, admitted: admitted + queuedIds.length, queuedIds };
}

/** Sets the finite thread allowance and admits the oldest waiting turns into newly available slots. */
export async function setThreadTurnLimit(
  client: PoolClient,
  projectId: number,
  threadId: number,
  requestedLimit: number,
): Promise<ThreadTurnState> {
  const project = await lockProject(client, projectId);
  const thread = await lockThread(client, projectId, threadId);
  const [admitted, projectAdmitted] = await Promise.all([
    admittedTurnCount(client, thread.id),
    projectAdmittedTurnCount(client, project.id),
  ]);
  if (requestedLimit < admitted) throw new Error(`agent_turn_limit_below_admitted:${admitted}`);
  await client.query("update thread set agent_turn_limit = $3 where row_id = $1 and project_id = $2", [thread.id, projectId, requestedLimit]);
  const available = Math.min(requestedLimit - admitted, project.limit - projectAdmitted);
  const queuedIds = await promotePendingTurns(client, thread.id, available);
  return {
    limit: requestedLimit,
    admitted: admitted + queuedIds.length,
    pending: await pendingTurnCount(client, thread.id),
    queuedIds,
  };
}

/** Admits selected waiting turns and extends the thread limit only as far as necessary. */
export async function approvePendingTurns(
  client: PoolClient,
  projectId: number,
  threadId: number,
  requestedTurnIds: readonly number[],
): Promise<ThreadTurnState> {
  const turnIds = [...new Set(requestedTurnIds)];
  if (!turnIds.length) throw new Error("pending_turn_required");
  const project = await lockProject(client, projectId);
  const thread = await lockThread(client, projectId, threadId);
  const selected = await client.query<{ id: number }>(
    `select a.row_id as id
       from agent_turn a join post p on p.row_id = a.trigger_post_id
      where a.row_id = any($1::bigint[]) and a.project_id = $2 and p.thread_id = $3 and a.status = 'pending'
      for update of a`,
    [turnIds, projectId, thread.id],
  );
  if (selected.rows.length !== turnIds.length) throw new Error("pending_turn_not_found");
  const [admitted, projectAdmitted] = await Promise.all([
    admittedTurnCount(client, thread.id),
    projectAdmittedTurnCount(client, project.id),
  ]);
  const nextLimit = Math.max(thread.limit, admitted + turnIds.length);
  await client.query("update thread set agent_turn_limit = $3 where row_id = $1 and project_id = $2", [thread.id, projectId, nextLimit]);
  const nextProjectLimit = Math.max(project.limit, projectAdmitted + turnIds.length);
  if (nextProjectLimit !== project.limit) {
    await client.query("update project set agent_turn_limit = $2 where row_id = $1", [project.id, nextProjectLimit]);
  }
  await client.query(
    "update agent_turn set status = 'queued' where row_id = any($1::bigint[]) and status = 'pending'",
    [turnIds],
  );
  const queuedIds = [...turnIds];
  const additionallyQueued = await promotePendingTurns(
    client,
    thread.id,
    Math.min(nextLimit - admitted - queuedIds.length, nextProjectLimit - projectAdmitted - queuedIds.length),
  );
  queuedIds.push(...additionallyQueued);
  return {
    limit: nextLimit,
    admitted: admitted + queuedIds.length,
    pending: await pendingTurnCount(client, thread.id),
    queuedIds,
  };
}

/** Creates one durable turn per built-in agent mention and admits only what this thread authorizes. */
export async function createMentionTurns(
  client: PoolClient,
  input: CreateMentionTurnsInput,
): Promise<number[]> {
  if (!input.mentionedUserIds.length) return [];
  const agents = await client.query<{ userId: number; profile: unknown }>(
    `select u.row_id as "userId", u.agent_config as profile
       from forum_user u join project_member m on m.user_id = u.row_id
      where m.project_id = $1 and u.row_id = any($2::bigint[])
        and u.kind = 'agent' and u.disabled_at is null and u.agent_config is not null`,
    [input.projectId, input.mentionedUserIds],
  );
  const agentsByUserId = new Map(agents.rows.map((agent) => [agent.userId, agent]));
  const runnable = input.mentionedUserIds.flatMap((userId) => {
    const agent = agentsByUserId.get(userId);
    if (!agent || agent.userId === input.requestedByUserId) return [];
    return [{ ...agent, parsed: parseAgentProfile(agent.profile) }];
  });
  if (!runnable.length) return [];
  const project = await lockProject(client, input.projectId);
  const thread = await lockTriggerThread(client, input.projectId, input.triggerPostId);
  const [admitted, projectAdmitted] = await Promise.all([
    admittedTurnCount(client, thread.id),
    projectAdmittedTurnCount(client, project.id),
  ]);
  const turnIds: number[] = [];
  for (const agent of runnable) {
    const profile = agent.parsed;
    const inserted = await client.query<{ id: number }>(
      `insert into agent_turn
         (project_id, agent_user_id, requested_by_user_id, trigger_post_id,
          status, provider, model, thinking_level)
       values ($1, $2, $3, $4, 'pending', $5, $6, $7)
       on conflict (trigger_post_id, agent_user_id) do nothing
       returning row_id as id`,
      [input.projectId, agent.userId, input.requestedByUserId, input.triggerPostId,
        profile.provider, profile.model, profile.thinkingLevel],
    );
    if (inserted.rows[0]) turnIds.push(inserted.rows[0].id);
  }
  if (!turnIds.length) return [];

  let limit = thread.limit;
  let projectLimit = project.limit;
  const queuedIds: number[] = [];
  if (input.requesterIsOwner) {
    limit = Math.max(limit, admitted + turnIds.length);
    projectLimit = Math.max(projectLimit, projectAdmitted + turnIds.length);
    if (limit !== thread.limit) {
      await client.query("update thread set agent_turn_limit = $2 where row_id = $1", [thread.id, limit]);
    }
    if (projectLimit !== project.limit) {
      await client.query("update project set agent_turn_limit = $2 where row_id = $1", [project.id, projectLimit]);
    }
    await client.query(
      "update agent_turn set status = 'queued' where row_id = any($1::bigint[]) and status = 'pending'",
      [turnIds],
    );
    queuedIds.push(...turnIds);
  }
  queuedIds.push(...await promotePendingTurns(
    client,
    thread.id,
    Math.min(limit - admitted - queuedIds.length, projectLimit - projectAdmitted - queuedIds.length),
  ));
  return queuedIds;
}

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function isProjectMember(database: AppDatabase, userId: number, projectId: number): Promise<boolean> {
  const result = await database.pool.query(
    "select 1 from project_member where project_id = $1 and user_id = $2",
    [projectId, userId],
  );
  return Boolean(result.rows[0]);
}

/** Owner-only status and cancellation endpoints. The worker owns running-turn transitions. */
const approveInput = z.object({ turnIds: z.array(z.number().int().positive()).min(1).max(100) }).strict();
const runnerInput = z.object({ paused: z.boolean() }).strict();

export function createAgentTurnRoutes(
  database: AppDatabase,
  enqueueTurns: EnqueueAgentTurns = async () => undefined,
  runner?: AgentRunnerControl,
) {
  const routes = new Hono();

  routes.get("/agent-runner", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    if (!runner) return context.json({ error: "agent_runner_unavailable" }, 503);
    return context.json({ paused: runner.areAgentTurnsPaused() });
  });

  routes.put("/agent-runner", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    if (!runner) return context.json({ error: "agent_runner_unavailable" }, 503);
    const input = runnerInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    await runner.setAgentTurnsPaused(input.data.paused);
    return context.json({ paused: runner.areAgentTurnsPaused() });
  });

  routes.get("/projects/:projectId/agent-turns", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    const threadId = context.req.query("threadId") ? positiveId(context.req.query("threadId") ?? "") : null;
    if (context.req.query("threadId") && !threadId) return context.json({ error: "invalid_thread" }, 400);
    const result = await database.pool.query(
      `select a.row_id as id, a.status, a.provider, a.model, a.thinking_level as "thinkingLevel",
              a.usage, a.reported_cost as "reportedCost", a.error,
              a.stop_requested_at as "stopRequestedAt", a.started_at as "startedAt",
              a.finished_at as "finishedAt", a.created_at as "createdAt",
              u.handle as agent, requester.handle as "requestedBy",
              p.local_id as "triggerLocalId", output.local_id as "outputLocalId"
         from agent_turn a
         join forum_user u on u.row_id = a.agent_user_id
         join forum_user requester on requester.row_id = a.requested_by_user_id
         join post p on p.row_id = a.trigger_post_id
         left join post output on output.row_id = a.output_post_id
        where a.project_id = $1 and ($2::bigint is null or p.thread_id = $2)
        order by a.created_at desc, a.row_id desc limit 100`,
      [projectId, threadId],
    );
    return context.json({ turns: result.rows });
  });

  routes.post("/projects/:projectId/threads/:threadId/agent-turns/approve", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const projectId = positiveId(context.req.param("projectId"));
    const threadId = positiveId(context.req.param("threadId"));
    const input = approveInput.safeParse(await context.req.json().catch(() => null));
    if (!projectId || !threadId || !input.success || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: !input.success ? "invalid_input" : "thread_not_found" }, !input.success ? 400 : 404);
    }
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const state = await approvePendingTurns(client, projectId, threadId, input.data.turnIds);
      await client.query("commit");
      await enqueueTurns(state.queuedIds).catch((error) => console.error("Could not enqueue approved agent turns", error));
      return context.json({ state });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (error instanceof Error && /^(thread_not_found|pending_turn_)/.test(error.message)) {
        return context.json({ error: error.message }, error.message === "thread_not_found" ? 404 : 400);
      }
      throw error;
    } finally {
      client.release();
    }
  });

  routes.post("/projects/:projectId/agent-turns/:turnId/stop", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const projectId = positiveId(context.req.param("projectId"));
    const turnId = positiveId(context.req.param("turnId"));
    if (!projectId || !turnId) return context.json({ error: "turn_not_found" }, 404);
    const result = await database.pool.query<{ status: string }>(
      `update agent_turn
          set stop_requested_at = coalesce(stop_requested_at, now()),
              status = case when status in ('pending', 'queued') then 'stopped' else status end,
              finished_at = case when status in ('pending', 'queued') then now() else finished_at end
        where row_id = $1 and project_id = $2 and status in ('pending', 'queued', 'running')
      returning status`,
      [turnId, projectId],
    );
    return result.rows[0]
      ? context.json({ status: result.rows[0].status })
      : context.json({ error: "turn_not_found_or_finished" }, 404);
  });

  return routes;
}
