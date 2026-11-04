CREATE TABLE "support_ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_user_id" uuid,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_messages_author_type_check" CHECK ("support_ticket_messages"."author_type" in ('requester', 'staff', 'note')),
	CONSTRAINT "support_messages_body_check" CHECK (length("support_ticket_messages"."body") between 1 and 20000)
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"requester_name" text NOT NULL,
	"requester_email" text NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"category" text DEFAULT 'general' NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assigned_to_user_id" uuid,
	"source" text NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_category_check" CHECK ("support_tickets"."category" in ('general', 'sales', 'billing', 'technical', 'account', 'feedback')),
	CONSTRAINT "support_tickets_status_check" CHECK ("support_tickets"."status" in ('open', 'pending', 'resolved', 'closed')),
	CONSTRAINT "support_tickets_priority_check" CHECK ("support_tickets"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "support_tickets_source_check" CHECK ("support_tickets"."source" in ('contact_form', 'in_app')),
	CONSTRAINT "support_tickets_email_lowercase" CHECK ("support_tickets"."requester_email" = lower("support_tickets"."requester_email"))
);
--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_messages_ticket_idx" ON "support_ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "support_messages_author_idx" ON "support_ticket_messages" USING btree ("author_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_reference_idx" ON "support_tickets" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status","last_message_at");--> statement-breakpoint
CREATE INDEX "support_tickets_user_idx" ON "support_tickets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_email_idx" ON "support_tickets" USING btree ("requester_email");--> statement-breakpoint
CREATE INDEX "support_tickets_org_idx" ON "support_tickets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "support_tickets_assignee_idx" ON "support_tickets" USING btree ("assigned_to_user_id");