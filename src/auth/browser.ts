import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono, type Context } from "hono";
import type { PoolClient } from "pg";
import { z } from "zod";

import type { AppDatabase } from "../db.ts";
import { generateSecret, hashSecret } from "./secrets.ts";

const COOKIE_NAME = "autoforum_session";
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1_000;
const SIGN_IN_LINK_MS = 30 * 60 * 1_000;

export interface BrowserUser {
  id: number;
  kind: "human" | "agent";
  handle: string;
  isOwner: boolean;
}

interface UserRow {
  id: number;
  kind: "human" | "agent";
  handle: string;
  is_owner: boolean;
}

function browserUser(row: UserRow): BrowserUser {
  return { id: row.id, kind: row.kind, handle: row.handle, isOwner: row.is_owner };
}

export async function createBrowserSession(
  client: PoolClient,
  userId: number,
): Promise<{ secret: string; expiresAt: Date }> {
  const secret = generateSecret();
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_MS);
  await client.query(
    `insert into browser_session
       (user_id, secret_hash, expires_at, last_seen_at)
     values ($1, $2, $3, now())`,
    [userId, hashSecret(secret), expiresAt],
  );
  return { secret, expiresAt };
}

export function setBrowserSessionCookie(context: Context, secret: string, expiresAt: Date): void {
  const browserOrigin = exactBrowserOrigin(context);
  setCookie(context, COOKIE_NAME, secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production"
      || new URL(context.req.url).protocol === "https:"
      || (browserOrigin !== null && new URL(browserOrigin).protocol === "https:"),
    sameSite: "Strict",
    path: "/",
    expires: expiresAt,
  });
}

function normalizedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function configuredBrowserOrigins(
  environment: NodeJS.ProcessEnv,
  requestOrigin: string,
): string[] {
  const primary = normalizedOrigin(environment.APP_ORIGIN)
    ?? (environment.NODE_ENV === "production" ? requestOrigin : "http://app.autoforum.localhost:5173");
  const shared = normalizedOrigin(environment.AUTOFORUM_SHARE_ORIGIN);
  return shared && shared !== primary ? [primary, shared] : [primary];
}

/** Returns the one exact configured browser origin that made this request, if any. */
export function exactBrowserOrigin(context: Context): string | null {
  const origin = normalizedOrigin(context.req.header("origin"));
  if (!origin) return null;
  const requestOrigin = new URL(context.req.url).origin;
  return configuredBrowserOrigins(process.env, requestOrigin).includes(origin) ? origin : null;
}

export function hasExactBrowserOrigin(context: Context): boolean {
  return exactBrowserOrigin(context) !== null;
}

export async function readBrowserUser(
  context: Context,
  database: AppDatabase,
): Promise<BrowserUser | null> {
  const secret = getCookie(context, COOKIE_NAME);
  if (!secret || secret.length > 256) return null;

  const result = await database.pool.query<UserRow>(
    `select u.row_id as id, u.kind, u.handle, u.is_owner
       from browser_session s
       join forum_user u on u.row_id = s.user_id
      where s.secret_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and coalesce(s.last_seen_at, s.created_at) > now() - interval '7 days'
        and u.disabled_at is null`,
    [hashSecret(secret)],
  );
  const row = result.rows[0];
  if (!row) return null;

  await database.pool.query(
    `update browser_session
        set last_seen_at = now()
      where secret_hash = $1
        and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')`,
    [hashSecret(secret)],
  );
  return browserUser(row);
}

export async function issueSignInLink(
  database: AppDatabase,
  actor: BrowserUser,
  userId: number,
): Promise<{ token: string; expiresAt: Date }> {
  if (!actor.isOwner) throw new Error("owner_required");

  const target = await database.pool.query<{ id: number }>(
    `select row_id as id
       from forum_user
      where row_id = $1 and kind = 'human' and disabled_at is null`,
    [userId],
  );
  if (!target.rows[0]) throw new Error("human_user_not_found");

  const token = generateSecret();
  const expiresAt = new Date(Date.now() + SIGN_IN_LINK_MS);
  await database.pool.query(
    `insert into sign_in_link
       (user_id, secret_hash, expires_at, created_by_user_id)
     values ($1, $2, $3, $4)`,
    [userId, hashSecret(token), expiresAt, actor.id],
  );
  return { token, expiresAt };
}

async function consumeSignInLink(
  database: AppDatabase,
  token: string,
): Promise<{ user: BrowserUser; sessionSecret: string; expiresAt: Date } | null> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    const consumed = await client.query<UserRow>(
      `update sign_in_link l
          set consumed_at = now()
         from forum_user u
        where l.secret_hash = $1
          and l.user_id = u.row_id
          and l.consumed_at is null
          and l.expires_at > now()
          and u.kind = 'human'
          and u.disabled_at is null
      returning u.row_id as id, u.kind, u.handle, u.is_owner`,
      [hashSecret(token)],
    );
    const row = consumed.rows[0];
    if (!row) {
      await client.query("rollback");
      return null;
    }

    const session = await createBrowserSession(client, row.id);
    await client.query("commit");
    return { user: browserUser(row), sessionSecret: session.secret, expiresAt: session.expiresAt };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const signInInput = z.object({ token: z.string().min(32).max(256) }).strict();

export function createBrowserAuthRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.get("/me", async (context) => {
    const user = await readBrowserUser(context, database);
    return user ? context.json({ user }) : context.json({ error: "unauthenticated" }, 401);
  });

  routes.post("/sign-in", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const input = signInInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);

    const signedIn = await consumeSignInLink(database, input.data.token);
    if (!signedIn) return context.json({ error: "invalid_or_expired_link" }, 401);
    setBrowserSessionCookie(context, signedIn.sessionSecret, signedIn.expiresAt);
    return context.json({ user: signedIn.user });
  });

  routes.post("/sign-out", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const secret = getCookie(context, COOKIE_NAME);
    if (secret) {
      await database.pool.query(
        "update browser_session set revoked_at = coalesce(revoked_at, now()) where secret_hash = $1",
        [hashSecret(secret)],
      );
    }
    deleteCookie(context, COOKIE_NAME, { path: "/" });
    return context.json({ ok: true });
  });

  routes.get("/sessions", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const result = await database.pool.query(
      `select s.row_id as id, s.user_id as "userId", u.handle,
              s.created_at as "createdAt", s.last_seen_at as "lastSeenAt",
              s.expires_at as "expiresAt", s.revoked_at as "revokedAt"
         from browser_session s
         join forum_user u on u.row_id = s.user_id
        order by s.created_at desc`,
    );
    return context.json({ sessions: result.rows });
  });

  routes.post("/sessions/:id/revoke", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const id = Number(context.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) return context.json({ error: "invalid_id" }, 400);
    const result = await database.pool.query(
      `update browser_session
          set revoked_at = coalesce(revoked_at, now())
        where row_id = $1
      returning row_id`,
      [id],
    );
    return result.rows[0]
      ? context.json({ ok: true })
      : context.json({ error: "session_not_found" }, 404);
  });

  return routes;
}
