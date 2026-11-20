import { createHash } from "node:crypto";

import { Hono } from "hono";
import { z } from "zod";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import { formatAddress, reserveProjectAddresses } from "../forum/addresses.ts";
import { isProjectMember } from "../projects.ts";
import { extractPdfDocument, readRemoteSource } from "./reader.ts";
import { canonicalSourceLocator, fallbackSourceTitle, type SourceMetadata } from "./metadata.ts";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const createLinkInput = z.object({ url: z.url().max(2_000) }).strict();
const updateSourceInput = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  authors: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  publishedYear: z.number().int().min(1500).max(2200).nullable().optional(),
  containerTitle: z.string().trim().min(1).max(500).nullable().optional(),
  publisher: z.string().trim().min(1).max(500).nullable().optional(),
  sourceType: z.string().trim().min(1).max(100).nullable().optional(),
  identifier: z.string().trim().min(1).max(500).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

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
  publishedYear?: number | null;
  containerTitle?: string | null;
  publisher?: string | null;
  sourceType?: string | null;
  identifier?: string | null;
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
      `select row_id as id, local_id as "localId", locator, title, authors,
              published_year as "publishedYear", container_title as "containerTitle", publisher,
              source_type as "sourceType", identifier, tags,
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
         (project_id, local_id, locator, title, authors, published_year, container_title, publisher,
          source_type, identifier, tags, payload, media_type, content_hash, added_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       on conflict do nothing
       returning row_id as id, local_id as "localId", locator, title, authors,
                 published_year as "publishedYear", container_title as "containerTitle", publisher,
                 source_type as "sourceType", identifier, tags,
                 payload is not null as uploaded, created_at as "createdAt"`,
      [input.projectId, localId, input.locator, input.title, JSON.stringify(input.authors ?? []),
        input.publishedYear ?? null, input.containerTitle ?? null, input.publisher ?? null,
        input.sourceType ?? null, input.identifier ?? null, cleanTags(input.tags ?? []),
        input.payload ?? null, input.mediaType ?? null, input.contentHash ?? null, input.addedByUserId],
    );
    const resolved = inserted.rows[0] ?? (await client.query(
      `select row_id as id, local_id as "localId", locator, title, authors,
              published_year as "publishedYear", container_title as "containerTitle", publisher,
              source_type as "sourceType", identifier, tags,
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
}

/** Gets or creates the small, durable source record for a URL. Full remote text lives only in the bounded disk cache. */
export async function ensureProjectSource(database: AppDatabase, input: EnsureProjectSourceInput) {
  const locator = canonicalSourceLocator(input.locator.trim());
  if (!locator || locator.length > 2_000) throw new Error("invalid_source_metadata");
  const document = await readRemoteSource(locator);
  const metadata: SourceMetadata = document.metadata;
  const result = await createSourceRecord(database, {
    projectId: input.projectId,
    addedByUserId: input.addedByUserId,
    locator,
    title: metadata.title ?? fallbackSourceTitle(locator),
    authors: metadata.authors,
    publishedYear: metadata.publishedYear,
    containerTitle: metadata.containerTitle,
    publisher: metadata.publisher,
    sourceType: metadata.sourceType,
    identifier: metadata.identifier,
  });
  return { source: result.source, address: result.source.address, created: result.created };
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
      `select s.row_id as id, s.local_id as "localId", s.locator, s.title, s.authors,
              s.published_year as "publishedYear", s.container_title as "containerTitle", s.publisher,
              s.source_type as "sourceType", s.identifier, s.tags,
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
      const created = await ensureProjectSource(database, {
        projectId,
        addedByUserId: actor.id,
        locator: url.href,
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
      let authors: string[] = [];
      if (payload.subarray(0, 5).toString("ascii") === "%PDF-") {
        mediaType = "application/pdf";
        const pdf = await extractPdfDocument(payload);
        if (pdf.title) title = pdf.title;
        authors = pdf.authors;
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
        authors,
        sourceType: "document",
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
    const has = (key: keyof typeof input.data) => Object.prototype.hasOwnProperty.call(input.data, key);
    const result = await database.pool.query(
      `update source set
         title = case when $3 then $4 else title end,
         authors = case when $5 then $6::jsonb else authors end,
         published_year = case when $7 then $8 else published_year end,
         container_title = case when $9 then $10 else container_title end,
         publisher = case when $11 then $12 else publisher end,
         source_type = case when $13 then $14 else source_type end,
         identifier = case when $15 then $16 else identifier end,
         tags = case when $17 then $18::text[] else tags end
       where project_id = $1 and row_id = $2
       returning title, authors, published_year as "publishedYear", container_title as "containerTitle",
                 publisher, source_type as "sourceType", identifier, tags`,
      [projectId, sourceId,
        has("title"), input.data.title ?? "",
        has("authors"), JSON.stringify(input.data.authors ?? []),
        has("publishedYear"), input.data.publishedYear ?? null,
        has("containerTitle"), input.data.containerTitle ?? null,
        has("publisher"), input.data.publisher ?? null,
        has("sourceType"), input.data.sourceType ?? null,
        has("identifier"), input.data.identifier ?? null,
        has("tags"), cleanTags(input.data.tags ?? [])],
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
      `select s.row_id as id, s.local_id as "localId", s.locator, s.title, s.authors,
              s.published_year as "publishedYear", s.container_title as "containerTitle", s.publisher,
              s.source_type as "sourceType", s.identifier, s.tags,
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
