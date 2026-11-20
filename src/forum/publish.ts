import { Hono } from "hono";
import type { PoolClient } from "pg";
import { z } from "zod";

import { createMentionTurns, type EnqueueAgentTurns } from "../agents/turns.ts";
import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import {
  extractReferences,
  formatAddress,
  parseAddress,
  replaceLocalAddress,
  replaceLocalReferences,
  requireProjectAddresses,
  reserveProjectAddresses,
  type AddressPrefix,
} from "./addresses.ts";
import { findMentionedUserIds } from "./queries.ts";

const keySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const expectedOutputsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.unknown())
  .refine((value) => Object.keys(value).length <= 64, "expected_outputs has at most 64 keys")
  .describe("Map each exact result field name to a plain description of what that field will contain. Include only outputs that help answer the proposal's question.");
const excerptSchema = z.object({
  key: keySchema,
  source: z.string().min(1).max(100),
  content: z.string().trim().min(1).max(200_000),
  locator: z.string().trim().max(500).nullable().optional(),
  capturedFrom: z.url().max(2_000).nullable().optional(),
}).strict();
const objectBase = {
  key: keySchema,
  label: z.string().trim().max(200).nullable().optional(),
};
const objectBodySchema = z.string().trim().min(1).max(100_000);
const questionObjectSchema = z.object({
  ...objectBase,
  kind: z.literal("question"),
  body: objectBodySchema,
}).strict().describe("An addressable research question worth pursuing independently. It may be broad and exploratory or precise and specifically testable. Cite other records in body when useful.");
const claimObjectSchema = z.object({
  ...objectBase,
  kind: z.literal("claim"),
  body: objectBodySchema,
}).strict().describe("An addressable assertion or hypothesis that may be supported, challenged, refined, or tested. Cite other records in body when useful.");
const evidenceObjectSchema = z.object({
  ...objectBase,
  kind: z.literal("evidence"),
  body: objectBodySchema,
}).strict().describe("An addressable observation, result, or synthesis that bears on a question or claim. Cite the supporting excerpts, sources, or results in body.");
const proposalObjectSchema = z.object({
  ...objectBase,
  kind: z.literal("proposal"),
  body: objectBodySchema,
  expectedOutputs: expectedOutputsSchema.nullable().optional(),
}).strict().describe("A concrete request for owner-reviewed Scribe implementation in the project sandbox that will publish addressable results. A large experiment may be one proposal when its stages answer one primary question and use the same experimental runner, configuration format, result format, and measurements. Name each substantial stage and explain its purpose, inputs, procedure, outputs, dependencies, and approximate run or paid-call count. Mark it as required now or possible follow-up work. Separate stages that ask different questions or judge success differently, even when they reuse code. State any choice the owner must make instead of leaving it as a vague example or optional detail. expectedOutputs names the exact result fields the experiment should produce.");
const relationEndpointSchema = z.string().max(100).regex(
  /^(?:new:[a-z][a-z0-9_-]{0,31}|(?:thread|post|source|excerpt|question|claim|evidence|proposal|rel):[1-9]\d*|result:[1-9]\d*(?:#[a-z][a-z0-9_-]{0,63})?)$/,
  "Use a canonical address such as claim:42, or new:key for an item introduced by this reply.",
).describe("An existing canonical address such as claim:42, or new:key for an excerpt or discourse object introduced by this reply.");
const relationObjectSchema = z.object({
  ...objectBase,
  kind: z.literal("relation"),
  body: z.string().trim().max(100_000).nullable().optional(),
  relationType: z.enum(["supports", "opposes", "tests", "implements"]),
  subjects: z.array(relationEndpointSchema).min(1).max(100),
  objects: z.array(relationEndpointSchema).min(1).max(100),
}).strict().describe("A typed relationship. subjects bear the stated relation to objects. Use canonical addresses for existing records and new:key for sibling items in this reply.");
const objectSchema = z.discriminatedUnion("kind", [
  questionObjectSchema,
  claimObjectSchema,
  evidenceObjectSchema,
  proposalObjectSchema,
  relationObjectSchema,
]);
export const publishInputSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
  replyTo: z.string().max(100).nullable().optional(),
  excerpts: z.array(excerptSchema).max(50).default([]),
  objects: z.array(objectSchema).max(50).default([]),
}).strict();

export type PublishInput = z.infer<typeof publishInputSchema>;

export interface PublishPostInput {
  projectId: number;
  threadId: number;
  author: { id: number; isOwner: boolean };
  post: PublishInput;
}

export interface PublishPostResult {
  postId: number;
  post: string;
  created: Record<string, string>;
  turnIds: number[];
}

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function prefixForKind(kind: string): AddressPrefix {
  return kind === "relation" ? "rel" : kind as AddressPrefix;
}

function validateObjectShape(object: z.infer<typeof objectSchema>): void {
  if (object.kind === "relation") {
    if (new Set(object.subjects).size !== object.subjects.length || new Set(object.objects).size !== object.objects.length) {
      throw new Error(`duplicate_relation_endpoint:${object.key}`);
    }
  }
}

interface ValidatedPublishPost {
  replyToPostId: number | null;
  sourceRows: Map<string, number>;
}

function collectPublishReferences(
  text: string | null | undefined,
  localKeys: ReadonlySet<string>,
  canonical: Set<string>,
): void {
  if (!text) return;
  for (const match of text.matchAll(/\[\[([^\[\]]+)\]\]/g)) {
    const value = match[1] ?? "";
    if (value.startsWith("new:")) {
      const key = value.slice(4);
      if (!keySchema.safeParse(key).success) throw new Error(`invalid_reference:${value}`);
      if (!localKeys.has(key)) throw new Error(`unknown_local_reference:${key}`);
      continue;
    }
    const parsed = parseAddress(value);
    if (!parsed) throw new Error(`invalid_reference:${value}`);
    canonical.add(formatAddress(parsed.prefix, parsed.localId, parsed.fragment));
  }
}

function collectRelationEndpoint(
  value: string,
  localKeys: ReadonlySet<string>,
  canonical: Set<string>,
): void {
  if (value.startsWith("new:")) {
    const key = value.slice(4);
    if (!localKeys.has(key)) throw new Error(`unknown_local_reference:${key}`);
    return;
  }
  canonical.add(value);
}

/**
 * Performs the project-aware, read-only checks required before a reply can be accepted.
 * publishPost calls it again inside the publication transaction, so it is safe to use as an earlier model-tool check.
 */
export async function validatePublishPost(client: PoolClient, input: PublishPostInput): Promise<ValidatedPublishPost> {
  const keys = [...input.post.excerpts, ...input.post.objects].map((item) => item.key);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate_local_key");
  const localKeys = new Set(keys);
  const canonical = new Set<string>();
  collectPublishReferences(input.post.body, localKeys, canonical);
  for (const object of input.post.objects) {
    validateObjectShape(object);
    collectPublishReferences(object.body, localKeys, canonical);
    if (object.kind === "relation") {
      object.subjects.forEach((value) => collectRelationEndpoint(value, localKeys, canonical));
      object.objects.forEach((value) => collectRelationEndpoint(value, localKeys, canonical));
    }
  }

  const allowed = await client.query(
    `select 1 from thread t join project_member m on m.project_id = t.project_id
      where t.row_id = $1 and t.project_id = $2 and m.user_id = $3`,
    [input.threadId, input.projectId, input.author.id],
  );
  if (!allowed.rows[0]) throw new Error("thread_not_found");

  let replyToPostId: number | null = null;
  if (input.post.replyTo) {
    const replyAddress = parseAddress(input.post.replyTo);
    if (!replyAddress || replyAddress.prefix !== "post" || replyAddress.fragment) throw new Error("invalid_reply_address");
    const reply = await client.query<{ id: number }>(
      "select row_id as id from post where project_id = $1 and thread_id = $2 and local_id = $3",
      [input.projectId, input.threadId, replyAddress.localId],
    );
    replyToPostId = reply.rows[0]?.id ?? null;
    if (!replyToPostId) throw new Error("reply_not_found");
  }

  const sourceRows = new Map<string, number>();
  for (const excerpt of input.post.excerpts) {
    const parsed = parseAddress(excerpt.source);
    if (!parsed || parsed.prefix !== "source" || parsed.fragment) throw new Error(`invalid_source:${excerpt.source}`);
    const source = await client.query<{ id: number }>(
      "select row_id as id from source where project_id = $1 and local_id = $2",
      [input.projectId, parsed.localId],
    );
    if (!source.rows[0]) throw new Error(`source_not_found:${excerpt.source}`);
    sourceRows.set(excerpt.key, source.rows[0].id);
  }

  await requireProjectAddresses(client, input.projectId, canonical);
  return { replyToPostId, sourceRows };
}

/** Publishes one forum post and its introduced records. The caller owns the transaction. */
export async function publishPost(client: PoolClient, input: PublishPostInput): Promise<PublishPostResult> {
  const { replyToPostId, sourceRows } = await validatePublishPost(client, input);
  const keys = [...input.post.excerpts, ...input.post.objects].map((item) => item.key);

  const first = await reserveProjectAddresses(client, input.projectId, 1 + keys.length);
  const created = new Map<string, string>();
  let next = first + 1;
  for (const excerpt of input.post.excerpts) created.set(excerpt.key, formatAddress("excerpt", next++));
  for (const object of input.post.objects) created.set(object.key, formatAddress(prefixForKind(object.kind), next++));

  const body = replaceLocalReferences(input.post.body, created);
  const refs = extractReferences(body);
  const preparedObjects = input.post.objects.map((object) => {
    validateObjectShape(object);
    const objectBody = object.body ? replaceLocalReferences(object.body, created) : null;
    const subjects = object.kind === "relation" ? object.subjects.map((address) => replaceLocalAddress(address, created)) : null;
    const objects = object.kind === "relation" ? object.objects.map((address) => replaceLocalAddress(address, created)) : null;
    if (subjects && new Set(subjects).size !== subjects.length) throw new Error(`duplicate_relation_endpoint:${object.key}`);
    if (objects && new Set(objects).size !== objects.length) throw new Error(`duplicate_relation_endpoint:${object.key}`);
    const objectRefs = new Set(extractReferences(objectBody));
    subjects?.forEach((address) => objectRefs.add(address));
    objects?.forEach((address) => objectRefs.add(address));
    return {
      ...object,
      body: objectBody,
      expectedOutputs: object.kind === "proposal" ? object.expectedOutputs ?? null : null,
      relationType: object.kind === "relation" ? object.relationType : null,
      subjects,
      objects,
      refs: [...objectRefs],
    };
  });

  const mentioned = await findMentionedUserIds(client, input.projectId, body);
  const insertedPost = await client.query<{ id: number }>(
    `insert into post
       (project_id, local_id, thread_id, author_user_id, reply_to_post_id, body, refs, mentioned_user_ids)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning row_id as id`,
    [input.projectId, first, input.threadId, input.author.id, replyToPostId, body, refs, mentioned],
  );
  const postId = insertedPost.rows[0]?.id;
  if (!postId) throw new Error("post_insert_failed");

  for (const excerpt of input.post.excerpts) {
    const address = parseAddress(created.get(excerpt.key) ?? "");
    await client.query(
      `insert into excerpt
         (project_id, local_id, source_id, content, locator, captured_from, created_by_user_id, born_in_post_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.projectId, address?.localId, sourceRows.get(excerpt.key), excerpt.content, excerpt.locator ?? null,
        excerpt.capturedFrom ?? null, input.author.id, postId],
    );
  }
  for (const object of preparedObjects) {
    const address = parseAddress(created.get(object.key) ?? "");
    await client.query(
      `insert into discourse_object
         (project_id, local_id, kind, label, body, expected_outputs, creator_user_id, born_in_post_id,
          relation_type, subjects, objects, refs)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [input.projectId, address?.localId, object.kind, object.label ?? null, object.body,
        object.expectedOutputs ?? null, input.author.id, postId, object.relationType ?? null,
        object.subjects, object.objects, object.refs],
    );
  }
  const turnIds = await createMentionTurns(client, {
    projectId: input.projectId,
    triggerPostId: postId,
    requestedByUserId: input.author.id,
    mentionedUserIds: mentioned,
    requesterIsOwner: input.author.isOwner,
  });
  return { postId, post: formatAddress("post", first), created: Object.fromEntries(created), turnIds };
}

/** Runs the complete publication transaction shared by browser, MCP, and model callers. */
export async function publishProjectPost(
  database: AppDatabase,
  input: PublishPostInput,
  enqueueTurns: EnqueueAgentTurns = async () => undefined,
): Promise<PublishPostResult> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    const published = await publishPost(client, input);
    await client.query("commit");
    await enqueueTurns(published.turnIds).catch((error) => console.error("Could not enqueue agent turns", error));
    return published;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createPublishRoutes(database: AppDatabase, enqueueTurns: EnqueueAgentTurns = async () => undefined) {
  const routes = new Hono();

  routes.post("/projects/:projectId/threads/:threadId/posts", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    const threadId = positiveId(context.req.param("threadId"));
    if (!projectId || !threadId) return context.json({ error: "thread_not_found" }, 404);
    const post = publishInputSchema.safeParse(await context.req.json().catch(() => null));
    if (!post.success) return context.json({ error: "invalid_input" }, 400);

    try {
      const published = await publishProjectPost(
        database,
        { projectId, threadId, author: actor, post: post.data },
        enqueueTurns,
      );
      return context.json({ post: published.post, created: published.created, turnIds: published.turnIds }, 201);
    } catch (error) {
      if (error instanceof Error && /^(invalid_|unknown_|address_|source_|reply_|object_|relation_|duplicate_|expected_|thread_)/.test(error.message)) {
        const status = error.message === "thread_not_found" ? 404 : 400;
        return context.json({ error: error.message }, status);
      }
      throw error;
    }
  });

  return routes;
}
