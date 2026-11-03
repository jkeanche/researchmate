CREATE TABLE "credit_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"pool" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"period" text,
	"usage_record_id" uuid,
	"payment_id" uuid,
	"pricing_version_id" uuid,
	"description" text DEFAULT '' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_kind_check" CHECK ("credit_ledger_entries"."kind" in ('purchase', 'allowance', 'usage', 'refund', 'adjustment')),
	CONSTRAINT "credit_ledger_pool_check" CHECK ("credit_ledger_entries"."pool" in ('credit', 'allowance')),
	CONSTRAINT "credit_ledger_amount_check" CHECK ("credit_ledger_entries"."amount_micros" <> 0),
	CONSTRAINT "credit_ledger_period_check" CHECK ("credit_ledger_entries"."pool" = 'credit' or "credit_ledger_entries"."period" ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" text DEFAULT 'invoice' NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"bill_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_kind_check" CHECK ("invoices"."kind" in ('invoice', 'credit_note'))
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payment_id" uuid,
	"outcome" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"provider_reference" text,
	"price_point_id" uuid,
	"kind" text NOT NULL,
	"plan_id" uuid,
	"interval" text,
	"credit_micros" bigint,
	"currency" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"refunded_minor" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_status" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'cancelled')),
	CONSTRAINT "payments_kind_check" CHECK ("payments"."kind" in ('credits', 'plan')),
	CONSTRAINT "payments_refund_check" CHECK ("payments"."refunded_minor" >= 0 and "payments"."refunded_minor" <= "payments"."amount_minor")
);
--> statement-breakpoint
CREATE TABLE "price_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"plan_id" uuid,
	"credit_micros" bigint,
	"interval" text,
	"currency" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"label" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_points_kind_check" CHECK (("price_points"."kind" = 'credits' and "price_points"."credit_micros" > 0) or ("price_points"."kind" = 'plan' and "price_points"."plan_id" is not null and "price_points"."interval" in ('month', 'year'))),
	CONSTRAINT "price_points_amount_check" CHECK ("price_points"."amount_minor" > 0),
	CONSTRAINT "price_points_currency_check" CHECK ("price_points"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "pricing_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pricing_version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider_key" text,
	"model_id" text,
	"service_key" text,
	"unit" text NOT NULL,
	"input_cost_micros_per_mtok" bigint,
	"output_cost_micros_per_mtok" bigint,
	"unit_cost_micros" bigint,
	"margin_bps_override" integer,
	CONSTRAINT "pricing_items_kind_check" CHECK ("pricing_items"."kind" in ('ai_model', 'service')),
	CONSTRAINT "pricing_items_shape_check" CHECK (("pricing_items"."kind" = 'ai_model' and "pricing_items"."provider_key" is not null and "pricing_items"."model_id" is not null and "pricing_items"."input_cost_micros_per_mtok" >= 0 and "pricing_items"."output_cost_micros_per_mtok" >= 0) or ("pricing_items"."kind" = 'service' and "pricing_items"."service_key" is not null and "pricing_items"."unit_cost_micros" >= 0)),
	CONSTRAINT "pricing_items_margin_check" CHECK ("pricing_items"."margin_bps_override" is null or ("pricing_items"."margin_bps_override" >= 0 and "pricing_items"."margin_bps_override" < 9500))
);
--> statement-breakpoint
CREATE TABLE "pricing_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"target_margin_bps" integer NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_versions_status_check" CHECK ("pricing_versions"."status" in ('draft', 'active', 'retired')),
	CONSTRAINT "pricing_versions_margin_check" CHECK ("pricing_versions"."target_margin_bps" >= 0 and "pricing_versions"."target_margin_bps" < 9500)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_reference" text,
	"error" text,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_status_check" CHECK ("refunds"."status" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "refunds_amount_check" CHECK ("refunds"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "spending_limits" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"monthly_cap_micros" bigint,
	"per_run_cap_micros" bigint,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "pricing_version_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "estimated_charge_micros" bigint;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "pricing_version_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_pricing_version_id_pricing_versions_id_fk" FOREIGN KEY ("pricing_version_id") REFERENCES "public"."pricing_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_price_point_id_price_points_id_fk" FOREIGN KEY ("price_point_id") REFERENCES "public"."price_points"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_points" ADD CONSTRAINT "price_points_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_items" ADD CONSTRAINT "pricing_items_pricing_version_id_pricing_versions_id_fk" FOREIGN KEY ("pricing_version_id") REFERENCES "public"."pricing_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_versions" ADD CONSTRAINT "pricing_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_limits" ADD CONSTRAINT "spending_limits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_limits" ADD CONSTRAINT "spending_limits_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idempotency_idx" ON "credit_ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_org_idx" ON "credit_ledger_entries" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_idx" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE INDEX "invoices_org_idx" ON "invoices" USING btree ("organization_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_idx" ON "payment_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reference_idx" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_ref_idx" ON "payments" USING btree ("provider","provider_reference") WHERE "payments"."provider_reference" is not null;--> statement-breakpoint
CREATE INDEX "payments_org_idx" ON "payments" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_items_model_idx" ON "pricing_items" USING btree ("pricing_version_id","provider_key","model_id") WHERE "pricing_items"."kind" = 'ai_model';--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_items_service_idx" ON "pricing_items" USING btree ("pricing_version_id","service_key") WHERE "pricing_items"."kind" = 'service';--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_versions_version_idx" ON "pricing_versions" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_versions_one_active" ON "pricing_versions" USING btree ("status") WHERE "pricing_versions"."status" = 'active';--> statement-breakpoint
-- Money records are append-only; they disappear only with their organization.
CREATE FUNCTION rm_org_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE OR DELETE ON "credit_ledger_entries" FOR EACH ROW EXECUTE FUNCTION rm_org_append_only();--> statement-breakpoint
CREATE TRIGGER invoices_append_only BEFORE UPDATE OR DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION rm_org_append_only();--> statement-breakpoint
-- Pricing: items change only while their version is a draft; versions move draft → active → retired only.
CREATE FUNCTION rm_pricing_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM pricing_versions WHERE id = COALESCE(NEW.pricing_version_id, OLD.pricing_version_id);
  IF v_status IS DISTINCT FROM 'draft' AND v_status IS NOT NULL THEN
    RAISE EXCEPTION 'pricing version is % and its prices can no longer change', v_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER pricing_items_guard BEFORE INSERT OR UPDATE OR DELETE ON "pricing_items" FOR EACH ROW EXECUTE FUNCTION rm_pricing_item_guard();--> statement-breakpoint
CREATE FUNCTION rm_pricing_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'only draft pricing versions can be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF OLD.status = 'active' AND NEW.status = 'retired' AND NEW.target_margin_bps = OLD.target_margin_bps AND NEW.version = OLD.version THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'pricing version % is % and cannot be changed', OLD.version, OLD.status USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER pricing_versions_guard BEFORE UPDATE OR DELETE ON "pricing_versions" FOR EACH ROW EXECUTE FUNCTION rm_pricing_version_guard();--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1001;
