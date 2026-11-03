import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** personal = auto-created workspace for one researcher; team = shared organization. */
    kind: text("kind").notNull().default("team"),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /** Scheduled deletion: inaccessible from deletedAt, purged after purgeAfter (restorable until then). */
    deletedAt: ts("deleted_at"),
    purgeAfter: ts("purge_after"),
    /** Set by the purge job; lets append-only guards permit deleting this organization's rows. */
    purgeStartedAt: ts("purge_started_at"),
  },
  (t) => [
    uniqueIndex("organizations_slug_unique").on(t.slug),
    index("organizations_owner_idx").on(t.ownerUserId),
    check("organizations_kind_check", sql`${t.kind} in ('personal', 'team')`),
  ],
);

/** Role catalogue (data-driven; seeded). scope = organization | project. */
export const roles = pgTable(
  "roles",
  {
    key: text("key").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    scope: text("scope").notNull(),
    /** Higher rank = more privileged; used to prevent members granting roles above their own. */
    rank: integer("rank").notNull().default(0),
  },
  (t) => [check("roles_scope_check", sql`${t.scope} in ('organization', 'project', 'both')`)],
);

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
  /** Grouping used by the admin UI; finance permissions are their own domain. */
  domain: text("domain").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleKey: text("role_key")
      .notNull()
      .references(() => roles.key, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleKey: text("role_key")
      .notNull()
      .references(() => roles.key),
    joinedAt: ts("joined_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index("organization_members_user_idx").on(t.userId),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_org_idx").on(t.organizationId, t.createdAt),
    index("audit_logs_target_idx").on(t.targetType, t.targetId),
  ],
);

/**
 * Financial records kept after an organization is purged (invoices, payments,
 * ledger), because tax and accounting rules may require them for years after
 * the research content is gone. No foreign keys: the organization row is deleted.
 */
export const retainedFinancialRecords = pgTable("retained_financial_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  organizationName: text("organization_name").notNull(),
  deletedAt: ts("deleted_at"),
  purgedAt: ts("purged_at").notNull().defaultNow(),
  invoices: jsonb("invoices").$type<unknown[]>().notNull(),
  payments: jsonb("payments").$type<unknown[]>().notNull(),
  ledger: jsonb("ledger").$type<unknown[]>().notNull(),
});
