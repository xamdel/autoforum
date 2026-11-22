import { Hono } from "hono";
import type { PoolClient } from "pg";
import { z } from "zod";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import { DEFAULT_AGENTS } from "../prompts.ts";

const agentProfileShape = {
  provider: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  model: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).default("off"),
  systemPrompt: z.string().trim().min(1).max(20_000),
};

export const agentProfileSchema = z.object(agentProfileShape).strict().refine((profile) => profile.provider !== "claude-code", {
  message: "Claude Code subscriptions are available to the Scribe only",
  path: ["provider"],
});

// Profiles written before answers-to-mentions became unconditional may still contain this field.
const storedAgentProfileSchema = z.object({ ...agentProfileShape, enabled: z.boolean().optional() }).strict().refine((profile) => profile.provider !== "claude-code", {
  message: "Claude Code subscriptions are available to the Scribe only",
  path: ["provider"],
});

export type AgentProfile = z.infer<typeof agentProfileSchema>;

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parseAgentProfile(value: unknown): AgentProfile {
  const parsed = storedAgentProfileSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid_stored_agent_profile");
  const { enabled: _legacyEnabled, ...profile } = parsed.data;
  return profile;
}

export interface DefaultAgentSeedResult {
  created: number;
  existing: number;
  unavailable: string[];
}

/** Creates missing built-in profiles without replacing an owner's later edits. */
export async function ensureDefaultAgentUsers(
  database: AppDatabase,
  createdByUserId: number,
): Promise<DefaultAgentSeedResult> {
  const client = await database.pool.connect();
  const result: DefaultAgentSeedResult = { created: 0, existing: 0, unavailable: [] };
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('autoforum-default-agent-bootstrap'))");
    for (const agent of DEFAULT_AGENTS) {
      const existing = await client.query<{ kind: string; disabledAt: Date | null }>(
        `select kind, disabled_at as "disabledAt"
           from forum_user where lower(handle) = lower($1)`,
        [agent.handle],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].kind === "agent" && !existing.rows[0].disabledAt) result.existing += 1;
        else result.unavailable.push(agent.handle);
        continue;
      }
      const profile = agentProfileSchema.parse({
        provider: agent.provider,
        model: agent.model,
        thinkingLevel: agent.thinkingLevel,
        systemPrompt: agent.systemPrompt,
      });
      await client.query(
        `insert into forum_user (kind, handle, created_by_user_id, agent_config)
         values ('agent', $1, $2, $3)`,
        [agent.handle, createdByUserId, profile],
      );
      result.created += 1;
    }
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Adds the installation defaults to a newly created project. */
export async function addDefaultAgentsToProject(client: PoolClient, projectId: number): Promise<void> {
  await client.query(
    `insert into project_member (project_id, user_id)
     select $1, row_id from forum_user
      where kind = 'agent' and disabled_at is null and lower(handle) = any($2::text[])
     on conflict do nothing`,
    [projectId, DEFAULT_AGENTS.map((agent) => agent.handle)],
  );
}

export function createAgentProfileRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.get("/agents", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const requestedProjectId = context.req.query("projectId");
    const projectId = requestedProjectId === undefined ? null : positiveId(requestedProjectId);
    if (requestedProjectId !== undefined && !projectId) return context.json({ error: "invalid_id" }, 400);
    if (!actor.isOwner && projectId === null) return context.json({ error: "project_required" }, 400);
    if (projectId !== null) {
      const membership = await database.pool.query(
        "select 1 from project_member where project_id = $1 and user_id = $2",
        [projectId, actor.id],
      );
      if (!membership.rows[0]) return context.json({ error: "project_not_found" }, 404);
    }
    const result = await database.pool.query<{
      userId: number;
      handle: string;
      profile: unknown;
      disabledAt: Date | null;
      ownerUserId: number | null;
      ownerHandle: string | null;
      inProject: boolean;
    }>(
      `select agent.row_id as "userId", agent.handle, agent.agent_config as profile,
              agent.disabled_at as "disabledAt", agent.created_by_user_id as "ownerUserId",
              owner.handle as "ownerHandle",
              ($2::bigint is not null and exists (
                select 1 from project_member member
                 where member.project_id = $2 and member.user_id = agent.row_id
              )) as "inProject"
         from forum_user agent
         left join forum_user owner on owner.row_id = agent.created_by_user_id
        where agent.kind = 'agent'
          and ($1::boolean or agent.created_by_user_id = $3 or (
            $2::bigint is not null and exists (
              select 1 from project_member member
               where member.project_id = $2 and member.user_id = agent.row_id
            )
          ))
        order by lower(agent.handle)`,
      [actor.isOwner, projectId, actor.id],
    );
    return context.json({
      agents: result.rows.map((row) => {
        const parsed = row.profile === null ? null : parseAgentProfile(row.profile);
        const canManage = actor.isOwner || row.ownerUserId === actor.id;
        return {
          ...row,
          profile: canManage ? parsed : null,
          provider: parsed?.provider ?? null,
          model: parsed?.model ?? null,
          thinkingLevel: parsed?.thinkingLevel ?? null,
          canManage,
        };
      }),
    });
  });

  routes.put("/agents/:userId/profile", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const userId = positiveId(context.req.param("userId"));
    if (!userId) return context.json({ error: "invalid_id" }, 400);
    const input = agentProfileSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    const result = await database.pool.query(
      `update forum_user
          set agent_config = $1
        where row_id = $2 and kind = 'agent' and disabled_at is null
          and ($3::boolean or created_by_user_id = $4)
      returning row_id as "userId", handle, agent_config as profile`,
      [input.data, userId, actor.isOwner, actor.id],
    );
    return result.rows[0]
      ? context.json({ agent: result.rows[0] })
      : context.json({ error: "agent_not_found" }, 404);
  });

  return routes;
}
