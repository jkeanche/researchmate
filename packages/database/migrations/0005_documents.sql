CREATE TABLE "document_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"reference_id" uuid,
	"citation_key" text NOT NULL,
	"locator" text,
	"ordinal" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"section_id" uuid,
	"parent_id" uuid,
	"quote" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"author_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_comments_body_size" CHECK (length("document_comments"."body") between 1 and 5000)
);
--> statement-breakpoint
CREATE TABLE "document_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"size_bytes" integer,
	"page_count" integer,
	"error" text,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "document_exports_format_check" CHECK ("document_exports"."format" in ('docx', 'pdf')),
	CONSTRAINT "document_exports_status_check" CHECK ("document_exports"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "document_section_evidence" (
	"section_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"linked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_section_evidence_section_id_evidence_id_pk" PRIMARY KEY("section_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "document_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort_order" integer NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"word_limit" integer,
	"guidance" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_sections_kind_check" CHECK ("document_sections"."kind" in ('title', 'front', 'toc', 'body', 'references', 'appendix')),
	CONSTRAINT "document_sections_content_size" CHECK (length("document_sections"."content") <= 400000)
);
--> statement-breakpoint
CREATE TABLE "document_specification_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"document_type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"spec" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_templates_type_check" CHECK ("document_templates"."document_type" in ('undergraduate_project', 'masters_dissertation', 'phd_thesis', 'journal_article', 'conference_paper', 'proposal', 'report', 'custom'))
);
--> statement-breakpoint
CREATE TABLE "document_validation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"export_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"passed" boolean NOT NULL,
	"checks" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"spec_version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"document_type" text NOT NULL,
	"template_key" text,
	"template_version" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"spec_version" integer DEFAULT 1 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_type_check" CHECK ("documents"."document_type" in ('undergraduate_project', 'masters_dissertation', 'phd_thesis', 'journal_article', 'conference_paper', 'proposal', 'report', 'custom')),
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('draft', 'in_review', 'final'))
);
--> statement-breakpoint
ALTER TABLE "document_citations" ADD CONSTRAINT "document_citations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_citations" ADD CONSTRAINT "document_citations_section_id_document_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."document_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_citations" ADD CONSTRAINT "document_citations_reference_id_references_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."references"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_section_id_document_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."document_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_exports" ADD CONSTRAINT "document_exports_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_exports" ADD CONSTRAINT "document_exports_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_exports" ADD CONSTRAINT "document_exports_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_section_evidence" ADD CONSTRAINT "document_section_evidence_section_id_document_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."document_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_section_evidence" ADD CONSTRAINT "document_section_evidence_evidence_id_evidence_records_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_section_evidence" ADD CONSTRAINT "document_section_evidence_linked_by_user_id_users_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_specification_versions" ADD CONSTRAINT "document_specification_versions_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_specification_versions" ADD CONSTRAINT "document_specification_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_specification_versions" ADD CONSTRAINT "document_specification_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_validation_results" ADD CONSTRAINT "document_validation_results_export_id_document_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."document_exports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_validation_results" ADD CONSTRAINT "document_validation_results_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_citations_doc_idx" ON "document_citations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_citations_ref_idx" ON "document_citations" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "document_comments_doc_idx" ON "document_comments" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "document_exports_doc_idx" ON "document_exports" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_sections_key_idx" ON "document_sections" USING btree ("document_id","key");--> statement-breakpoint
CREATE INDEX "document_sections_order_idx" ON "document_sections" USING btree ("document_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "document_spec_versions_idx" ON "document_specification_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "document_templates_key_version_idx" ON "document_templates" USING btree ("key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "document_validation_export_idx" ON "document_validation_results" USING btree ("export_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_number_idx" ON "document_versions" USING btree ("document_id","number");--> statement-breakpoint
CREATE INDEX "documents_project_idx" ON "documents" USING btree ("project_id");--> statement-breakpoint
-- Specification and content versions are history: never edited, removed only with their document.
CREATE FUNCTION rm_document_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM documents WHERE id = OLD.document_id) THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER document_versions_append_only BEFORE UPDATE OR DELETE ON "document_versions" FOR EACH ROW EXECUTE FUNCTION rm_document_history_guard();--> statement-breakpoint
CREATE TRIGGER document_spec_versions_append_only BEFORE UPDATE OR DELETE ON "document_specification_versions" FOR EACH ROW EXECUTE FUNCTION rm_document_history_guard();
