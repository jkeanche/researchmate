CREATE TABLE "evidence_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"reference_id" uuid,
	"file_id" uuid,
	"page" integer,
	"passage" text NOT NULL,
	"claim" text DEFAULT '' NOT NULL,
	"research_question_id" uuid,
	"theme_id" uuid,
	"extraction_method" text DEFAULT 'manual' NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"review_status" text DEFAULT 'accepted' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_records_method_check" CHECK ("evidence_records"."extraction_method" in ('manual', 'ai')),
	CONSTRAINT "evidence_records_verification_check" CHECK ("evidence_records"."verification_status" in ('unverified', 'verified', 'disputed')),
	CONSTRAINT "evidence_records_review_check" CHECK ("evidence_records"."review_status" in ('pending', 'accepted', 'rejected')),
	CONSTRAINT "evidence_records_page_check" CHECK ("evidence_records"."page" is null or "evidence_records"."page" > 0)
);
--> statement-breakpoint
CREATE TABLE "file_passages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"file_version" integer NOT NULL,
	"page" integer,
	"seq" smallint DEFAULT 0 NOT NULL,
	"text" text NOT NULL,
	"method" text DEFAULT 'text' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
	CONSTRAINT "file_passages_method_check" CHECK ("file_passages"."method" in ('text', 'ocr'))
);
--> statement-breakpoint
CREATE TABLE "literature_matrix_entries" (
	"reference_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"methodology" text DEFAULT '' NOT NULL,
	"population" text DEFAULT '' NOT NULL,
	"findings" text DEFAULT '' NOT NULL,
	"limitations" text DEFAULT '' NOT NULL,
	"research_gap" text DEFAULT '' NOT NULL,
	"theme_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"basis" text DEFAULT 'metadata' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "literature_matrix_basis_check" CHECK ("literature_matrix_entries"."basis" in ('metadata', 'abstract', 'full_text')),
	CONSTRAINT "literature_matrix_source_check" CHECK ("literature_matrix_entries"."source" in ('manual', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"citation_key" text NOT NULL,
	"csl" jsonb NOT NULL,
	"title" text NOT NULL,
	"year" integer,
	"first_author" text,
	"doi" text,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"access_level" text DEFAULT 'metadata' NOT NULL,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retrieved_at" timestamp with time zone,
	"file_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(first_author, '') || ' ' || coalesce(csl->>'abstract', ''))) STORED,
	CONSTRAINT "references_verification_check" CHECK ("references"."verification_status" in ('unverified', 'metadata_retrieved', 'metadata_verified', 'full_text_retrieved', 'full_text_reviewed', 'verification_failed')),
	CONSTRAINT "references_access_check" CHECK ("references"."access_level" in ('metadata', 'abstract', 'full_text')),
	CONSTRAINT "references_key_check" CHECK ("references"."citation_key" ~ '^[A-Za-z0-9][A-Za-z0-9_:.-]{0,80}$')
);
--> statement-breakpoint
CREATE TABLE "research_themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_verification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"method" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_suggestions" DROP CONSTRAINT "ai_suggestions_kind_check";--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_reference_id_references_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."references"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_research_question_id_research_questions_id_fk" FOREIGN KEY ("research_question_id") REFERENCES "public"."research_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_theme_id_research_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."research_themes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_passages" ADD CONSTRAINT "file_passages_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "literature_matrix_entries" ADD CONSTRAINT "literature_matrix_entries_reference_id_references_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."references"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "literature_matrix_entries" ADD CONSTRAINT "literature_matrix_entries_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "literature_matrix_entries" ADD CONSTRAINT "literature_matrix_entries_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "references" ADD CONSTRAINT "references_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "references" ADD CONSTRAINT "references_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "references" ADD CONSTRAINT "references_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_themes" ADD CONSTRAINT "research_themes_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_verification_events" ADD CONSTRAINT "source_verification_events_reference_id_references_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."references"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_verification_events" ADD CONSTRAINT "source_verification_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_records_project_idx" ON "evidence_records" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "evidence_records_reference_idx" ON "evidence_records" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "file_passages_file_idx" ON "file_passages" USING btree ("file_id","file_version","page");--> statement-breakpoint
CREATE INDEX "file_passages_search_idx" ON "file_passages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "literature_matrix_entries_project_idx" ON "literature_matrix_entries" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "references_key_idx" ON "references" USING btree ("project_id","citation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "references_doi_idx" ON "references" USING btree ("project_id","doi") WHERE "references"."doi" is not null;--> statement-breakpoint
CREATE INDEX "references_search_idx" ON "references" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "research_themes_name_idx" ON "research_themes" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "source_verification_events_ref_idx" ON "source_verification_events" USING btree ("reference_id","created_at");--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_kind_check" CHECK ("ai_suggestions"."kind" in ('research_question', 'objective', 'risk', 'task', 'evidence', 'matrix_entry'));