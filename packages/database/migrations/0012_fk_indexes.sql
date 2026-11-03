-- Indexes for foreign keys used in joins and in cascading deletes (project, document and organization
-- deletion would otherwise scan whole child tables). FKs to users and small catalogue tables are
-- deliberately left unindexed: users are never hard-deleted and catalogue rows are not deleted.
-- Guarded by tests/performance.test.ts.
CREATE INDEX IF NOT EXISTS "references_file_id_fk_idx" ON "references" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_runs_credential_id_fk_idx" ON "ai_runs" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_suggestions_run_id_fk_idx" ON "ai_suggestions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analyses_dataset_id_fk_idx" ON "analyses" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apify_runs_organization_id_fk_idx" ON "apify_runs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_allocations_funding_source_id_fk_idx" ON "budget_allocations" USING btree ("funding_source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_categories_organization_id_fk_idx" ON "budget_categories" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connected_accounts_organization_id_fk_idx" ON "connected_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "datasets_source_file_id_fk_idx" ON "datasets" USING btree ("source_file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_citations_section_id_fk_idx" ON "document_citations" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_comments_section_id_fk_idx" ON "document_comments" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_exports_version_id_fk_idx" ON "document_exports" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_section_evidence_evidence_id_fk_idx" ON "document_section_evidence" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_specification_versions_project_id_fk_idx" ON "document_specification_versions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_validation_results_document_id_fk_idx" ON "document_validation_results" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_versions_project_id_fk_idx" ON "document_versions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_jobs_connected_account_id_fk_idx" ON "drive_jobs" USING btree ("connected_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_jobs_organization_id_fk_idx" ON "drive_jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_jobs_project_id_fk_idx" ON "drive_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_records_file_id_fk_idx" ON "evidence_records" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_records_research_question_id_fk_idx" ON "evidence_records" USING btree ("research_question_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_records_theme_id_fk_idx" ON "evidence_records" USING btree ("theme_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expense_attachments_file_id_fk_idx" ON "expense_attachments" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_file_references_connected_account_id_fk_idx" ON "external_file_references" USING btree ("connected_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_file_references_imported_file_id_fk_idx" ON "external_file_references" USING btree ("imported_file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_file_references_project_id_fk_idx" ON "external_file_references" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funding_transactions_funding_source_id_fk_idx" ON "funding_transactions" USING btree ("funding_source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_project_id_fk_idx" ON "invitations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_payment_id_fk_idx" ON "invoices" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tool_calls_organization_id_fk_idx" ON "mcp_tool_calls" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tool_calls_project_id_fk_idx" ON "mcp_tool_calls" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_organization_id_fk_idx" ON "notifications" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_project_id_fk_idx" ON "notifications" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_events_payment_id_fk_idx" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_expenses_funding_source_id_fk_idx" ON "project_expenses" USING btree ("funding_source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_resource_assignments_project_id_fk_idx" ON "project_resource_assignments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_risks_task_id_fk_idx" ON "project_risks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_schedule_revisions_project_id_fk_idx" ON "project_schedule_revisions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_stages_template_stage_id_fk_idx" ON "project_stages" USING btree ("template_stage_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refunds_payment_id_fk_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_hypotheses_question_id_fk_idx" ON "research_hypotheses" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_objectives_question_id_fk_idx" ON "research_objectives" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_tasks_stage_id_fk_idx" ON "research_tasks" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_time_entries_task_id_fk_idx" ON "research_time_entries" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_document_id_fk_idx" ON "review_requests" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_export_id_fk_idx" ON "review_requests" USING btree ("export_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_version_id_fk_idx" ON "review_requests" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revision_tasks_document_id_fk_idx" ON "revision_tasks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revision_tasks_feedback_comment_id_fk_idx" ON "revision_tasks" USING btree ("feedback_comment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revision_tasks_review_request_id_fk_idx" ON "revision_tasks" USING btree ("review_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_permissions_permission_key_fk_idx" ON "role_permissions" USING btree ("permission_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supervisor_feedback_project_id_fk_idx" ON "supervisor_feedback" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_records_project_id_fk_idx" ON "usage_records" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_templates_organization_id_fk_idx" ON "workflow_templates" USING btree ("organization_id");
