CREATE TABLE "apify_actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"actor_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_fields" jsonb NOT NULL,
	"fixed_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_items" integer DEFAULT 50 NOT NULL,
	"timeout_secs" integer DEFAULT 300 NOT NULL,
	"memory_mbytes" integer DEFAULT 1024 NOT NULL,
	"max_charge_micros" bigint NOT NULL,
	"normalizer" text DEFAULT 'generic' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apify_actors_normalizer_check" CHECK ("apify_actors"."normalizer" in ('web_pages', 'search_results', 'generic'))
);
--> statement-breakpoint
CREATE TABLE "apify_connections" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_token" text NOT NULL,
	"token_hint" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apify_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"actor_key" text NOT NULL,
	"input" jsonb NOT NULL,
	"funding" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"apify_run_id" text,
	"dataset_id" text,
	"item_count" integer,
	"cost_micros" bigint,
	"charge_micros" bigint DEFAULT 0 NOT NULL,
	"estimated_charge_micros" bigint,
	"results" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apify_runs_status_check" CHECK ("apify_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'aborted', 'timed_out')),
	CONSTRAINT "apify_runs_funding_check" CHECK ("apify_runs"."funding" in ('byok', 'platform'))
);
--> statement-breakpoint
CREATE TABLE "approved_web_domains" (
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"added_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approved_web_domains_organization_id_domain_pk" PRIMARY KEY("organization_id","domain"),
	CONSTRAINT "approved_web_domains_check" CHECK ("approved_web_domains"."domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
);
--> statement-breakpoint
CREATE TABLE "mcp_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth_header_name" text DEFAULT 'Authorization' NOT NULL,
	"encrypted_secret" text,
	"secret_hint" text,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"tool_catalog" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timeout_ms" integer DEFAULT 20000 NOT NULL,
	"monthly_call_limit" integer,
	"max_result_chars" integer DEFAULT 20000 NOT NULL,
	"owner_user_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_integrations_status_check" CHECK ("mcp_integrations"."status" in ('pending_review', 'active', 'disabled', 'error')),
	CONSTRAINT "mcp_integrations_timeout_check" CHECK ("mcp_integrations"."timeout_ms" between 1000 and 120000),
	CONSTRAINT "mcp_integrations_result_check" CHECK ("mcp_integrations"."max_result_chars" between 500 and 200000)
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"integration_id" uuid,
	"project_id" uuid,
	"user_id" uuid,
	"ai_run_id" uuid,
	"tool" text NOT NULL,
	"args_digest" text NOT NULL,
	"args_preview" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer,
	"result_chars" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tool_calls_status_check" CHECK ("mcp_tool_calls"."status" in ('ok', 'error', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "apify_connections" ADD CONSTRAINT "apify_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apify_connections" ADD CONSTRAINT "apify_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apify_runs" ADD CONSTRAINT "apify_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apify_runs" ADD CONSTRAINT "apify_runs_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apify_runs" ADD CONSTRAINT "apify_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_web_domains" ADD CONSTRAINT "approved_web_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_web_domains" ADD CONSTRAINT "approved_web_domains_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_integrations" ADD CONSTRAINT "mcp_integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_integrations" ADD CONSTRAINT "mcp_integrations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_integration_id_mcp_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."mcp_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apify_actors_key_idx" ON "apify_actors" USING btree ("key");--> statement-breakpoint
CREATE INDEX "apify_runs_project_idx" ON "apify_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_integrations_name_idx" ON "mcp_integrations" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_integration_idx" ON "mcp_tool_calls" USING btree ("integration_id","created_at");--> statement-breakpoint
-- Audit history of external tool calls is append-only.
CREATE TRIGGER mcp_tool_calls_append_only BEFORE UPDATE OR DELETE ON "mcp_tool_calls" FOR EACH ROW EXECUTE FUNCTION rm_org_append_only();
