import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { organizations } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

const inList = (xs: readonly string[]) => sql.raw(xs.map((x) => `'${x}'`).join(", "));

export const SUPPORT_CATEGORIES = ["general", "sales", "billing", "technical", "account", "feedback"] as const;
export const SUPPORT_STATUSES = ["open", "pending", "resolved", "closed"] as const;
export const SUPPORT_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/**
 * Enquiries and support requests (§27 support_tickets), from the public
 * contact form or from signed-in users. Guests follow their enquiry through a
 * private link signed with the app secret (nothing to store or leak).
 *
 * Status: open (waiting for us) → pending (waiting for the requester) →
 * resolved / closed. A requester reply re-opens it.
 */
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Short reference quoted in emails, e.g. RM-7K3Q9P. */
    reference: text("reference").notNull(),
    requesterName: text("requester_name").notNull(),
    /** Lower-cased. */
    requesterEmail: text("requester_email").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    category: text("category").notNull().default("general"),
    subject: text("subject").notNull(),
    status: text("status").notNull().default("open"),
    priority: text("priority").notNull().default("normal"),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source").notNull(),
    lastMessageAt: ts("last_message_at").notNull().defaultNow(),
    closedAt: ts("closed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("support_tickets_reference_idx").on(t.reference),
    index("support_tickets_status_idx").on(t.status, t.lastMessageAt),
    index("support_tickets_user_idx").on(t.userId, t.createdAt),
    index("support_tickets_email_idx").on(t.requesterEmail),
    index("support_tickets_org_idx").on(t.organizationId),
    index("support_tickets_assignee_idx").on(t.assignedToUserId),
    check("support_tickets_category_check", sql`${t.category} in (${inList(SUPPORT_CATEGORIES)})`),
    check("support_tickets_status_check", sql`${t.status} in (${inList(SUPPORT_STATUSES)})`),
    check("support_tickets_priority_check", sql`${t.priority} in (${inList(SUPPORT_PRIORITIES)})`),
    check("support_tickets_source_check", sql`${t.source} in ('contact_form', 'in_app')`),
    check("support_tickets_email_lowercase", sql`${t.requesterEmail} = lower(${t.requesterEmail})`),
  ],
);

/** Conversation on an enquiry. Notes are internal and never shown to the requester. */
export const supportTicketMessages = pgTable(
  "support_ticket_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    authorType: text("author_type").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("support_messages_ticket_idx").on(t.ticketId, t.createdAt),
    index("support_messages_author_idx").on(t.authorUserId),
    check("support_messages_author_type_check", sql`${t.authorType} in ('requester', 'staff', 'note')`),
    check("support_messages_body_check", sql`length(${t.body}) between 1 and 20000`),
  ],
);
