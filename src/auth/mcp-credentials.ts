import { Hono } from "hono";
import { z } from "zod";

import type { AppDatabase } from "../db.ts";
import { hasExactBrowserOrigin, readBrowserUser, type BrowserUser } from "./browser.ts";
import { generateSecret, hashSecret } from "./secrets.ts";

const createCredentialInput = z.object({
  name: z.string().trim().min(1).max(80),
  expiresAt: z.iso.datetime().nullable().optional(),
}).strict();

function idFrom(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function canManageAgent(database: AppDatabase, actor: BrowserUser, userId: number): Promise<boolean> {
  const result = await database.pool.query(
    `select 1 from forum_user
      where row_id = $1 and kind = 'agent' and disabled_at is null
        and ($2::boolean or created_by_user_id = $3)`,
    [userId, actor.isOwner, actor.id],
  );
  return Boolean(result.rows[0]);
}

export async function authenticateMcpCredential(
  database: AppDatabase,
  authorization: string | undefined,
): Promise<BrowserUser | null> {
  const match = /^Bearer (afmcp_[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!match) return null;
  const result = await database.pool.query<{
    credential_id: number;
    id: number;
    kind: "agent";
    handle: string;
    is_owner: false;
  }>(
    `select c.row_id as credential_id, u.row_id as id, u.kind, u.handle, u.is_owner
       from mcp_credential c
       join forum_user u on u.row_id = c.user_id
      where c.secret_hash = $1
        and c.revoked_at is null
        and (c.expires_at is null or c.expires_at > now())
        and u.kind = 'agent'
        and u.disabled_at is null`,
    [hashSecret(match[1])],
  );
  const row = result.rows[0];
  if (!row) return null;
  await database.pool.query("update mcp_credential set last_used_at = now() where row_id = $1", [row.credential_id]);
  return { id: row.id, kind: row.kind, handle: row.handle, isOwner: false };
}

export function createMcpCredentialRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.get("/users/:userId/mcp-credentials", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const userId = idFrom(context.req.param("userId"));
    if (!userId) return context.json({ error: "invalid_id" }, 400);
    if (!await canManageAgent(database, actor, userId)) return context.json({ error: "agent_not_found" }, 404);
    const result = await database.pool.query(
      `select row_id as id, name, expires_at as "expiresAt",
              last_used_at as "lastUsedAt", revoked_at as "revokedAt",
              created_at as "createdAt"
         from mcp_credential
        where user_id = $1
        order by created_at desc`,
      [userId],
    );
    return context.json({ credentials: result.rows });
  });

  routes.post("/users/:userId/mcp-credentials", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const userId = idFrom(context.req.param("userId"));
    if (!userId) return context.json({ error: "invalid_id" }, 400);
    if (!await canManageAgent(database, actor, userId)) return context.json({ error: "agent_not_found" }, 404);
    const input = createCredentialInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    const token = `afmcp_${generateSecret()}`;
    try {
      const result = await database.pool.query(
        `insert into mcp_credential
           (user_id, name, secret_hash, expires_at, created_by_user_id)
         select u.row_id, $2, $3, $4, $5
           from forum_user u
          where u.row_id = $1 and u.kind = 'agent' and u.disabled_at is null
         returning row_id as id, name, expires_at as "expiresAt", created_at as "createdAt"`,
        [userId, input.data.name, hashSecret(token), input.data.expiresAt ?? null, actor.id],
      );
      const credential = result.rows[0];
      return credential
        ? context.json({ credential, token }, 201)
        : context.json({ error: "agent_user_not_found" }, 404);
    } catch (error) {
      if (isUniqueViolation(error)) return context.json({ error: "credential_name_conflict" }, 409);
      throw error;
    }
  });

  routes.post("/mcp-credentials/:id/revoke", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const id = idFrom(context.req.param("id"));
    if (!id) return context.json({ error: "invalid_id" }, 400);
    const result = await database.pool.query(
      `update mcp_credential credential
          set revoked_at = coalesce(credential.revoked_at, now())
         from forum_user agent
        where credential.row_id = $1
          and agent.row_id = credential.user_id and agent.kind = 'agent'
          and ($2::boolean or agent.created_by_user_id = $3)
      returning credential.row_id`,
      [id, actor.isOwner, actor.id],
    );
    return result.rows[0]
      ? context.json({ ok: true })
      : context.json({ error: "credential_not_found" }, 404);
  });

  return routes;
}
