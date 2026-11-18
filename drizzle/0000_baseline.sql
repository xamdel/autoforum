CREATE TABLE "agent_turn" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_turn_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"agent_user_id" bigint NOT NULL,
	"requested_by_user_id" bigint NOT NULL,
	"trigger_post_id" bigint NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"thinking_level" text NOT NULL,
	"output_post_id" bigint,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reported_cost" double precision,
	"error" text,
	"stop_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_turn_status_check" CHECK ("agent_turn"."status" in ('pending', 'queued', 'running', 'completed', 'failed', 'stopped')),
	CONSTRAINT "agent_turn_thinking_level_check" CHECK ("agent_turn"."thinking_level" in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh')),
	CONSTRAINT "agent_turn_finished_check" CHECK (
    ("agent_turn"."status" in ('pending', 'queued', 'running') and "agent_turn"."finished_at" is null)
    or ("agent_turn"."status" in ('completed', 'failed', 'stopped') and "agent_turn"."finished_at" is not null)),
	CONSTRAINT "agent_turn_output_check" CHECK ("agent_turn"."status" <> 'completed' or "agent_turn"."output_post_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "browser_session" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "browser_session_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversation_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"anchor" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_status_check" CHECK ("conversation"."status" in ('idle', 'running'))
);
--> statement-breakpoint
CREATE TABLE "discourse_object" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "discourse_object_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"local_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"body" text,
	"expected_outputs" jsonb,
	"creator_user_id" bigint NOT NULL,
	"born_in_post_id" bigint NOT NULL,
	"relation_type" text,
	"subjects" text[],
	"objects" text[],
	"refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discourse_object_kind_check" CHECK ("discourse_object"."kind" in ('question', 'claim', 'evidence', 'proposal', 'relation')),
	CONSTRAINT "discourse_object_relation_type_check" CHECK ("discourse_object"."relation_type" is null or "discourse_object"."relation_type" in ('supports', 'opposes', 'tests', 'implements')),
	CONSTRAINT "discourse_object_expected_outputs_check" CHECK ("discourse_object"."kind" = 'proposal' or "discourse_object"."expected_outputs" is null),
	CONSTRAINT "discourse_object_shape_check" CHECK (
    ("discourse_object"."kind" = 'relation'
      and "discourse_object"."relation_type" is not null
      and "discourse_object"."subjects" is not null
      and "discourse_object"."objects" is not null
      and cardinality("discourse_object"."subjects") > 0
      and cardinality("discourse_object"."objects") > 0)
    or
    ("discourse_object"."kind" <> 'relation'
      and "discourse_object"."relation_type" is null
      and "discourse_object"."subjects" is null
      and "discourse_object"."objects" is null
      and "discourse_object"."body" is not null
      and length(trim("discourse_object"."body")) > 0))
);
--> statement-breakpoint
CREATE TABLE "excerpt" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "excerpt_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"local_id" bigint NOT NULL,
	"source_id" bigint NOT NULL,
	"content" text,
	"asset_path" text,
	"locator" text,
	"captured_from" text,
	"created_by_user_id" bigint NOT NULL,
	"born_in_post_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "excerpt_content_check" CHECK (("excerpt"."content" is not null and length(trim("excerpt"."content")) > 0) or "excerpt"."asset_path" is not null)
);
--> statement-breakpoint
CREATE TABLE "forum_user" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "forum_user_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"handle" text NOT NULL,
	"created_by_user_id" bigint,
	"is_owner" boolean DEFAULT false NOT NULL,
	"agent_config" jsonb,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forum_user_kind_check" CHECK ("forum_user"."kind" in ('human', 'agent')),
	CONSTRAINT "forum_user_owner_human_check" CHECK (not "forum_user"."is_owner" or "forum_user"."kind" = 'human'),
	CONSTRAINT "forum_user_agent_config_check" CHECK ("forum_user"."agent_config" is null or "forum_user"."kind" = 'agent')
);
--> statement-breakpoint
CREATE TABLE "mcp_credential" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mcp_credential_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "message_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"conversation_id" bigint NOT NULL,
	"author_user_id" bigint,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_role_check" CHECK ("message"."role" in ('user', 'assistant', 'system')),
	CONSTRAINT "message_author_check" CHECK (("message"."role" = 'user' and "message"."author_user_id" is not null) or ("message"."role" <> 'user' and "message"."author_user_id" is null)),
	CONSTRAINT "message_body_check" CHECK (length(trim("message"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "post" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "post_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"local_id" bigint NOT NULL,
	"thread_id" bigint NOT NULL,
	"author_user_id" bigint NOT NULL,
	"reply_to_post_id" bigint,
	"body" text NOT NULL,
	"refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"mentioned_user_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_invite" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "project_invite_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_by_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_member" (
	"project_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_member_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "project_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"next_address_local_id" bigint DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"default_agent_turn_limit" integer DEFAULT 10 NOT NULL,
	"agent_turn_limit" integer DEFAULT 100 NOT NULL,
	"scribe_provider" text,
	"scribe_model" text,
	"scribe_thinking_level" text DEFAULT 'off' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_default_agent_turn_limit_check" CHECK ("project"."default_agent_turn_limit" >= 0),
	CONSTRAINT "project_agent_turn_limit_check" CHECK ("project"."agent_turn_limit" >= 0),
	CONSTRAINT "project_scribe_model_pair_check" CHECK (("project"."scribe_provider" is null) = ("project"."scribe_model" is null)),
	CONSTRAINT "project_scribe_thinking_level_check" CHECK ("project"."scribe_thinking_level" in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh'))
);
--> statement-breakpoint
CREATE TABLE "result" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "result_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"local_id" bigint NOT NULL,
	"submission_id" text NOT NULL,
	"thread_id" bigint NOT NULL,
	"proposal_id" bigint,
	"outputs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "result_outputs_object_check" CHECK (jsonb_typeof("result"."outputs") = 'object' and "result"."outputs" <> '{}'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "sign_in_link" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sign_in_link_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_by_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"local_id" bigint NOT NULL,
	"locator" text NOT NULL,
	"title" text NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"payload_path" text,
	"payload" "bytea",
	"media_type" text,
	"content_hash" "bytea",
	"added_by_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_payload_hash_check" CHECK (("source"."payload_path" is null and "source"."payload" is null) or "source"."content_hash" is not null),
	CONSTRAINT "source_payload_media_type_check" CHECK (
    ("source"."payload" is null and "source"."media_type" is null)
    or ("source"."payload" is not null and "source"."media_type" in ('application/pdf', 'text/plain')))
);
--> statement-breakpoint
CREATE TABLE "subforum" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subforum_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"row_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "thread_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"subforum_id" bigint NOT NULL,
	"local_id" bigint NOT NULL,
	"title" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"agent_turn_limit" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_agent_turn_limit_check" CHECK ("thread"."agent_turn_limit" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_turn" ADD CONSTRAINT "agent_turn_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn" ADD CONSTRAINT "agent_turn_agent_user_id_forum_user_row_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn" ADD CONSTRAINT "agent_turn_requested_by_user_id_forum_user_row_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn" ADD CONSTRAINT "agent_turn_trigger_post_id_post_row_id_fk" FOREIGN KEY ("trigger_post_id") REFERENCES "public"."post"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn" ADD CONSTRAINT "agent_turn_output_post_id_post_row_id_fk" FOREIGN KEY ("output_post_id") REFERENCES "public"."post"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_session" ADD CONSTRAINT "browser_session_user_id_forum_user_row_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_user_id_forum_user_row_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discourse_object" ADD CONSTRAINT "discourse_object_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discourse_object" ADD CONSTRAINT "discourse_object_creator_user_id_forum_user_row_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discourse_object" ADD CONSTRAINT "discourse_object_born_in_post_id_post_row_id_fk" FOREIGN KEY ("born_in_post_id") REFERENCES "public"."post"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excerpt" ADD CONSTRAINT "excerpt_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excerpt" ADD CONSTRAINT "excerpt_source_id_source_row_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excerpt" ADD CONSTRAINT "excerpt_created_by_user_id_forum_user_row_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excerpt" ADD CONSTRAINT "excerpt_born_in_post_id_post_row_id_fk" FOREIGN KEY ("born_in_post_id") REFERENCES "public"."post"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_user" ADD CONSTRAINT "forum_user_created_by_user_id_forum_user_row_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_credential" ADD CONSTRAINT "mcp_credential_user_id_forum_user_row_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_credential" ADD CONSTRAINT "mcp_credential_created_by_user_id_forum_user_row_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_row_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_user_id_forum_user_row_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_thread_id_thread_row_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_author_user_id_forum_user_row_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_reply_to_post_id_post_row_id_fk" FOREIGN KEY ("reply_to_post_id") REFERENCES "public"."post"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invite" ADD CONSTRAINT "project_invite_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invite" ADD CONSTRAINT "project_invite_created_by_user_id_forum_user_row_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_user_id_forum_user_row_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result" ADD CONSTRAINT "result_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result" ADD CONSTRAINT "result_thread_id_thread_row_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result" ADD CONSTRAINT "result_proposal_id_discourse_object_row_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."discourse_object"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_link" ADD CONSTRAINT "sign_in_link_user_id_forum_user_row_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_link" ADD CONSTRAINT "sign_in_link_created_by_user_id_forum_user_row_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_added_by_user_id_forum_user_row_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subforum" ADD CONSTRAINT "subforum_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_project_id_project_row_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("row_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_subforum_id_subforum_row_id_fk" FOREIGN KEY ("subforum_id") REFERENCES "public"."subforum"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_created_by_user_id_forum_user_row_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."forum_user"("row_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turn_trigger_agent_unique" ON "agent_turn" USING btree ("trigger_post_id","agent_user_id");--> statement-breakpoint
CREATE INDEX "agent_turn_project_created_idx" ON "agent_turn" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_turn_status_idx" ON "agent_turn" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_session_secret_hash_unique" ON "browser_session" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "browser_session_user_idx" ON "browser_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversation_user_project_idx" ON "conversation" USING btree ("user_id","project_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "discourse_object_project_local_unique" ON "discourse_object" USING btree ("project_id","local_id");--> statement-breakpoint
CREATE INDEX "discourse_object_kind_idx" ON "discourse_object" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "discourse_object_post_idx" ON "discourse_object" USING btree ("project_id","born_in_post_id");--> statement-breakpoint
CREATE INDEX "discourse_object_body_search_idx" ON "discourse_object" USING gin (to_tsvector('english', coalesce("body", '')));--> statement-breakpoint
CREATE INDEX "discourse_object_refs_idx" ON "discourse_object" USING gin ("refs");--> statement-breakpoint
CREATE UNIQUE INDEX "excerpt_project_local_unique" ON "excerpt" USING btree ("project_id","local_id");--> statement-breakpoint
CREATE INDEX "excerpt_source_idx" ON "excerpt" USING btree ("project_id","source_id");--> statement-breakpoint
CREATE INDEX "excerpt_content_search_idx" ON "excerpt" USING gin (to_tsvector('english', coalesce("content", '')));--> statement-breakpoint
CREATE UNIQUE INDEX "forum_user_handle_lower_unique" ON "forum_user" USING btree (lower("handle"));--> statement-breakpoint
CREATE UNIQUE INDEX "forum_user_one_owner_unique" ON "forum_user" USING btree ("is_owner") WHERE "forum_user"."is_owner" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_credential_secret_hash_unique" ON "mcp_credential" USING btree ("secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_credential_user_name_unique" ON "mcp_credential" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "mcp_credential_user_idx" ON "mcp_credential" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_conversation_created_idx" ON "message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_project_local_unique" ON "post" USING btree ("project_id","local_id");--> statement-breakpoint
CREATE INDEX "post_thread_local_idx" ON "post" USING btree ("project_id","thread_id","local_id");--> statement-breakpoint
CREATE INDEX "post_author_idx" ON "post" USING btree ("project_id","author_user_id");--> statement-breakpoint
CREATE INDEX "post_body_search_idx" ON "post" USING gin (to_tsvector('english', "body"));--> statement-breakpoint
CREATE INDEX "post_refs_idx" ON "post" USING gin ("refs");--> statement-breakpoint
CREATE INDEX "post_mentions_idx" ON "post" USING gin ("mentioned_user_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "project_invite_secret_hash_unique" ON "project_invite" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "project_invite_project_idx" ON "project_invite" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_member_user_idx" ON "project_member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_public_id_unique" ON "project" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_name_lower_unique" ON "project" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "result_project_local_unique" ON "result" USING btree ("project_id","local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "result_project_submission_unique" ON "result" USING btree ("project_id","submission_id");--> statement-breakpoint
CREATE INDEX "result_thread_created_idx" ON "result" USING btree ("project_id","thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sign_in_link_secret_hash_unique" ON "sign_in_link" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "sign_in_link_user_idx" ON "sign_in_link" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_project_local_unique" ON "source" USING btree ("project_id","local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_project_locator_unique" ON "source" USING btree ("project_id",lower("locator"));--> statement-breakpoint
CREATE INDEX "source_title_search_idx" ON "source" USING gin (to_tsvector('english', "title"));--> statement-breakpoint
CREATE INDEX "source_tags_idx" ON "source" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "subforum_project_name_lower_unique" ON "subforum" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "subforum_project_created_idx" ON "subforum" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_project_local_unique" ON "thread" USING btree ("project_id","local_id");--> statement-breakpoint
CREATE INDEX "thread_subforum_created_idx" ON "thread" USING btree ("project_id","subforum_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_project_created_idx" ON "thread" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_title_search_idx" ON "thread" USING gin (to_tsvector('english', "title"));