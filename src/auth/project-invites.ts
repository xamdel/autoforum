import { Hono } from "hono";
import { z } from "zod";

import type { AppDatabase } from "../db.ts";
import {
  createBrowserSession,
  hasExactBrowserOrigin,
  readBrowserUser,
  setBrowserSessionCookie,
  type BrowserUser,
} from "./browser.ts";
import { generateSecret, hashSecret } from "./secrets.ts";

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const handleSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/);
const redeemInput = z.object({ handle: handleSchema.optional() }).strict();

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

interface InviteRow {
  id: number;
  projectId: number;
  projectName: string;
  expiresAt: Date;
  createdByUserId: number;
}

/** One-use bearer invitations create an ordinary human member and their first browser session atomically. */
export function createProjectInviteRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.post("/projects/:projectId/invites", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId) return context.json({ error: "project_not_found" }, 404);

    const token = generateSecret();
    const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS);
    const inserted = await database.pool.query(
      `insert into project_invite (project_id, secret_hash, expires_at, created_by_user_id)
       select row_id, $2, $3, $4 from project where row_id = $1
       returning row_id`,
      [projectId, hashSecret(token), expiresAt, actor.id],
    );
    return inserted.rows[0]
      ? context.json({ token, expiresAt }, 201)
      : context.json({ error: "project_not_found" }, 404);
  });

  routes.get("/project-invites/:token", async (context) => {
    const token = context.req.param("token");
    if (token.length < 32 || token.length > 256) return context.json({ error: "invalid_or_expired_invite" }, 404);
    const result = await database.pool.query<InviteRow>(
      `select i.row_id as id, p.row_id as "projectId", p.name as "projectName",
              i.expires_at as "expiresAt", i.created_by_user_id as "createdByUserId"
         from project_invite i join project p on p.row_id = i.project_id
        where i.secret_hash = $1 and i.consumed_at is null and i.expires_at > now()`,
      [hashSecret(token)],
    );
    const invite = result.rows[0];
    return invite
      ? context.json({ project: { id: invite.projectId, name: invite.projectName }, expiresAt: invite.expiresAt })
      : context.json({ error: "invalid_or_expired_invite" }, 404);
  });

  routes.post("/project-invites/:token/redeem", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const token = context.req.param("token");
    if (token.length < 32 || token.length > 256) return context.json({ error: "invalid_or_expired_invite" }, 404);
    const input = redeemInput.safeParse(await context.req.json().catch(() => ({})));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    const existing = await readBrowserUser(context, database);
    if (!existing && !input.data.handle) return context.json({ error: "handle_required" }, 400);

    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const inviteResult = await client.query<InviteRow>(
        `select i.row_id as id, p.row_id as "projectId", p.name as "projectName",
                i.expires_at as "expiresAt", i.created_by_user_id as "createdByUserId"
           from project_invite i join project p on p.row_id = i.project_id
          where i.secret_hash = $1 and i.consumed_at is null and i.expires_at > now()
          for update of i`,
        [hashSecret(token)],
      );
      const invite = inviteResult.rows[0];
      if (!invite) {
        await client.query("rollback");
        return context.json({ error: "invalid_or_expired_invite" }, 404);
      }

      let user: BrowserUser;
      let session: { secret: string; expiresAt: Date } | null = null;
      if (existing) {
        user = existing;
      } else {
        const inserted = await client.query<{
          id: number;
          kind: "human";
          handle: string;
          is_owner: false;
        }>(
          `insert into forum_user (kind, handle, created_by_user_id)
           values ('human', $1, $2)
           returning row_id as id, kind, handle, is_owner`,
          [input.data.handle, invite.createdByUserId],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("invite_user_creation_failed");
        user = { id: row.id, kind: row.kind, handle: row.handle, isOwner: false };
        session = await createBrowserSession(client, user.id);
      }

      await client.query(
        `insert into project_member (project_id, user_id) values ($1, $2)
         on conflict do nothing`,
        [invite.projectId, user.id],
      );
      await client.query("update project_invite set consumed_at = now() where row_id = $1", [invite.id]);
      await client.query("commit");
      if (session) setBrowserSessionCookie(context, session.secret, session.expiresAt);
      return context.json({ user, project: { id: invite.projectId, name: invite.projectName } }, 201);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (isUniqueViolation(error)) return context.json({ error: "handle_conflict" }, 409);
      throw error;
    } finally {
      client.release();
    }
  });

  return routes;
}
