import { createHash } from "node:crypto";

import { Hono } from "hono";
import { z } from "zod";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import { formatAddress, reserveProjectAddresses } from "../forum/addresses.ts";
import { isProjectMember } from "../projects.ts";
import { extractPdfDocument, readRemoteSource } from "./reader.ts";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const createLinkInput = z.object({ url: z.url().max(2_000) }).strict();
const updateSourceInput = z.object({
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
}).strict();

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sourceAddress<T extends { localId: number }>(source: T) {
  return { ...source, address: formatAddress("source", source.localId) };
}

function cleanTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function titleFromUrl(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  let pathTitle = "";
  try { pathTitle = last ? decodeURIComponent(last) : ""; } catch { pathTitle = last ?? ""; }
  return (pathTitle || url.hostname).replace(/[-_]+/g, " ").slice(0, 500);
}

function uploadedTitle(filename: string): string {
  const leaf = filename.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  return (leaf || "Uploaded source").slice(0, 500);
}

async function boundedBody(request: Request): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw new Error("source_upload_too_large");
  if (!request.body) throw new Error("source_upload_empty");
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new Error("source_upload_too_large");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!bytes) throw new Error("source_upload_empty");
  return Buffer.concat(chunks, bytes);
}

interface CreateSourceRecordInput {
  projectId: number;
  addedByUserId: number;
  locator: string;
  title: string;
  authors?: string[];
  tags?: string[];
  payload?: Buffer;
  mediaType?: "application/pdf" | "text/plain";
  contentHash?: Buffer;
}

async function createSourceRecord(database: AppDatabase, input: CreateSourceRecordInput) {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    const membership = await client.query(
      "select 1 from project_member where project_id = $1 and user_id = $2",
      [input.projectId, input.addedByUserId],
    );
    if (!membership.rows[0]) throw new Error("project_not_found");
    const existing = await client.query(
      `select row_id as id, local_id as "localId", locator, title, authors, tags,
              payload is not null as uploaded, created_at as "createdAt"
         from source where project_id = $1 and lower(locator) = lower($2)`,
      [input.projectId, input.locator],
    );
    if (existing.rows[0]) {
      await client.query("commit");
      return { source: sourceAddress(existing.rows[0]), created: false };
    }

    const localId = await reserveProjectAddresses(client, input.projectId, 1);
    const inserted = await client.query(
      `insert into source
         (project_id, local_id, locator, title, authors, tags, payload, media_type, content_hash, added_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict do nothing
       returning row_id as id, local_id as "localId", locator, title, authors, tags,
                 payload is not null as uploaded, created_at as "createdAt"`,
      [input.projectId, localId, input.locator, input.title, JSON.stringify(input.authors ?? []),
        cleanTags(input.tags ?? []), input.payload ?? null, input.mediaType ?? null, input.contentHash ?? null, input.addedByUserId],
    );
    const resolved = inserted.rows[0] ?? (await client.query(
      `select row_id as id, local_id as "localId", locator, title, authors, tags,
              payload is not null as uploaded, created_at as "createdAt"
         from source where project_id = $1 and lower(locator) = lower($2)`,
      [input.projectId, input.locator],
    )).rows[0];
    if (!resolved) throw new Error("source_create_failed");
    await client.query("commit");
    return { source: sourceAddress(resolved), created: Boolean(inserted.rows[0]) };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface EnsureProjectSourceInput {
  projectId: number;
  addedByUserId: number;
  locator: string;
  title: string;
  authors?: string[];
}

/** Gets or creates the small, durable source record for a URL. Full remote text lives only in the bounded disk cache. */
export async function ensureProjectSource(database: AppDatabase, input: EnsureProjectSourceInput) {
  const locator = input.locator.trim();
  const title = input.title.trim().slice(0, 500);
  if (!locator || locator.length > 2_000 || !title) throw new Error("invalid_source_metadata");
  const result = await createSourceRecord(database, {
    projectId: input.projectId,
    addedByUserId: input.addedByUserId,
    locator,
    title,
    authors: input.authors,
  });
  return { address: result.source.address, created: result.created };
}

export function createSourceLibraryRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.get("/projects/:projectId/sources", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    const result = await database.pool.query(
      `select s.row_id as id, s.local_id as "localId", s.locator, s.title, s.authors, s.tags,
              s.payload is not null as uploaded, u.handle as "addedBy", s.created_at as "createdAt",
              count(distinct e.row_id)::int as "excerptCount",
              count(distinct p.thread_id)::int as "discussionCount"
         from source s
         join forum_user u on u.row_id = s.added_by_user_id
         left join excerpt e on e.source_id = s.row_id
         left join post p on p.project_id = s.project_id
          and p.refs @> array['source:' || s.local_id::text]::text[]
        where s.project_id = $1
        group by s.row_id, u.handle
        order by s.created_at desc`,
      [projectId],
    );
    return context.json({ sources: result.rows.map(sourceAddress) });
  });

  routes.post("/projects/:projectId/sources", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    const input = createLinkInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    const url = new URL(input.data.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return context.json({ error: "source_protocol_not_allowed" }, 422);
    }
    try {
      const document = await readRemoteSource(url.href);
      const created = await createSourceRecord(database, {
        projectId,
        addedByUserId: actor.id,
        locator: url.href,
        title: document.title?.trim().slice(0, 500) || titleFromUrl(url),
      });
      return context.json(created, created.created ? 201 : 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "source_read_failed";
      return context.json({ error: message }, 422);
    }
  });

  routes.post("/projects/:projectId/sources/upload", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    const filename = uploadedTitle(context.req.query("filename") ?? "");
    try {
      const payload = await boundedBody(context.req.raw);
      let mediaType: "application/pdf" | "text/plain";
      let title = filename;
      if (payload.subarray(0, 5).toString("ascii") === "%PDF-") {
        mediaType = "application/pdf";
        const pdf = await extractPdfDocument(payload);
        if (pdf.title) title = pdf.title;
      } else {
        if (payload.length > MAX_TEXT_BYTES || payload.includes(0)) throw new Error("source_content_type_not_supported");
        try { new TextDecoder("utf-8", { fatal: true }).decode(payload); } catch { throw new Error("source_upload_not_utf8"); }
        mediaType = "text/plain";
      }
      const digest = createHash("sha256").update(payload).digest();
      const created = await createSourceRecord(database, {
        projectId,
        addedByUserId: actor.id,
        locator: `upload:sha256:${digest.toString("hex")}`,
        title,
        payload,
        mediaType,
        contentHash: digest,
      });
      return context.json(created, created.created ? 201 : 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "source_upload_failed";
      const status = message === "source_upload_too_large" ? 413
        : message === "source_content_type_not_supported" ? 415
          : 422;
      return context.json({ error: message }, status);
    }
  });

  routes.patch("/projects/:projectId/sources/:sourceId", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    const sourceId = positiveId(context.req.param("sourceId"));
    const input = updateSourceInput.safeParse(await context.req.json().catch(() => null));
    if (!projectId || !sourceId || !input.success || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: input.success ? "source_not_found" : "invalid_input" }, input.success ? 404 : 400);
    }
    const result = await database.pool.query<{ tags: string[] }>(
      "update source set tags = $3 where project_id = $1 and row_id = $2 returning tags",
      [projectId, sourceId, cleanTags(input.data.tags)],
    );
    return result.rows[0] ? context.json(result.rows[0]) : context.json({ error: "source_not_found" }, 404);
  });

  routes.get("/projects/:projectId/sources/:sourceId", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    const sourceId = positiveId(context.req.param("sourceId"));
    if (!projectId || !sourceId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "source_not_found" }, 404);
    }
    const source = await database.pool.query(
      `select s.row_id as id, s.local_id as "localId", s.locator, s.title, s.authors, s.tags,
              s.payload is not null as uploaded, u.handle as "addedBy", s.created_at as "createdAt",
              (select count(*)::int from excerpt e where e.source_id = s.row_id) as "excerptCount",
              (select count(distinct p.thread_id)::int from post p
                where p.project_id = s.project_id
                  and p.refs @> array['source:' || s.local_id::text]::text[]) as "discussionCount"
         from source s join forum_user u on u.row_id = s.added_by_user_id
        where s.project_id = $1 and s.row_id = $2`,
      [projectId, sourceId],
    );
    if (!source.rows[0]) return context.json({ error: "source_not_found" }, 404);
    const excerpts = await database.pool.query(
      `select e.local_id as "localId", e.content, e.locator, e.captured_from as "capturedFrom",
              e.created_at as "createdAt"
         from excerpt e where e.project_id = $1 and e.source_id = $2
        order by e.created_at desc`,
      [projectId, sourceId],
    );
    return context.json({
      source: sourceAddress(source.rows[0]),
      excerpts: excerpts.rows.map((row) => ({ ...row, address: formatAddress("excerpt", row.localId) })),
    });
  });

  return routes;
}
