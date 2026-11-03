CREATE TABLE "budget_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"category_key" text NOT NULL,
	"funding_source_id" uuid,
	"amount_base_minor" bigint NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "budget_allocations_amount_check" CHECK ("budget_allocations"."amount_base_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"base_currency" text NOT NULL,
	"total_base_minor" bigint DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_versions_number" UNIQUE("project_id","number"),
	CONSTRAINT "budget_versions_status_check" CHECK ("budget_versions"."status" in ('draft', 'approved', 'superseded')),
	CONSTRAINT "budget_versions_total_check" CHECK ("budget_versions"."total_base_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"rate_date" date NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_pair_date" UNIQUE("organization_id","from_currency","to_currency","rate_date"),
	CONSTRAINT "exchange_rates_rate_check" CHECK ("exchange_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "expense_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"actor_user_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	"self_approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_attachments" (
	"expense_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"added_by_user_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_attachments_expense_id_file_id_pk" PRIMARY KEY("expense_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "financial_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'grant' NOT NULL,
	"funder_name" text DEFAULT '' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"currency" text NOT NULL,
	"awarded_minor" bigint DEFAULT 0 NOT NULL,
	"start_date" date,
	"end_date" date,
	"reporting_period" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_sources_kind_check" CHECK ("funding_sources"."kind" in ('personal', 'institutional', 'grant', 'scholarship', 'sponsor', 'other')),
	CONSTRAINT "funding_sources_awarded_check" CHECK ("funding_sources"."awarded_minor" >= 0),
	CONSTRAINT "funding_sources_currency_check" CHECK ("funding_sources"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "funding_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"funding_source_id" uuid NOT NULL,
	"received_date" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"fx_rate" numeric(20, 10) NOT NULL,
	"fx_date" date NOT NULL,
	"base_amount_minor" bigint NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_transactions_amount_check" CHECK ("funding_transactions"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE TABLE "project_budget_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"base_currency" text NOT NULL,
	"alert_threshold_percent" integer DEFAULT 80 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_budget_settings_currency_check" CHECK ("project_budget_settings"."base_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "project_budget_settings_threshold_check" CHECK ("project_budget_settings"."alert_threshold_percent" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "project_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"category_key" text NOT NULL,
	"task_id" uuid,
	"funding_source_id" uuid,
	"description" text NOT NULL,
	"vendor" text DEFAULT '' NOT NULL,
	"payment_method" text DEFAULT 'other' NOT NULL,
	"expense_date" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"fx_rate" numeric(20, 10) NOT NULL,
	"fx_date" date NOT NULL,
	"base_amount_minor" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"recurring" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"submitted_by_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"paid_at" date,
	"created_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_expenses_status_check" CHECK ("project_expenses"."status" in ('draft', 'submitted', 'approved', 'rejected', 'paid', 'reimbursed', 'cancelled')),
	CONSTRAINT "project_expenses_method_check" CHECK ("project_expenses"."payment_method" in ('cash', 'mobile_money', 'bank_transfer', 'card', 'cheque', 'invoice', 'other')),
	CONSTRAINT "project_expenses_amount_check" CHECK ("project_expenses"."amount_minor" > 0 and "project_expenses"."base_amount_minor" >= 0),
	CONSTRAINT "project_expenses_currency_check" CHECK ("project_expenses"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "task_cost_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"category_key" text NOT NULL,
	"amount_base_minor" bigint NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_cost_estimates_line" UNIQUE("task_id","category_key"),
	CONSTRAINT "task_cost_estimates_amount_check" CHECK ("task_cost_estimates"."amount_base_minor" >= 0),
	CONSTRAINT "task_cost_estimates_source_check" CHECK ("task_cost_estimates"."source" in ('manual', 'ai'))
);
--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_version_id_budget_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."budget_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_funding_source_id_funding_sources_id_fk" FOREIGN KEY ("funding_source_id") REFERENCES "public"."funding_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_categories" ADD CONSTRAINT "budget_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_approvals" ADD CONSTRAINT "expense_approvals_expense_id_project_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."project_expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_approvals" ADD CONSTRAINT "expense_approvals_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_attachments" ADD CONSTRAINT "expense_attachments_expense_id_project_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."project_expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_attachments" ADD CONSTRAINT "expense_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_attachments" ADD CONSTRAINT "expense_attachments_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_audit_events" ADD CONSTRAINT "financial_audit_events_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_audit_events" ADD CONSTRAINT "financial_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_sources" ADD CONSTRAINT "funding_sources_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_sources" ADD CONSTRAINT "funding_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_funding_source_id_funding_sources_id_fk" FOREIGN KEY ("funding_source_id") REFERENCES "public"."funding_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_settings" ADD CONSTRAINT "project_budget_settings_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_settings" ADD CONSTRAINT "project_budget_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_expenses" ADD CONSTRAINT "project_expenses_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_expenses" ADD CONSTRAINT "project_expenses_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_expenses" ADD CONSTRAINT "project_expenses_funding_source_id_funding_sources_id_fk" FOREIGN KEY ("funding_source_id") REFERENCES "public"."funding_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_expenses" ADD CONSTRAINT "project_expenses_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_expenses" ADD CONSTRAINT "project_expenses_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_expenses" ADD CONSTRAINT "project_expenses_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_cost_estimates" ADD CONSTRAINT "task_cost_estimates_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_cost_estimates" ADD CONSTRAINT "task_cost_estimates_task_id_research_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."research_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_cost_estimates" ADD CONSTRAINT "task_cost_estimates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_allocations_version_idx" ON "budget_allocations" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_allocations_line_idx" ON "budget_allocations" USING btree ("version_id","category_key",coalesce("funding_source_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX "budget_categories_org_key_idx" ON "budget_categories" USING btree (coalesce("organization_id", '00000000-0000-0000-0000-000000000000'::uuid),"key");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_versions_one_approved" ON "budget_versions" USING btree ("project_id") WHERE "budget_versions"."status" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "budget_versions_one_draft" ON "budget_versions" USING btree ("project_id") WHERE "budget_versions"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "expense_approvals_expense_idx" ON "expense_approvals" USING btree ("expense_id","created_at");--> statement-breakpoint
CREATE INDEX "financial_audit_events_project_idx" ON "financial_audit_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "funding_sources_project_idx" ON "funding_sources" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "funding_transactions_project_idx" ON "funding_transactions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_expenses_project_idx" ON "project_expenses" USING btree ("project_id","expense_date");--> statement-breakpoint
CREATE INDEX "project_expenses_task_idx" ON "project_expenses" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_cost_estimates_project_idx" ON "task_cost_estimates" USING btree ("project_id");--> statement-breakpoint
-- Approved budget versions are frozen. The only change allowed afterwards is
-- approved → superseded (when a newer version is approved). Deletes only
-- happen when the whole project is deleted.
CREATE FUNCTION rm_budget_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND EXISTS (SELECT 1 FROM research_projects WHERE id = OLD.project_id) THEN
      RAISE EXCEPTION 'approved budget versions cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF OLD.status = 'approved' AND NEW.status = 'superseded'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'approved budget versions are immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER budget_versions_guard BEFORE UPDATE OR DELETE ON "budget_versions" FOR EACH ROW EXECUTE FUNCTION rm_budget_version_guard();--> statement-breakpoint
CREATE FUNCTION rm_budget_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM budget_versions WHERE id = COALESCE(NEW.version_id, OLD.version_id);
  IF v_status IS NULL THEN RETURN COALESCE(NEW, OLD); END IF; -- version being deleted (cascade)
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'allocations of an approved budget cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER budget_allocations_guard BEFORE INSERT OR UPDATE OR DELETE ON "budget_allocations" FOR EACH ROW EXECUTE FUNCTION rm_budget_allocation_guard();--> statement-breakpoint
CREATE FUNCTION rm_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM research_projects WHERE id = OLD.project_id) THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER financial_audit_events_append_only BEFORE UPDATE OR DELETE ON "financial_audit_events" FOR EACH ROW EXECUTE FUNCTION rm_append_only();--> statement-breakpoint
CREATE TRIGGER funding_transactions_append_only BEFORE UPDATE OR DELETE ON "funding_transactions" FOR EACH ROW EXECUTE FUNCTION rm_append_only();
