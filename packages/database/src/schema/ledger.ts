import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { plans } from "./billing";
import { users } from "./identity";
import { organizations } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const orgRef = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

/**
 * Pricing versions. A version is drafted, then activated; once active its
 * items can never change (database trigger). Charges always record the
 * version they were priced with.
 *
 *   customer price = provider cost / (1 − target gross margin)
 */
export const pricingVersions = pgTable(
  "pricing_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    /** Target gross margin in basis points (4000 = 40 %). */
    targetMarginBps: integer("target_margin_bps").notNull(),
    notes: text("notes").notNull().default(""),
    createdByUserId: userRef("created_by_user_id"),
    activatedAt: ts("activated_at"),
    retiredAt: ts("retired_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pricing_versions_version_idx").on(t.version),
    uniqueIndex("pricing_versions_one_active").on(t.status).where(sql`${t.status} = 'active'`),
    check("pricing_versions_status_check", sql`${t.status} in ('draft', 'active', 'retired')`),
    check("pricing_versions_margin_check", sql`${t.targetMarginBps} >= 0 and ${t.targetMarginBps} < 9500`),
  ],
);

export const pricingItems = pgTable(
  "pricing_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pricingVersionId: uuid("pricing_version_id")
      .notNull()
      .references(() => pricingVersions.id, { onDelete: "cascade" }),
    /** ai_model: priced per million input/output tokens. service: priced per unit (OCR page, crawl page, Apify compute unit…). */
    kind: text("kind").notNull(),
    providerKey: text("provider_key"),
    modelId: text("model_id"),
    serviceKey: text("service_key"),
    unit: text("unit").notNull(),
    inputCostMicrosPerMTok: bigint("input_cost_micros_per_mtok", { mode: "number" }),
    outputCostMicrosPerMTok: bigint("output_cost_micros_per_mtok", { mode: "number" }),
    unitCostMicros: bigint("unit_cost_micros", { mode: "number" }),
    marginBpsOverride: integer("margin_bps_override"),
  },
  (t) => [
    uniqueIndex("pricing_items_model_idx").on(t.pricingVersionId, t.providerKey, t.modelId).where(sql`${t.kind} = 'ai_model'`),
    uniqueIndex("pricing_items_service_idx").on(t.pricingVersionId, t.serviceKey).where(sql`${t.kind} = 'service'`),
    check("pricing_items_kind_check", sql`${t.kind} in ('ai_model', 'service')`),
    check(
      "pricing_items_shape_check",
      sql`(${t.kind} = 'ai_model' and ${t.providerKey} is not null and ${t.modelId} is not null and ${t.inputCostMicrosPerMTok} >= 0 and ${t.outputCostMicrosPerMTok} >= 0) or (${t.kind} = 'service' and ${t.serviceKey} is not null and ${t.unitCostMicros} >= 0)`,
    ),
    check("pricing_items_margin_check", sql`${t.marginBpsOverride} is null or (${t.marginBpsOverride} >= 0 and ${t.marginBpsOverride} < 9500)`),
  ],
);

export const LEDGER_KINDS = ["purchase", "allowance", "usage", "refund", "adjustment"] as const;

/**
 * Immutable money ledger in micro-USD. Credits are positive, charges
 * negative. Two pools: prepaid "credit" (carries over) and the plan's
 * monthly "allowance" (used first, resets each month). Every entry has an
 * idempotency key so retries can never double-charge or double-credit.
 */
export const creditLedgerEntries = pgTable(
  "credit_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgRef(),
    kind: text("kind").notNull(),
    pool: text("pool").notNull(),
    amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
    /** Month the allowance entry belongs to (YYYY-MM), for allowance-pool entries. */
    period: text("period"),
    usageRecordId: uuid("usage_record_id"),
    paymentId: uuid("payment_id"),
    pricingVersionId: uuid("pricing_version_id").references(() => pricingVersions.id),
    description: text("description").notNull().default(""),
    idempotencyKey: text("idempotency_key").notNull(),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("credit_ledger_idempotency_idx").on(t.idempotencyKey),
    index("credit_ledger_org_idx").on(t.organizationId, t.createdAt),
    check("credit_ledger_kind_check", sql`${t.kind} in (${inList(LEDGER_KINDS)})`),
    check("credit_ledger_pool_check", sql`${t.pool} in ('credit', 'allowance')`),
    check("credit_ledger_amount_check", sql`${t.amountMicros} <> 0`),
    check("credit_ledger_period_check", sql`${t.pool} = 'credit' or ${t.period} ~ '^[0-9]{4}-[0-9]{2}$'`),
  ],
);

/** Organization spending limits for platform-funded usage (micro-USD). Null = no limit beyond available funds. */
export const spendingLimits = pgTable("spending_limits", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  monthlyCapMicros: bigint("monthly_cap_micros", { mode: "number" }),
  perRunCapMicros: bigint("per_run_cap_micros", { mode: "number" }),
  updatedByUserId: userRef("updated_by_user_id"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * What can be bought, per currency. Amounts are entered by administrators
 * for each currency (no automatic exchange-rate conversion).
 */
export const pricePoints = pgTable(
  "price_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    planId: uuid("plan_id").references(() => plans.id),
    /** Credit added for kind = credits (micro-USD). */
    creditMicros: bigint("credit_micros", { mode: "number" }),
    /** Subscription period for kind = plan. */
    interval: text("interval"),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    label: text("label").notNull(),
    active: integer("active").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("price_points_kind_check", sql`(${t.kind} = 'credits' and ${t.creditMicros} > 0) or (${t.kind} = 'plan' and ${t.planId} is not null and ${t.interval} in ('month', 'year'))`),
    check("price_points_amount_check", sql`${t.amountMinor} > 0`),
    check("price_points_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const PAYMENT_STATUSES = ["pending", "succeeded", "failed", "refunded", "partially_refunded", "cancelled"] as const;

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgRef(),
    provider: text("provider").notNull(),
    /** Our reference sent to the provider (also the idempotency key there). */
    reference: text("reference").notNull(),
    /** Provider's own id (checkout session, order tracking id…), once known. */
    providerReference: text("provider_reference"),
    pricePointId: uuid("price_point_id").references(() => pricePoints.id),
    kind: text("kind").notNull(),
    planId: uuid("plan_id").references(() => plans.id),
    interval: text("interval"),
    creditMicros: bigint("credit_micros", { mode: "number" }),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    refundedMinor: integer("refunded_minor").notNull().default(0),
    status: text("status").notNull().default("pending"),
    /** Provider's last reported status and details (never trusted without server-side verification). */
    providerStatus: text("provider_status"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdByUserId: userRef("created_by_user_id"),
    verifiedAt: ts("verified_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_reference_idx").on(t.reference),
    uniqueIndex("payments_provider_ref_idx").on(t.provider, t.providerReference).where(sql`${t.providerReference} is not null`),
    index("payments_org_idx").on(t.organizationId, t.createdAt),
    check("payments_status_check", sql`${t.status} in (${inList(PAYMENT_STATUSES)})`),
    check("payments_kind_check", sql`${t.kind} in ('credits', 'plan')`),
    check("payments_refund_check", sql`${t.refundedMinor} >= 0 and ${t.refundedMinor} <= ${t.amountMinor}`),
  ],
);

/** Every webhook/IPN received, once per provider event id (idempotent processing). */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull().default("received"),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payment_events_idx").on(t.provider, t.eventId)],
);

/** Issued for every successful payment; append-only (number sequence, never edited). */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    organizationId: orgRef(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    kind: text("kind").notNull().default("invoice"),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    lines: jsonb("lines").$type<{ description: string; amountMinor: number }[]>().notNull(),
    billTo: jsonb("bill_to").$type<Record<string, string>>().notNull().default({}),
    issuedAt: ts("issued_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("invoices_number_idx").on(t.number), index("invoices_org_idx").on(t.organizationId, t.issuedAt), check("invoices_kind_check", sql`${t.kind} in ('invoice', 'credit_note')`)],
);

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    amountMinor: integer("amount_minor").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    providerReference: text("provider_reference"),
    error: text("error"),
    requestedByUserId: userRef("requested_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("refunds_status_check", sql`${t.status} in ('pending', 'succeeded', 'failed')`), check("refunds_amount_check", sql`${t.amountMinor} > 0`)],
);
