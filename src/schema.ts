import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const id = (name: string) => bigint(name, { mode: "number" });
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const projects = pgTable("project", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().defaultRandom(),
  nextAddressLocalId: id("next_address_local_id").notNull().default(1),
  name: text("name").notNull(),
  defaultAgentTurnLimit: integer("default_agent_turn_limit").notNull().default(10),
  agentTurnLimit: integer("agent_turn_limit").notNull().default(100),
  scribeProvider: text("scribe_provider"),
  scribeModel: text("scribe_model"),
  scribeThinkingLevel: text("scribe_thinking_level").notNull().default("off"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("project_public_id_unique").on(table.publicId),
  uniqueIndex("project_name_lower_unique").on(sql`lower(${table.name})`),
  check("project_default_agent_turn_limit_check", sql`${table.defaultAgentTurnLimit} >= 0`),
  check("project_agent_turn_limit_check", sql`${table.agentTurnLimit} >= 0`),
  check("project_scribe_model_pair_check", sql`(${table.scribeProvider} is null) = (${table.scribeModel} is null)`),
  check("project_scribe_thinking_level_check", sql`${table.scribeThinkingLevel} in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh')`),
]);

export const forumUsers = pgTable("forum_user", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  kind: text("kind").notNull(),
  handle: text("handle").notNull(),
  createdByUserId: id("created_by_user_id").references((): AnyPgColumn => forumUsers.rowId),
  isOwner: boolean("is_owner").notNull().default(false),
  agentConfig: jsonb("agent_config").$type<Record<string, unknown>>(),
  disabledAt: time("disabled_at"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  check("forum_user_kind_check", sql`${table.kind} in ('human', 'agent')`),
  check("forum_user_owner_human_check", sql`not ${table.isOwner} or ${table.kind} = 'human'`),
  check("forum_user_agent_config_check", sql`${table.agentConfig} is null or ${table.kind} = 'agent'`),
  uniqueIndex("forum_user_handle_lower_unique").on(sql`lower(${table.handle})`),
  uniqueIndex("forum_user_one_owner_unique").on(table.isOwner).where(sql`${table.isOwner} = true`),
]);

export const projectMembers = pgTable("project_member", {
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  userId: id("user_id").notNull().references(() => forumUsers.rowId, { onDelete: "cascade" }),
  joinedAt: time("joined_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.userId] }),
  index("project_member_user_idx").on(table.userId),
]);

export const signInLinks = pgTable("sign_in_link", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  userId: id("user_id").notNull().references(() => forumUsers.rowId, { onDelete: "cascade" }),
  secretHash: bytea("secret_hash").notNull(),
  expiresAt: time("expires_at").notNull(),
  consumedAt: time("consumed_at"),
  createdByUserId: id("created_by_user_id").notNull().references(() => forumUsers.rowId),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sign_in_link_secret_hash_unique").on(table.secretHash),
  index("sign_in_link_user_idx").on(table.userId),
]);

export const projectInvites = pgTable("project_invite", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  secretHash: bytea("secret_hash").notNull(),
  expiresAt: time("expires_at").notNull(),
  consumedAt: time("consumed_at"),
  createdByUserId: id("created_by_user_id").notNull().references(() => forumUsers.rowId),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("project_invite_secret_hash_unique").on(table.secretHash),
  index("project_invite_project_idx").on(table.projectId),
]);

export const browserSessions = pgTable("browser_session", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  userId: id("user_id").notNull().references(() => forumUsers.rowId, { onDelete: "cascade" }),
  secretHash: bytea("secret_hash").notNull(),
  expiresAt: time("expires_at").notNull(),
  lastSeenAt: time("last_seen_at"),
  revokedAt: time("revoked_at"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("browser_session_secret_hash_unique").on(table.secretHash),
  index("browser_session_user_idx").on(table.userId),
]);

export const mcpCredentials = pgTable("mcp_credential", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  userId: id("user_id").notNull().references(() => forumUsers.rowId, { onDelete: "cascade" }),
  name: text("name").notNull(),
  secretHash: bytea("secret_hash").notNull(),
  expiresAt: time("expires_at"),
  lastUsedAt: time("last_used_at"),
  revokedAt: time("revoked_at"),
  createdByUserId: id("created_by_user_id").notNull().references(() => forumUsers.rowId),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("mcp_credential_secret_hash_unique").on(table.secretHash),
  uniqueIndex("mcp_credential_user_name_unique").on(table.userId, table.name),
  index("mcp_credential_user_idx").on(table.userId),
]);

export const subforums = pgTable("subforum", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("subforum_project_name_lower_unique").on(table.projectId, sql`lower(${table.name})`),
  index("subforum_project_created_idx").on(table.projectId, table.createdAt),
]);

export const threads = pgTable("thread", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  subforumId: id("subforum_id").notNull().references(() => subforums.rowId),
  localId: id("local_id").notNull(),
  title: text("title").notNull(),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  pinned: boolean("pinned").notNull().default(false),
  agentTurnLimit: integer("agent_turn_limit").notNull().default(0),
  createdByUserId: id("created_by_user_id").notNull().references(() => forumUsers.rowId),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("thread_project_local_unique").on(table.projectId, table.localId),
  index("thread_subforum_created_idx").on(table.projectId, table.subforumId, table.createdAt),
  index("thread_project_created_idx").on(table.projectId, table.createdAt),
  index("thread_title_search_idx").using("gin", sql`to_tsvector('english', ${table.title})`),
  check("thread_agent_turn_limit_check", sql`${table.agentTurnLimit} >= 0`),
]);

export const posts = pgTable("post", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  localId: id("local_id").notNull(),
  threadId: id("thread_id").notNull().references(() => threads.rowId, { onDelete: "cascade" }),
  authorUserId: id("author_user_id").notNull().references(() => forumUsers.rowId),
  replyToPostId: id("reply_to_post_id").references((): AnyPgColumn => posts.rowId),
  body: text("body").notNull(),
  refs: text("refs").array().notNull().default(sql`'{}'::text[]`),
  mentionedUserIds: id("mentioned_user_ids").array().notNull().default(sql`'{}'::bigint[]`),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("post_project_local_unique").on(table.projectId, table.localId),
  index("post_thread_local_idx").on(table.projectId, table.threadId, table.localId),
  index("post_author_idx").on(table.projectId, table.authorUserId),
  index("post_body_search_idx").using("gin", sql`to_tsvector('english', ${table.body})`),
  index("post_refs_idx").using("gin", table.refs),
  index("post_mentions_idx").using("gin", table.mentionedUserIds),
]);

export const discourseObjects = pgTable("discourse_object", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  localId: id("local_id").notNull(),
  kind: text("kind").notNull(),
  label: text("label"),
  body: text("body"),
  expectedOutputs: jsonb("expected_outputs").$type<Record<string, unknown>>(),
  creatorUserId: id("creator_user_id").notNull().references(() => forumUsers.rowId),
  bornInPostId: id("born_in_post_id").notNull().references(() => posts.rowId, { onDelete: "cascade" }),
  relationType: text("relation_type"),
  subjects: text("subjects").array(),
  objects: text("objects").array(),
  refs: text("refs").array().notNull().default(sql`'{}'::text[]`),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("discourse_object_project_local_unique").on(table.projectId, table.localId),
  index("discourse_object_kind_idx").on(table.projectId, table.kind),
  index("discourse_object_post_idx").on(table.projectId, table.bornInPostId),
  index("discourse_object_body_search_idx").using("gin", sql`to_tsvector('english', coalesce(${table.body}, ''))`),
  index("discourse_object_refs_idx").using("gin", table.refs),
  check("discourse_object_kind_check", sql`${table.kind} in ('question', 'claim', 'evidence', 'proposal', 'relation')`),
  check("discourse_object_relation_type_check", sql`${table.relationType} is null or ${table.relationType} in ('supports', 'opposes', 'tests', 'implements')`),
  check("discourse_object_expected_outputs_check", sql`${table.kind} = 'proposal' or ${table.expectedOutputs} is null`),
  check("discourse_object_shape_check", sql`
    (${table.kind} = 'relation'
      and ${table.relationType} is not null
      and ${table.subjects} is not null
      and ${table.objects} is not null
      and cardinality(${table.subjects}) > 0
      and cardinality(${table.objects}) > 0)
    or
    (${table.kind} <> 'relation'
      and ${table.relationType} is null
      and ${table.subjects} is null
      and ${table.objects} is null
      and ${table.body} is not null
      and length(trim(${table.body})) > 0)`),
]);

export const sources = pgTable("source", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  localId: id("local_id").notNull(),
  locator: text("locator").notNull(),
  title: text("title").notNull(),
  authors: jsonb("authors").$type<string[]>().notNull().default([]),
  publishedYear: integer("published_year"),
  containerTitle: text("container_title"),
  publisher: text("publisher"),
  sourceType: text("source_type"),
  identifier: text("identifier"),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  payloadPath: text("payload_path"),
  payload: bytea("payload"),
  mediaType: text("media_type"),
  contentHash: bytea("content_hash"),
  addedByUserId: id("added_by_user_id").notNull().references(() => forumUsers.rowId),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("source_project_local_unique").on(table.projectId, table.localId),
  uniqueIndex("source_project_locator_unique").on(table.projectId, sql`lower(${table.locator})`),
  index("source_title_search_idx").using("gin", sql`to_tsvector('english', ${table.title})`),
  index("source_tags_idx").using("gin", table.tags),
  check("source_payload_hash_check", sql`(${table.payloadPath} is null and ${table.payload} is null) or ${table.contentHash} is not null`),
  check("source_payload_media_type_check", sql`
    (${table.payload} is null and ${table.mediaType} is null)
    or (${table.payload} is not null and ${table.mediaType} in ('application/pdf', 'text/plain'))`),
]);

export const excerpts = pgTable("excerpt", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  localId: id("local_id").notNull(),
  sourceId: id("source_id").notNull().references(() => sources.rowId),
  content: text("content"),
  assetPath: text("asset_path"),
  locator: text("locator"),
  capturedFrom: text("captured_from"),
  createdByUserId: id("created_by_user_id").notNull().references(() => forumUsers.rowId),
  bornInPostId: id("born_in_post_id").notNull().references(() => posts.rowId, { onDelete: "cascade" }),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("excerpt_project_local_unique").on(table.projectId, table.localId),
  index("excerpt_source_idx").on(table.projectId, table.sourceId),
  index("excerpt_content_search_idx").using("gin", sql`to_tsvector('english', coalesce(${table.content}, ''))`),
  check("excerpt_content_check", sql`(${table.content} is not null and length(trim(${table.content})) > 0) or ${table.assetPath} is not null`),
]);

export const results = pgTable("result", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  localId: id("local_id").notNull(),
  submissionId: text("submission_id").notNull(),
  threadId: id("thread_id").notNull().references(() => threads.rowId, { onDelete: "cascade" }),
  proposalId: id("proposal_id").references(() => discourseObjects.rowId),
  outputs: jsonb("outputs").$type<Record<string, unknown>>().notNull(),
  workspaceRevision: text("workspace_revision"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("result_project_local_unique").on(table.projectId, table.localId),
  uniqueIndex("result_project_submission_unique").on(table.projectId, table.submissionId),
  index("result_thread_created_idx").on(table.projectId, table.threadId, table.createdAt),
  check("result_outputs_object_check", sql`jsonb_typeof(${table.outputs}) = 'object' and ${table.outputs} <> '{}'::jsonb`),
]);

export const conversations = pgTable("conversation", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  userId: id("user_id").notNull().references(() => forumUsers.rowId, { onDelete: "cascade" }),
  anchor: text("anchor"),
  status: text("status").notNull().default("idle"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [
  index("conversation_user_project_idx").on(table.userId, table.projectId, table.updatedAt),
  check("conversation_status_check", sql`${table.status} in ('idle', 'running')`),
]);

export const messages = pgTable("message", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  conversationId: id("conversation_id").notNull().references(() => conversations.rowId, { onDelete: "cascade" }),
  authorUserId: id("author_user_id").references(() => forumUsers.rowId),
  role: text("role").notNull(),
  body: text("body").notNull(),
  refs: text("refs").array().notNull().default(sql`'{}'::text[]`),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  index("message_conversation_created_idx").on(table.conversationId, table.createdAt),
  check("message_role_check", sql`${table.role} in ('user', 'assistant', 'system')`),
  check("message_author_check", sql`(${table.role} = 'user' and ${table.authorUserId} is not null) or (${table.role} <> 'user' and ${table.authorUserId} is null)`),
  check("message_body_check", sql`length(trim(${table.body})) > 0`),
]);

export const agentTurns = pgTable("agent_turn", {
  rowId: id("row_id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: id("project_id").notNull().references(() => projects.rowId, { onDelete: "cascade" }),
  agentUserId: id("agent_user_id").notNull().references(() => forumUsers.rowId),
  requestedByUserId: id("requested_by_user_id").notNull().references(() => forumUsers.rowId),
  triggerPostId: id("trigger_post_id").notNull().references(() => posts.rowId, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  thinkingLevel: text("thinking_level").notNull(),
  outputPostId: id("output_post_id").references(() => posts.rowId),
  usage: jsonb("usage").$type<Record<string, number>>().notNull().default({}),
  reportedCost: doublePrecision("reported_cost"),
  error: text("error"),
  stopRequestedAt: time("stop_requested_at"),
  startedAt: time("started_at"),
  finishedAt: time("finished_at"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("agent_turn_trigger_agent_unique").on(table.triggerPostId, table.agentUserId),
  index("agent_turn_project_created_idx").on(table.projectId, table.createdAt),
  index("agent_turn_status_idx").on(table.status, table.createdAt),
  check("agent_turn_status_check", sql`${table.status} in ('pending', 'queued', 'running', 'completed', 'failed', 'stopped')`),
  check("agent_turn_thinking_level_check", sql`${table.thinkingLevel} in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh')`),
  check("agent_turn_finished_check", sql`
    (${table.status} in ('pending', 'queued', 'running') and ${table.finishedAt} is null)
    or (${table.status} in ('completed', 'failed', 'stopped') and ${table.finishedAt} is not null)`),
  check("agent_turn_output_check", sql`${table.status} <> 'completed' or ${table.outputPostId} is not null`),
]);
