CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"email" text NOT NULL,
	"org_role_key" text NOT NULL,
	"project_role_key" text,
	"supervisor_kind" text,
	"token_hash" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" uuid,
	"accepted_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_status_check" CHECK ("invitations"."status" in ('pending', 'accepted', 'revoked', 'expired')),
	CONSTRAINT "invitations_email_check" CHECK ("invitations"."email" = lower("invitations"."email") and position('@' in "invitations"."email") > 1)
);
--> statement-breakpoint
CREATE TABLE "review_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"export_id" uuid,
	"previous_request_id" uuid,
	"round" integer DEFAULT 1 NOT NULL,
	"submitted_by_user_id" uuid,
	"reviewer_user_id" uuid,
	"message" text DEFAULT '' NOT NULL,
	"due_date" date,
	"status" text DEFAULT 'submitted' NOT NULL,
	"decided_by_user_id" uuid,
	"decision_note" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_requests_status_check" CHECK ("review_requests"."status" in ('submitted', 'in_review', 'changes_requested', 'approved', 'withdrawn')),
	CONSTRAINT "review_requests_decision_check" CHECK (("review_requests"."status" not in ('approved', 'changes_requested')) or ("review_requests"."decided_by_user_id" is not null and "review_requests"."decided_at" is not null)),
	CONSTRAINT "review_requests_not_self_check" CHECK ("review_requests"."decided_by_user_id" is distinct from "review_requests"."submitted_by_user_id" or "review_requests"."decided_by_user_id" is null)
);
--> statement-breakpoint
CREATE TABLE "revision_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid,
	"review_request_id" uuid,
	"feedback_comment_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"section_key" text,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_user_id" uuid,
	"due_date" date,
	"response" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" uuid,
	"addressed_at" timestamp with time zone,
	"verified_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revision_tasks_status_check" CHECK ("revision_tasks"."status" in ('open', 'addressed', 'verified', 'reopened', 'declined')),
	CONSTRAINT "revision_tasks_source_check" CHECK ("revision_tasks"."source" in ('manual', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "supervisor_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'primary' NOT NULL,
	"assigned_by_user_id" uuid,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supervisor_assignments_kind_check" CHECK ("supervisor_assignments"."kind" in ('primary', 'co_supervisor', 'examiner'))
);
--> statement-breakpoint
CREATE TABLE "supervisor_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"review_request_id" uuid NOT NULL,
	"author_user_id" uuid,
	"summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supervisor_feedback_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feedback_id" uuid NOT NULL,
	"section_key" text,
	"section_title" text DEFAULT '' NOT NULL,
	"quote" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"severity" text DEFAULT 'minor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supervisor_feedback_comments_severity_check" CHECK ("supervisor_feedback_comments"."severity" in ('minor', 'major', 'critical')),
	CONSTRAINT "supervisor_feedback_comments_body_size" CHECK (length("supervisor_feedback_comments"."body") between 1 and 5000)
);
--> statement-breakpoint
ALTER TABLE "ai_suggestions" DROP CONSTRAINT "ai_suggestions_kind_check";--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_export_id_document_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."document_exports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_tasks" ADD CONSTRAINT "revision_tasks_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_tasks" ADD CONSTRAINT "revision_tasks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_tasks" ADD CONSTRAINT "revision_tasks_review_request_id_review_requests_id_fk" FOREIGN KEY ("review_request_id") REFERENCES "public"."review_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_tasks" ADD CONSTRAINT "revision_tasks_feedback_comment_id_supervisor_feedback_comments_id_fk" FOREIGN KEY ("feedback_comment_id") REFERENCES "public"."supervisor_feedback_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_tasks" ADD CONSTRAINT "revision_tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_tasks" ADD CONSTRAINT "revision_tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_tasks" ADD CONSTRAINT "revision_tasks_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervisor_assignments" ADD CONSTRAINT "supervisor_assignments_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervisor_assignments" ADD CONSTRAINT "supervisor_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervisor_assignments" ADD CONSTRAINT "supervisor_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervisor_feedback" ADD CONSTRAINT "supervisor_feedback_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervisor_feedback" ADD CONSTRAINT "supervisor_feedback_review_request_id_review_requests_id_fk" FOREIGN KEY ("review_request_id") REFERENCES "public"."review_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervisor_feedback" ADD CONSTRAINT "supervisor_feedback_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervisor_feedback_comments" ADD CONSTRAINT "supervisor_feedback_comments_feedback_id_supervisor_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."supervisor_feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_idx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_idx" ON "invitations" USING btree ("organization_id",coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid),"email") WHERE "invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "review_requests_project_idx" ON "review_requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "review_requests_reviewer_idx" ON "review_requests" USING btree ("reviewer_user_id","status");--> statement-breakpoint
CREATE INDEX "revision_tasks_project_idx" ON "revision_tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "supervisor_assignments_active_idx" ON "supervisor_assignments" USING btree ("project_id","user_id") WHERE "supervisor_assignments"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "supervisor_feedback_author_idx" ON "supervisor_feedback" USING btree ("review_request_id","author_user_id");--> statement-breakpoint
CREATE INDEX "supervisor_feedback_comments_idx" ON "supervisor_feedback_comments" USING btree ("feedback_id");--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_kind_check" CHECK ("ai_suggestions"."kind" in ('research_question', 'objective', 'risk', 'task', 'evidence', 'matrix_entry', 'revision_task'));