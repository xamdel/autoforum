import { Hono } from "hono";
import type { PoolClient } from "pg";

import { readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import { isProjectMember } from "../projects.ts";
import { addressExists, formatAddress, parseAddress, placeAddress, previewAddress, resolveAddress, type AddressPrefix } from "./addresses.ts";

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function objectPrefix(kind: string): AddressPrefix {
  return kind === "relation" ? "rel" : kind as AddressPrefix;
}

export async function findMentionedUserIds(client: PoolClient, projectId: number, body: string): Promise<number[]> {
  const handles = [...new Set([...body.matchAll(/(?:^|[^a-zA-Z0-9_-])@([a-z][a-z0-9_-]{1,31})\b/g)]
    .map((match) => match[1].toLowerCase()))];
  if (!handles.length) return [];
  const result = await client.query<{ id: number; handle: string }>(
    `select u.row_id as id, lower(u.handle) as handle
       from forum_user u join project_member m on m.user_id = u.row_id
      where m.project_id = $1 and lower(u.handle) = any($2::text[]) and u.disabled_at is null`,
    [projectId, handles],
  );
  const idsByHandle = new Map(result.rows.map((row) => [row.handle, row.id]));
  return handles.flatMap((handle) => {
    const id = idsByHandle.get(handle);
    return id === undefined ? [] : [id];
  });
}

export async function searchForum(database: AppDatabase, projectId: number, query: string) {
  const result = await database.pool.query(
    `select kind, "localId", heading, snippet, "createdAt" from (
       select 'thread' as kind, local_id as "localId", title as heading, null::text as snippet, created_at as "createdAt"
         from thread where project_id = $1 and to_tsvector('english', title) @@ plainto_tsquery('english', $2)
       union all
       select 'post', local_id, null, left(body, 500), created_at
         from post where project_id = $1 and to_tsvector('english', body) @@ plainto_tsquery('english', $2)
       union all
       select kind, local_id, label, left(body, 500), created_at
         from discourse_object where project_id = $1 and to_tsvector('english', coalesce(body, '')) @@ plainto_tsquery('english', $2)
       union all
       select 'source', local_id, title, locator, created_at
         from source where project_id = $1 and to_tsvector('english', title || ' ' || locator) @@ plainto_tsquery('english', $2)
       union all
       select 'excerpt', local_id, locator, left(content, 500), created_at
         from excerpt where project_id = $1 and to_tsvector('english', coalesce(content, '')) @@ plainto_tsquery('english', $2)
       union all
       select 'result', local_id, submission_id, left(outputs::text, 500), created_at
         from result where project_id = $1 and to_tsvector('english', outputs::text) @@ plainto_tsquery('english', $2)
     ) found order by "createdAt" desc limit 50`,
    [projectId, query],
  );
  return result.rows.map((row) => ({
    ...row,
    address: formatAddress(objectPrefix(row.kind), row.localId),
  }));
}

export async function readForumAddress(database: AppDatabase, projectId: number, address: string) {
  const client = await database.pool.connect();
  try {
    return await previewAddress(client, projectId, address, 12_000);
  } finally {
    client.release();
  }
}

export async function listMentions(
  database: AppDatabase,
  projectId: number,
  userId: number,
  afterAddress?: string,
) {
  const after = afterAddress ? parseAddress(afterAddress) : null;
  if (afterAddress && (!after || after.prefix !== "post" || after.fragment)) throw new Error("invalid_cursor");
  const result = await database.pool.query(
    `select p.local_id as "localId", p.body, p.created_at as "createdAt",
            t.row_id as "threadId", t.title, u.handle as author
       from post p
       join thread t on t.row_id = p.thread_id
       join forum_user u on u.row_id = p.author_user_id
      where p.project_id = $1 and $2 = any(p.mentioned_user_ids) and p.local_id > $3
      order by p.local_id limit 100`,
    [projectId, userId, after?.localId ?? 0],
  );
  return result.rows.map((row) => ({ ...row, address: formatAddress("post", row.localId) }));
}

export function createForumQueryRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.get("/projects/:projectId/address/:address", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "address_not_found" }, 404);
    }
    const address = decodeURIComponent(context.req.param("address"));
    const client = await database.pool.connect();
    try {
      const record = await resolveAddress(client, projectId, address);
      if (!record) return context.json({ error: "address_not_found" }, 404);
      const place = await placeAddress(client, projectId, parseAddress(address)!.prefix, record);
      return context.json({ address, record, ...place });
    } finally {
      client.release();
    }
  });

  routes.get("/projects/:projectId/address-preview/:address", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "address_not_found" }, 404);
    }
    const client = await database.pool.connect();
    try {
      const preview = await previewAddress(client, projectId, decodeURIComponent(context.req.param("address")));
      return preview ? context.json({ preview }) : context.json({ error: "address_not_found" }, 404);
    } finally {
      client.release();
    }
  });

  routes.get("/projects/:projectId/search", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    const query = (context.req.query("q") ?? "").trim();
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    if (!query || query.length > 500) return context.json({ error: "invalid_query" }, 400);
    return context.json({ results: await searchForum(database, projectId, query) });
  });

  routes.get("/projects/:projectId/mentions", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    try {
      return context.json({ mentions: await listMentions(database, projectId, actor.id, context.req.query("after")) });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_cursor") return context.json({ error: error.message }, 400);
      throw error;
    }
  });

  routes.get("/projects/:projectId/backlinks/:address", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "address_not_found" }, 404);
    }
    const address = decodeURIComponent(context.req.param("address"));
    const client = await database.pool.connect();
    try {
      if (!await addressExists(client, projectId, address)) return context.json({ error: "address_not_found" }, 404);
    } finally {
      client.release();
    }
    const [posts, objects] = await Promise.all([
      database.pool.query(
        `select p.local_id as "localId", left(p.body, 500) as body, p.created_at as "createdAt",
                p.thread_id as "threadId", u.handle as author
           from post p join forum_user u on u.row_id = p.author_user_id
          where p.project_id = $1 and p.refs @> array[$2]::text[] order by p.local_id`,
        [projectId, address],
      ),
      database.pool.query(
        `select local_id as "localId", kind, label, left(body, 500) as body, created_at as "createdAt"
           from discourse_object where project_id = $1 and refs @> array[$2]::text[] order by local_id`,
        [projectId, address],
      ),
    ]);
    return context.json({
      backlinks: [
        ...posts.rows.map((row) => ({ ...row, kind: "post", address: formatAddress("post", row.localId) })),
        ...objects.rows.map((row) => ({ ...row, address: formatAddress(objectPrefix(row.kind), row.localId) })),
      ],
    });
  });

  return routes;
}
