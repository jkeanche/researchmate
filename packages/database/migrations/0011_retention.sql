CREATE TABLE "retained_financial_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"organization_name" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoices" jsonb NOT NULL,
	"payments" jsonb NOT NULL,
	"ledger" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "purge_started_at" timestamp with time zone;--> statement-breakpoint
-- Organization-scoped append-only rows may be deleted only while their organization is being purged.
-- UPDATEs are still always refused.
CREATE OR REPLACE FUNCTION rm_org_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id AND purge_started_at IS NULL) THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
-- Retained financial records are never edited; they are removed only by an operator after the legal retention period.
CREATE FUNCTION rm_retained_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'retained financial records are immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER retained_financial_records_immutable BEFORE UPDATE ON "retained_financial_records" FOR EACH ROW EXECUTE FUNCTION rm_retained_records_guard();
