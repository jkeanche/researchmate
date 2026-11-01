import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { organizations } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Entitlement value: boolean flag, numeric limit (null = unlimited) or tier string. */
export type EntitlementValue = boolean | number | string | null;

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Minor currency units (cents). */
    priceMinor: integer("price_minor").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    billingInterval: text("billing_interval").notNull().default("month"),
    isPublic: boolean("is_public").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    /** Plan assigned to new organizations. Exactly one plan may be the default. */
    isDefault: boolean("is_default").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("plans_key_unique").on(t.key),
    uniqueIndex("plans_single_default").on(t.isDefault).where(sql`${t.isDefault} = true`),
    check("plans_interval_check", sql`${t.billingInterval} in ('month', 'year')`),
    check("plans_price_check", sql`${t.priceMinor} >= 0`),
  ],
);

export const planEntitlements = pgTable(
  "plan_entitlements",
  {
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    featureKey: text("feature_key").notNull(),
    value: jsonb("value").$type<EntitlementValue>(),
  },
  (t) => [primaryKey({ columns: [t.planId, t.featureKey] })],
);

/**
 * Per-organization overrides set by platform administrators
 * (e.g. enabling Google Drive for a specific free organization).
 */
export const organizationEntitlementOverrides = pgTable(
  "organization_entitlement_overrides",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    featureKey: text("feature_key").notNull(),
    value: jsonb("value").$type<EntitlementValue>(),
    reason: text("reason").notNull(),
    setByUserId: uuid("set_by_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.featureKey] })],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    status: text("status").notNull(),
    currentPeriodStart: ts("current_period_start").notNull().defaultNow(),
    currentPeriodEnd: ts("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /** manual | stripe | paddle | pesapal ... (payment integration arrives in a later milestone). */
    provider: text("provider").notNull().default("manual"),
    providerReference: text("provider_reference"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("subscriptions_org_idx").on(t.organizationId),
    // At most one live subscription per organization.
    uniqueIndex("subscriptions_one_live_per_org")
      .on(t.organizationId)
      .where(sql`${t.status} in ('active', 'trialing', 'past_due')`),
    check(
      "subscriptions_status_check",
      sql`${t.status} in ('active', 'trialing', 'past_due', 'canceled', 'expired')`,
    ),
  ],
);
