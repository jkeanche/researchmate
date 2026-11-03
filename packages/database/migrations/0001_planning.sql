CREATE TABLE "project_calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'meeting' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"start_time" text,
	"location" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_calendar_events_kind_check" CHECK ("project_calendar_events"."kind" in ('meeting', 'supervisor_meeting', 'deadline', 'fieldwork', 'conference', 'other')),
	CONSTRAINT "project_calendar_events_dates_check" CHECK ("project_calendar_events"."end_date" >= "project_calendar_events"."start_date"),
	CONSTRAINT "project_calendar_events_time_check" CHECK ("project_calendar_events"."start_time" is null or "project_calendar_events"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "project_resource_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"allocation_percent" smallint DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_resource_assignments_task_user" UNIQUE("task_id","user_id"),
	CONSTRAINT "project_resource_assignments_alloc_check" CHECK ("project_resource_assignments"."allocation_percent" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "project_risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"likelihood" smallint NOT NULL,
	"impact" smallint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_user_id" uuid,
	"mitigation" text DEFAULT '' NOT NULL,
	"contingency" text DEFAULT '' NOT NULL,
	"task_id" uuid,
	"review_date" date,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_risks_likelihood_check" CHECK ("project_risks"."likelihood" between 1 and 5),
	CONSTRAINT "project_risks_impact_check" CHECK ("project_risks"."impact" between 1 and 5),
	CONSTRAINT "project_risks_category_check" CHECK ("project_risks"."category" in ('schedule', 'data_collection', 'ethics', 'financial', 'technical', 'personnel', 'supervision', 'other')),
	CONSTRAINT "project_risks_status_check" CHECK ("project_risks"."status" in ('open', 'mitigating', 'occurred', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "project_schedule_baseline_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"baseline_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"estimate_hours" numeric(8, 2),
	CONSTRAINT "project_schedule_baseline_items_task" UNIQUE("baseline_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "project_schedule_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"approved_by_user_id" uuid,
	"planned_finish" date,
	"task_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_schedule_baselines_number" UNIQUE("project_id","number")
);
--> statement-breakpoint
CREATE TABLE "project_schedule_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"changed_by_user_id" uuid,
	"source" text NOT NULL,
	"old_start_date" date,
	"old_end_date" date,
	"new_start_date" date NOT NULL,
	"new_end_date" date NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_schedule_revisions_source_check" CHECK ("project_schedule_revisions"."source" in ('manual', 'gantt', 'cascade', 'rollup', 'proposal', 'locked_override'))
);
--> statement-breakpoint
CREATE TABLE "project_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"template_stage_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"required_inputs" text DEFAULT '' NOT NULL,
	"expected_outputs" text DEFAULT '' NOT NULL,
	"completion_criteria" text DEFAULT '' NOT NULL,
	"nominal_duration_days" integer DEFAULT 7 NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"milestone_name" text,
	"sort_order" integer NOT NULL,
	"iteration" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"optional" boolean DEFAULT false NOT NULL,
	"approval_required" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"responsible_user_id" uuid,
	"due_date" date,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"awaiting_approval_since" timestamp with time zone,
	"approval_wait_seconds" integer DEFAULT 0 NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_stages_status_check" CHECK ("project_stages"."status" in ('not_started', 'in_progress', 'awaiting_approval', 'completed', 'skipped')),
	CONSTRAINT "project_stages_wait_check" CHECK ("project_stages"."approval_wait_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_hypotheses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"question_id" uuid,
	"null_hypothesis" text NOT NULL,
	"alternative_hypothesis" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_objectives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text DEFAULT 'specific' NOT NULL,
	"text" text NOT NULL,
	"question_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_objectives_kind_check" CHECK ("research_objectives"."kind" in ('general', 'specific'))
);
--> statement-breakpoint
CREATE TABLE "research_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text DEFAULT 'specific' NOT NULL,
	"text" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_questions_kind_check" CHECK ("research_questions"."kind" in ('main', 'specific'))
);
--> statement-breakpoint
CREATE TABLE "research_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"stage_id" uuid,
	"parent_task_id" uuid,
	"kind" text DEFAULT 'task' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_user_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"actual_start_date" date,
	"actual_end_date" date,
	"progress_percent" smallint DEFAULT 0 NOT NULL,
	"estimate_hours" numeric(8, 2),
	"deadline_locked" boolean DEFAULT false NOT NULL,
	"requires_completion_approval" boolean DEFAULT false NOT NULL,
	"completion_approved_by_user_id" uuid,
	"completion_approved_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_tasks_kind_check" CHECK ("research_tasks"."kind" in ('task', 'milestone')),
	CONSTRAINT "research_tasks_status_check" CHECK ("research_tasks"."status" in ('todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled')),
	CONSTRAINT "research_tasks_priority_check" CHECK ("research_tasks"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "research_tasks_dates_check" CHECK ("research_tasks"."end_date" >= "research_tasks"."start_date"),
	CONSTRAINT "research_tasks_milestone_check" CHECK ("research_tasks"."kind" <> 'milestone' or "research_tasks"."end_date" = "research_tasks"."start_date"),
	CONSTRAINT "research_tasks_actual_dates_check" CHECK ("research_tasks"."actual_end_date" is null or "research_tasks"."actual_start_date" is null or "research_tasks"."actual_end_date" >= "research_tasks"."actual_start_date"),
	CONSTRAINT "research_tasks_progress_check" CHECK ("research_tasks"."progress_percent" between 0 and 100),
	CONSTRAINT "research_tasks_estimate_check" CHECK ("research_tasks"."estimate_hours" is null or "research_tasks"."estimate_hours" >= 0),
	CONSTRAINT "research_tasks_not_own_parent" CHECK ("research_tasks"."parent_task_id" is null or "research_tasks"."parent_task_id" <> "research_tasks"."id")
);
--> statement-breakpoint
CREATE TABLE "research_time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"user_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"minutes" integer NOT NULL,
	"category" text DEFAULT 'research' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_time_entries_minutes_check" CHECK ("research_time_entries"."minutes" between 1 and 1440),
	CONSTRAINT "research_time_entries_category_check" CHECK ("research_time_entries"."category" in ('research', 'writing', 'analysis', 'data_collection', 'revision', 'meeting', 'admin', 'other'))
);
--> statement-breakpoint
CREATE TABLE "schedule_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_proposals_status_check" CHECK ("schedule_proposals"."status" in ('pending', 'approved', 'rejected', 'superseded')),
	CONSTRAINT "schedule_proposals_source_check" CHECK ("schedule_proposals"."source" in ('template', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "task_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"predecessor_id" uuid NOT NULL,
	"successor_id" uuid NOT NULL,
	"type" text DEFAULT 'FS' NOT NULL,
	"lag_days" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_pair" UNIQUE("predecessor_id","successor_id"),
	CONSTRAINT "task_dependencies_type_check" CHECK ("task_dependencies"."type" in ('FS', 'SS', 'FF', 'SF')),
	CONSTRAINT "task_dependencies_not_self" CHECK ("task_dependencies"."predecessor_id" <> "task_dependencies"."successor_id"),
	CONSTRAINT "task_dependencies_lag_check" CHECK ("task_dependencies"."lag_days" between -365 and 365)
);
--> statement-breakpoint
CREATE TABLE "workflow_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"expected_outputs" text DEFAULT '' NOT NULL,
	"completion_criteria" text DEFAULT '' NOT NULL,
	"duration_days" integer NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_required" boolean DEFAULT false NOT NULL,
	"optional" boolean DEFAULT false NOT NULL,
	"milestone_name" text,
	"sort_order" integer NOT NULL,
	CONSTRAINT "workflow_stages_template_key" UNIQUE("template_id","key"),
	CONSTRAINT "workflow_stages_duration_check" CHECK ("workflow_stages"."duration_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"default_for" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_projects" ADD COLUMN "progress_source" text DEFAULT 'tasks' NOT NULL;--> statement-breakpoint
ALTER TABLE "research_projects" ADD COLUMN "workflow_template_key" text;--> statement-breakpoint
ALTER TABLE "research_projects" ADD COLUMN "workflow_template_version" integer;--> statement-breakpoint
ALTER TABLE "project_calendar_events" ADD CONSTRAINT "project_calendar_events_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calendar_events" ADD CONSTRAINT "project_calendar_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_resource_assignments" ADD CONSTRAINT "project_resource_assignments_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_resource_assignments" ADD CONSTRAINT "project_resource_assignments_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_resource_assignments" ADD CONSTRAINT "project_resource_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_schedule_baseline_items" ADD CONSTRAINT "project_schedule_baseline_items_baseline_id_project_schedule_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."project_schedule_baselines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_schedule_baselines" ADD CONSTRAINT "project_schedule_baselines_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_schedule_baselines" ADD CONSTRAINT "project_schedule_baselines_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_schedule_revisions" ADD CONSTRAINT "project_schedule_revisions_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_schedule_revisions" ADD CONSTRAINT "project_schedule_revisions_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_schedule_revisions" ADD CONSTRAINT "project_schedule_revisions_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_template_stage_id_workflow_stages_id_fk" FOREIGN KEY ("template_stage_id") REFERENCES "public"."workflow_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_hypotheses" ADD CONSTRAINT "research_hypotheses_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_hypotheses" ADD CONSTRAINT "research_hypotheses_question_id_research_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."research_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_hypotheses" ADD CONSTRAINT "research_hypotheses_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_objectives" ADD CONSTRAINT "research_objectives_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_objectives" ADD CONSTRAINT "research_objectives_question_id_research_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."research_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_objectives" ADD CONSTRAINT "research_objectives_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_questions" ADD CONSTRAINT "research_questions_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_questions" ADD CONSTRAINT "research_questions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_stage_id_project_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."project_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_parent_task_id_research_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."research_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_completion_approved_by_user_id_users_id_fk" FOREIGN KEY ("completion_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_time_entries" ADD CONSTRAINT "research_time_entries_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_time_entries" ADD CONSTRAINT "research_time_entries_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_time_entries" ADD CONSTRAINT "research_time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_predecessor_id_research_tasks_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."research_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_successor_id_research_tasks_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."research_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_stages" ADD CONSTRAINT "workflow_stages_template_id_workflow_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_calendar_events_project_idx" ON "project_calendar_events" USING btree ("project_id","start_date");--> statement-breakpoint
CREATE INDEX "project_risks_project_idx" ON "project_risks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_schedule_revisions_task_idx" ON "project_schedule_revisions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "project_stages_project_idx" ON "project_stages" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "research_hypotheses_project_idx" ON "research_hypotheses" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "research_objectives_project_idx" ON "research_objectives" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "research_questions_project_idx" ON "research_questions" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "research_tasks_project_idx" ON "research_tasks" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "research_tasks_parent_idx" ON "research_tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "research_tasks_assignee_idx" ON "research_tasks" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE INDEX "research_time_entries_project_idx" ON "research_time_entries" USING btree ("project_id","entry_date");--> statement-breakpoint
CREATE INDEX "schedule_proposals_project_idx" ON "schedule_proposals" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "task_checklist_items_task_idx" ON "task_checklist_items" USING btree ("task_id","sort_order");--> statement-breakpoint
CREATE INDEX "task_comments_task_idx" ON "task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_dependencies_project_idx" ON "task_dependencies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_successor_idx" ON "task_dependencies" USING btree ("successor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_templates_key_version_idx" ON "workflow_templates" USING btree (coalesce("organization_id", '00000000-0000-0000-0000-000000000000'::uuid),"key","version");--> statement-breakpoint
ALTER TABLE "research_projects" ADD CONSTRAINT "research_projects_progress_source_check" CHECK ("research_projects"."progress_source" in ('manual', 'tasks'));--> statement-breakpoint
-- Projects created before planning existed keep their hand-set progress.
UPDATE "research_projects" SET "progress_source" = 'manual';--> statement-breakpoint
-- Baselines are append-only. Updates are always refused; deletes only succeed
-- as part of deleting the owning project (or baseline), never on their own.
CREATE FUNCTION rm_baseline_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'schedule baselines are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_TABLE_NAME = 'project_schedule_baselines' THEN
    IF EXISTS (SELECT 1 FROM research_projects WHERE id = OLD.project_id) THEN
      RAISE EXCEPTION 'schedule baselines cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM project_schedule_baselines WHERE id = OLD.baseline_id) THEN
      RAISE EXCEPTION 'schedule baseline items cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER project_schedule_baselines_immutable BEFORE UPDATE OR DELETE ON "project_schedule_baselines" FOR EACH ROW EXECUTE FUNCTION rm_baseline_immutable();--> statement-breakpoint
CREATE TRIGGER project_schedule_baseline_items_immutable BEFORE UPDATE OR DELETE ON "project_schedule_baseline_items" FOR EACH ROW EXECUTE FUNCTION rm_baseline_immutable();
