import { Hono } from "hono";
import { z } from "zod";

import { addDefaultAgentsToProject, ensureDefaultAgentUsers } from "./agents/profiles.ts";
import { setProjectTurnLimit, type EnqueueAgentTurns } from "./agents/turns.ts";
import { hasExactBrowserOrigin, readBrowserUser } from "./auth/browser.ts";
import type { AppDatabase } from "./db.ts";

const createProjectInput = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const addMemberInput = z.object({ userId: z.number().int().positive() }).strict();
const updateMemberInput = z.object({ canEditWorkspace: z.boolean() }).strict();
const scribeSelection = z.object({
  provider: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  model: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
}).strict();
const updateProjectSettingsInput = z.object({
  defaultAgentTurnLimit: z.number().int().min(0).max(10_000).optional(),
  agentTurnLimit: z.number().int().min(0).max(1_000_000).optional(),
  scribe: scribeSelection.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

function projectId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function isProjectMember(
  database: AppDatabase,
  userId: number,
  id: number,
): Promise<boolean> {
  const result = await database.pool.query(
    "select 1 from project_member where project_id = $1 and user_id = $2",
    [id, userId],
  );
  return Boolean(result.rows[0]);
}

export async function listProjectsForUser(database: AppDatabase, userId: number) {
  const result = await database.pool.query(
    `select p.row_id as id, p.public_id as "publicId", p.name,
            p.default_agent_turn_limit as "defaultAgentTurnLimit",
            p.agent_turn_limit as "agentTurnLimit",
            (select count(*)::int from agent_turn a
              where a.project_id = p.row_id
                and (a.status in ('queued', 'running', 'completed', 'failed')
                  or (a.status = 'stopped' and a.started_at is not null))) as "agentTurnCount",
            coalesce(p.scribe_provider, fallback.config ->> 'provider') as "scribeProvider",
            coalesce(p.scribe_model, fallback.config ->> 'model') as "scribeModel",
            case when p.scribe_provider is null
              then coalesce(fallback.config ->> 'thinkingLevel', 'off')
              else p.scribe_thinking_level end as "scribeThinkingLevel",
            p.created_at as "createdAt"
       from project p
       join project_member m on m.project_id = p.row_id
       left join lateral (
         select u.agent_config as config
           from project_member agent_member join forum_user u on u.row_id = agent_member.user_id
          where agent_member.project_id = p.row_id
            and u.kind = 'agent' and u.disabled_at is null and u.agent_config is not null
          order by (lower(u.handle) = 'scribe') desc, u.row_id limit 1
       ) fallback on true
      where m.user_id = $1
      order by lower(p.name)`,
    [userId],
  );
  return result.rows;
}

export function createProjectRoutes(
  database: AppDatabase,
  enqueueTurns: EnqueueAgentTurns = async () => undefined,
) {
  const routes = new Hono();

  routes.get("/", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    return context.json({ projects: await listProjectsForUser(database, actor.id) });
  });

  routes.post("/", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const input = createProjectInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);

    await ensureDefaultAgentUsers(database, actor.id);

    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query(
        `insert into project (name)
         values ($1)
         returning row_id as id, public_id as "publicId", name,
                   default_agent_turn_limit as "defaultAgentTurnLimit",
                   agent_turn_limit as "agentTurnLimit", 0::int as "agentTurnCount",
                   scribe_provider as "scribeProvider", scribe_model as "scribeModel",
                   scribe_thinking_level as "scribeThinkingLevel",
                   created_at as "createdAt"`,
        [input.data.name],
      );
      const project = inserted.rows[0];
      await client.query(
        "insert into project_member (project_id, user_id) values ($1, $2)",
        [project.id, actor.id],
      );
      await client.query(
        "insert into subforum (project_id, name) values ($1, 'General')",
        [project.id],
      );
      await addDefaultAgentsToProject(client, project.id);
      await client.query("commit");
      return context.json({ project }, 201);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (isUniqueViolation(error)) return context.json({ error: "project_name_conflict" }, 409);
      throw error;
    } finally {
      client.release();
    }
  });

  routes.patch("/:id/settings", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const id = projectId(context.req.param("id"));
    if (!id) return context.json({ error: "invalid_id" }, 400);
    const input = updateProjectSettingsInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);

    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const turnState = input.data.agentTurnLimit === undefined
        ? null
        : await setProjectTurnLimit(client, id, input.data.agentTurnLimit);
      const scribe = input.data.scribe;
      const updated = await client.query(
        `update project set
           default_agent_turn_limit = coalesce($2, default_agent_turn_limit),
           scribe_provider = case when $3::boolean then $4 else scribe_provider end,
           scribe_model = case when $3::boolean then $5 else scribe_model end,
           scribe_thinking_level = case when $3::boolean then coalesce($6, 'off') else scribe_thinking_level end
         where row_id = $1
         returning row_id`,
        [
          id,
          input.data.defaultAgentTurnLimit ?? null,
          input.data.scribe !== undefined,
          scribe?.provider ?? null,
          scribe?.model ?? null,
          scribe?.thinkingLevel ?? null,
        ],
      );
      if (!updated.rows[0]) {
        await client.query("rollback");
        return context.json({ error: "project_not_found" }, 404);
      }
      await client.query("commit");
      if (turnState?.queuedIds.length) {
        await enqueueTurns(turnState.queuedIds).catch((error) => console.error("Could not enqueue admitted project turns", error));
      }
      return context.json({ ok: true, turnState });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (error instanceof Error && error.message.startsWith("project_agent_turn_limit_below_admitted:")) {
        return context.json({ error: error.message }, 400);
      }
      if (error instanceof Error && error.message === "project_not_found") {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    } finally {
      client.release();
    }
  });

  routes.get("/:id/members", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const id = projectId(context.req.param("id"));
    if (!id) return context.json({ error: "invalid_id" }, 400);
    if (!await isProjectMember(database, actor.id, id)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    const result = await database.pool.query(
      `select u.row_id as id, u.kind, u.handle, u.is_owner as "isOwner", m.joined_at as "joinedAt",
              (u.is_owner or m.can_edit_workspace) as "canEditWorkspace",
              u.created_by_user_id as "ownerUserId", owner.handle as "ownerHandle"
         from project_member m
         join forum_user u on u.row_id = m.user_id
         left join forum_user owner on owner.row_id = u.created_by_user_id
        where m.project_id = $1 and u.disabled_at is null
        order by lower(u.handle)`,
      [id],
    );
    return context.json({ members: result.rows });
  });

  routes.post("/:id/members", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const id = projectId(context.req.param("id"));
    if (!id) return context.json({ error: "invalid_id" }, 400);
    const input = addMemberInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    try {
      const result = await database.pool.query(
        `insert into project_member (project_id, user_id)
         select $1, u.row_id
           from forum_user u
          where u.row_id = $2 and u.disabled_at is null
         returning project_id`,
        [id, input.data.userId],
      );
      return result.rows[0]
        ? context.json({ ok: true }, 201)
        : context.json({ error: "project_or_user_not_found" }, 404);
    } catch (error) {
      if (isUniqueViolation(error)) return context.json({ error: "already_a_member" }, 409);
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
        return context.json({ error: "project_or_user_not_found" }, 404);
      }
      throw error;
    }
  });

  routes.patch("/:id/members/:userId", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const id = projectId(context.req.param("id"));
    const userId = projectId(context.req.param("userId"));
    if (!id || !userId) return context.json({ error: "invalid_id" }, 400);
    const input = updateMemberInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    const result = await database.pool.query(
      `update project_member membership
          set can_edit_workspace = $3
         from forum_user member
        where membership.project_id = $1 and membership.user_id = $2
          and member.row_id = membership.user_id
          and member.kind = 'human' and member.is_owner = false and member.disabled_at is null
      returning membership.user_id`,
      [id, userId, input.data.canEditWorkspace],
    );
    return result.rows[0]
      ? context.json({ ok: true })
      : context.json({ error: "member_not_found_or_owner" }, 404);
  });

  routes.delete("/:id/members/:userId", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const id = projectId(context.req.param("id"));
    const userId = projectId(context.req.param("userId"));
    if (!id || !userId) return context.json({ error: "invalid_id" }, 400);
    const result = await database.pool.query(
      `delete from project_member m
       using forum_user u
       where m.project_id = $1
         and m.user_id = $2
         and u.row_id = m.user_id
         and u.is_owner = false
       returning m.user_id`,
      [id, userId],
    );
    return result.rows[0]
      ? context.json({ ok: true })
      : context.json({ error: "member_not_found_or_owner" }, 404);
  });

  return routes;
}
