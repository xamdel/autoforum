import { Hono } from "hono";
import { z } from "zod";

import { hasExactBrowserOrigin, issueSignInLink, readBrowserUser, type BrowserUser } from "./auth/browser.ts";
import type { AppDatabase } from "./db.ts";

const handleSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/);
const createUserInput = z.object({
  kind: z.enum(["human", "agent"]),
  handle: handleSchema,
}).strict();

function idFrom(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function ensureInstallationOwner(
  database: AppDatabase,
  requestedHandle: string,
): Promise<BrowserUser> {
  const handle = handleSchema.parse(requestedHandle);
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('autoforum-owner-bootstrap'))");
    const existing = await client.query<{
      id: number;
      kind: "human";
      handle: string;
      is_owner: true;
    }>(
      `select row_id as id, kind, handle, is_owner
         from forum_user
        where is_owner = true and disabled_at is null`,
    );
    let owner = existing.rows[0];
    if (!owner) {
      const inserted = await client.query<{
        id: number;
        kind: "human";
        handle: string;
        is_owner: true;
      }>(
        `insert into forum_user (kind, handle, is_owner)
         values ('human', $1, true)
         returning row_id as id, kind, handle, is_owner`,
        [handle],
      );
      owner = inserted.rows[0];
    }
    if (!owner) throw new Error("owner_bootstrap_failed");

    await client.query(
      `insert into project_member (project_id, user_id)
       select row_id, $1 from project
       on conflict do nothing`,
      [owner.id],
    );
    await client.query("commit");
    return { id: owner.id, kind: owner.kind, handle: owner.handle, isOwner: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createUserRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.get("/", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const result = await database.pool.query(
      `select account.row_id as id, account.kind, account.handle, account.is_owner as "isOwner",
              account.disabled_at as "disabledAt", account.created_at as "createdAt",
              account.created_by_user_id as "ownerUserId", creator.handle as "ownerHandle"
         from forum_user account
         left join forum_user creator on creator.row_id = account.created_by_user_id
        order by lower(account.handle)`,
    );
    return context.json({ users: result.rows });
  });

  routes.post("/", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const input = createUserInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    if (!actor.isOwner && input.data.kind !== "agent") return context.json({ error: "owner_required" }, 403);

    try {
      const result = await database.pool.query(
        `insert into forum_user (kind, handle, created_by_user_id)
         values ($1, $2, $3)
         returning row_id as id, kind, handle, is_owner as "isOwner",
                   disabled_at as "disabledAt", created_at as "createdAt"`,
        [input.data.kind, input.data.handle, actor.id],
      );
      return context.json({ user: result.rows[0] }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) return context.json({ error: "handle_conflict" }, 409);
      throw error;
    }
  });

  routes.post("/:id/disable", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const userId = idFrom(context.req.param("id"));
    if (!userId) return context.json({ error: "invalid_id" }, 400);

    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const disabled = await client.query(
        `update forum_user
            set disabled_at = coalesce(disabled_at, now())
          where row_id = $1 and is_owner = false
            and ($2::boolean or (kind = 'agent' and created_by_user_id = $3))
        returning row_id`,
        [userId, actor.isOwner, actor.id],
      );
      if (!disabled.rows[0]) {
        await client.query("rollback");
        return context.json({ error: "user_not_found_or_owner" }, 404);
      }
      await client.query(
        "update browser_session set revoked_at = coalesce(revoked_at, now()) where user_id = $1",
        [userId],
      );
      await client.query(
        "update mcp_credential set revoked_at = coalesce(revoked_at, now()) where user_id = $1",
        [userId],
      );
      await client.query("commit");
      return context.json({ ok: true });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  routes.post("/:id/sign-in-links", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const userId = idFrom(context.req.param("id"));
    if (!userId) return context.json({ error: "invalid_id" }, 400);
    try {
      const link = await issueSignInLink(database, actor, userId);
      return context.json(link, 201);
    } catch (error) {
      if (error instanceof Error && error.message === "human_user_not_found") {
        return context.json({ error: "human_user_not_found" }, 404);
      }
      throw error;
    }
  });

  return routes;
}
