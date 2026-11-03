import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { files } from "./files";
import { users } from "./identity";
import { researchTasks } from "./planning";
import { researchProjects } from "./research";
import { organizations } from "./tenancy";

/**
 * Optional project finances (not an accounting system).
 *
 * Money is stored as integer minor units (bigint, mode number: safe up to
 * 9e15 minor units) with an ISO 4217 currency. Every amount in a foreign
 * currency also stores the exchange rate, its date and the converted base
 * amount at the time it was recorded; historical amounts are never
 * re-converted.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const day = (name: string) => date(name, { mode: "string" });
const money = (name: string) => bigint(name, { mode: "number" });
const rate = (name: string) => numeric(name, { precision: 20, scale: 10 });
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const projectRef = () =>
  uuid("project_id")
    .notNull()
    .references(() => researchProjects.id, { onDelete: "cascade" });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const currency = (name: string) => text(name).notNull();

export const projectBudgetSettings = pgTable(
  "project_budget_settings",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => researchProjects.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    baseCurrency: currency("base_currency"),
    /** Warn when committed + actual spending reaches this share of the approved budget. */
    alertThresholdPercent: integer("alert_threshold_percent").notNull().default(80),
    notes: text("notes").notNull().default(""),
    updatedByUserId: userRef("updated_by_user_id"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("project_budget_settings_currency_check", sql`${t.baseCurrency} ~ '^[A-Z]{3}$'`), check("project_budget_settings_threshold_check", sql`${t.alertThresholdPercent} between 1 and 100`)],
);

/** System categories (organization_id null) plus organization-defined custom ones. */
export const budgetCategories = pgTable(
  "budget_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("budget_categories_org_key_idx").on(sql`coalesce(${t.organizationId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.key)],
);

export const FUNDING_KINDS = ["personal", "institutional", "grant", "scholarship", "sponsor", "other"] as const;

export const fundingSources = pgTable(
  "funding_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("grant"),
    funderName: text("funder_name").notNull().default(""),
    reference: text("reference").notNull().default(""),
    currency: currency("currency"),
    /** Total awarded in the source's currency (0 for open-ended personal funding). */
    awardedMinor: money("awarded_minor").notNull().default(0),
    startDate: day("start_date"),
    endDate: day("end_date"),
    reportingPeriod: text("reporting_period").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("funding_sources_project_idx").on(t.projectId),
    check("funding_sources_kind_check", sql`${t.kind} in (${inList(FUNDING_KINDS)})`),
    check("funding_sources_awarded_check", sql`${t.awardedMinor} >= 0`),
    check("funding_sources_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/** Money received from a funding source. Append-only: a mistake is corrected with a negative (reversing) entry. */
export const fundingTransactions = pgTable(
  "funding_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    fundingSourceId: uuid("funding_source_id")
      .notNull()
      .references(() => fundingSources.id, { onDelete: "restrict" }),
    receivedDate: day("received_date").notNull(),
    amountMinor: money("amount_minor").notNull(),
    currency: currency("currency"),
    fxRate: rate("fx_rate").notNull(),
    fxDate: day("fx_date").notNull(),
    baseAmountMinor: money("base_amount_minor").notNull(),
    note: text("note").notNull().default(""),
    recordedByUserId: userRef("recorded_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("funding_transactions_project_idx").on(t.projectId), check("funding_transactions_amount_check", sql`${t.amountMinor} <> 0`)],
);

export const BUDGET_VERSION_STATUSES = ["draft", "approved", "superseded"] as const;

/**
 * Budget versions. A draft is editable; approving it freezes it (database
 * triggers refuse later changes) and marks the previously approved version
 * superseded. Revisions are new versions, so every approved budget is kept.
 */
export const budgetVersions = pgTable(
  "budget_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    number: integer("number").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("draft"),
    notes: text("notes").notNull().default(""),
    baseCurrency: currency("base_currency"),
    totalBaseMinor: money("total_base_minor").notNull().default(0),
    createdByUserId: userRef("created_by_user_id"),
    approvedByUserId: userRef("approved_by_user_id"),
    approvedAt: ts("approved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("budget_versions_number").on(t.projectId, t.number),
    uniqueIndex("budget_versions_one_approved").on(t.projectId).where(sql`${t.status} = 'approved'`),
    uniqueIndex("budget_versions_one_draft").on(t.projectId).where(sql`${t.status} = 'draft'`),
    check("budget_versions_status_check", sql`${t.status} in (${inList(BUDGET_VERSION_STATUSES)})`),
    check("budget_versions_total_check", sql`${t.totalBaseMinor} >= 0`),
  ],
);

export const budgetAllocations = pgTable(
  "budget_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => budgetVersions.id, { onDelete: "cascade" }),
    categoryKey: text("category_key").notNull(),
    fundingSourceId: uuid("funding_source_id").references(() => fundingSources.id, { onDelete: "restrict" }),
    amountBaseMinor: money("amount_base_minor").notNull(),
    note: text("note").notNull().default(""),
  },
  (t) => [
    index("budget_allocations_version_idx").on(t.versionId),
    uniqueIndex("budget_allocations_line_idx").on(t.versionId, t.categoryKey, sql`coalesce(${t.fundingSourceId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
    check("budget_allocations_amount_check", sql`${t.amountBaseMinor} >= 0`),
  ],
);

/**
 * Status buckets are mutually exclusive, so nothing is counted twice:
 *   draft, rejected, cancelled → not counted
 *   submitted                  → pending
 *   approved                   → committed (approved, not yet paid)
 *   paid, reimbursed           → actual expenditure
 */
export const EXPENSE_STATUSES = ["draft", "submitted", "approved", "rejected", "paid", "reimbursed", "cancelled"] as const;
export const PAYMENT_METHODS = ["cash", "mobile_money", "bank_transfer", "card", "cheque", "invoice", "other"] as const;

export const projectExpenses = pgTable(
  "project_expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    categoryKey: text("category_key").notNull(),
    taskId: uuid("task_id").references(() => researchTasks.id, { onDelete: "set null" }),
    fundingSourceId: uuid("funding_source_id").references(() => fundingSources.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    vendor: text("vendor").notNull().default(""),
    paymentMethod: text("payment_method").notNull().default("other"),
    expenseDate: day("expense_date").notNull(),
    amountMinor: money("amount_minor").notNull(),
    currency: currency("currency"),
    fxRate: rate("fx_rate").notNull(),
    fxDate: day("fx_date").notNull(),
    baseAmountMinor: money("base_amount_minor").notNull(),
    status: text("status").notNull().default("draft"),
    recurring: boolean("recurring").notNull().default(false),
    notes: text("notes").notNull().default(""),
    submittedByUserId: userRef("submitted_by_user_id"),
    submittedAt: ts("submitted_at"),
    approvedByUserId: userRef("approved_by_user_id"),
    approvedAt: ts("approved_at"),
    paidAt: day("paid_at"),
    createdByUserId: userRef("created_by_user_id"),
    version: integer("version").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("project_expenses_project_idx").on(t.projectId, t.expenseDate),
    index("project_expenses_task_idx").on(t.taskId),
    check("project_expenses_status_check", sql`${t.status} in (${inList(EXPENSE_STATUSES)})`),
    check("project_expenses_method_check", sql`${t.paymentMethod} in (${inList(PAYMENT_METHODS)})`),
    check("project_expenses_amount_check", sql`${t.amountMinor} > 0 and ${t.baseAmountMinor} >= 0`),
    check("project_expenses_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const expenseAttachments = pgTable(
  "expense_attachments",
  {
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => projectExpenses.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "restrict" }),
    addedByUserId: userRef("added_by_user_id"),
    addedAt: ts("added_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.expenseId, t.fileId] })],
);

export const expenseApprovals = pgTable(
  "expense_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => projectExpenses.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    actorUserId: userRef("actor_user_id"),
    note: text("note").notNull().default(""),
    /** True when the approver also submitted the expense. */
    selfApproved: boolean("self_approved").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("expense_approvals_expense_idx").on(t.expenseId, t.createdAt)],
);

/** Planned cost of a task (Gantt-linked estimate). Estimates are never actual spending. */
export const taskCostEstimates = pgTable(
  "task_cost_estimates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    categoryKey: text("category_key").notNull(),
    amountBaseMinor: money("amount_base_minor").notNull(),
    note: text("note").notNull().default(""),
    /** manual or ai (a later milestone); AI estimates are labelled as such. */
    source: text("source").notNull().default("manual"),
    createdByUserId: userRef("created_by_user_id"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("task_cost_estimates_line").on(t.taskId, t.categoryKey),
    index("task_cost_estimates_project_idx").on(t.projectId),
    check("task_cost_estimates_amount_check", sql`${t.amountBaseMinor} >= 0`),
    check("task_cost_estimates_source_check", sql`${t.source} in ('manual', 'ai')`),
  ],
);

/** Manually entered rates (units of `quote` per 1 unit of `base`). No rate feed is assumed. */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fromCurrency: currency("from_currency"),
    toCurrency: currency("to_currency"),
    rate: rate("rate").notNull(),
    rateDate: day("rate_date").notNull(),
    source: text("source").notNull().default("manual"),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique("exchange_rates_pair_date").on(t.organizationId, t.fromCurrency, t.toCurrency, t.rateDate), check("exchange_rates_rate_check", sql`${t.rate} > 0`)],
);

/** Append-only financial audit trail with before/after snapshots. */
export const financialAuditEvents = pgTable(
  "financial_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => researchProjects.id, { onDelete: "cascade" }),
    actorUserId: userRef("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("financial_audit_events_project_idx").on(t.projectId, t.createdAt)],
);
