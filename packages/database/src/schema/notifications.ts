import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { researchProjects } from "./research";
import { organizations } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** In-app and email notifications (§30). One row per recipient. */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => researchProjects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** In-app path, always starting with /app/. */
    link: text("link"),
    /** Stops repeats, e.g. one overdue notice per task and due date. */
    dedupeKey: text("dedupe_key"),
    inApp: boolean("in_app").notNull().default(true),
    readAt: ts("read_at"),
    emailStatus: text("email_status").notNull().default("none"),
    emailedAt: ts("emailed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.createdAt),
    index("notifications_email_pending_idx").on(t.createdAt).where(sql`${t.emailStatus} = 'pending'`),
    uniqueIndex("notifications_dedupe_idx").on(t.userId, t.dedupeKey),
    check("notifications_email_status_check", sql`${t.emailStatus} in ('none', 'pending', 'sent', 'skipped', 'failed')`),
    check("notifications_link_check", sql`${t.link} is null or ${t.link} like '/app/%'`),
  ],
);

/** Per-user overrides of the catalogue defaults. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    inApp: boolean("in_app").notNull(),
    email: boolean("email").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);
