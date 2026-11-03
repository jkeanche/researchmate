import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { documents, documentExports, documentVersions } from "./documents";
import { users } from "./identity";
import { researchProjects } from "./research";
import { organizations } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const projectRef = () =>
  uuid("project_id")
    .notNull()
    .references(() => researchProjects.id, { onDelete: "cascade" });

export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;

/**
 * Email invitations for people who may not have an account yet. Only a hash
 * of the token is stored; the invitation can only be accepted by an account
 * with the invited email address.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => researchProjects.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    orgRoleKey: text("org_role_key").notNull(),
    projectRoleKey: text("project_role_key"),
    /** For supervisors: primary, co-supervisor or examiner. */
    supervisorKind: text("supervisor_kind"),
    tokenHash: text("token_hash").notNull(),
    message: text("message").notNull().default(""),
    status: text("status").notNull().default("pending"),
    invitedByUserId: userRef("invited_by_user_id"),
    acceptedByUserId: userRef("accepted_by_user_id"),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invitations_token_idx").on(t.tokenHash),
    index("invitations_org_idx").on(t.organizationId, t.status),
    // One open invitation per person and project (or organization).
    uniqueIndex("invitations_pending_idx").on(t.organizationId, sql`coalesce(${t.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.email).where(sql`${t.status} = 'pending'`),
    check("invitations_status_check", sql`${t.status} in (${inList(INVITATION_STATUSES)})`),
    check("invitations_email_check", sql`${t.email} = lower(${t.email}) and position('@' in ${t.email}) > 1`),
  ],
);

export const SUPERVISOR_KINDS = ["primary", "co_supervisor", "examiner"] as const;

export const supervisorAssignments = pgTable(
  "supervisor_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("primary"),
    assignedByUserId: userRef("assigned_by_user_id"),
    endedAt: ts("ended_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("supervisor_assignments_active_idx").on(t.projectId, t.userId).where(sql`${t.endedAt} is null`), check("supervisor_assignments_kind_check", sql`${t.kind} in (${inList(SUPERVISOR_KINDS)})`)],
);

export const REVIEW_STATUSES = ["submitted", "in_review", "changes_requested", "approved", "withdrawn"] as const;

/** A document version submitted to supervisors (the blueprint's "document submissions"). */
export const reviewRequests = pgTable(
  "review_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    exportId: uuid("export_id").references(() => documentExports.id, { onDelete: "set null" }),
    /** The previous request for the same document, when this is a resubmission. */
    previousRequestId: uuid("previous_request_id"),
    round: integer("round").notNull().default(1),
    submittedByUserId: userRef("submitted_by_user_id"),
    /** A specific supervisor, or null for any supervisor on the project. */
    reviewerUserId: userRef("reviewer_user_id"),
    message: text("message").notNull().default(""),
    dueDate: date("due_date"),
    status: text("status").notNull().default("submitted"),
    decidedByUserId: userRef("decided_by_user_id"),
    decisionNote: text("decision_note").notNull().default(""),
    startedAt: ts("started_at"),
    decidedAt: ts("decided_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("review_requests_project_idx").on(t.projectId, t.status),
    index("review_requests_reviewer_idx").on(t.reviewerUserId, t.status),
    check("review_requests_status_check", sql`${t.status} in (${inList(REVIEW_STATUSES)})`),
    // A decision is always a person's, and never the submitter's own.
    check("review_requests_decision_check", sql`(${t.status} not in ('approved', 'changes_requested')) or (${t.decidedByUserId} is not null and ${t.decidedAt} is not null)`),
    check("review_requests_not_self_check", sql`${t.decidedByUserId} is distinct from ${t.submittedByUserId} or ${t.decidedByUserId} is null`),
  ],
);

/** A supervisor's written feedback on a review request (one or more per request). */
export const supervisorFeedback = pgTable(
  "supervisor_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    reviewRequestId: uuid("review_request_id")
      .notNull()
      .references(() => reviewRequests.id, { onDelete: "cascade" }),
    authorUserId: userRef("author_user_id"),
    summary: text("summary").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("supervisor_feedback_author_idx").on(t.reviewRequestId, t.authorUserId)],
);

export const FEEDBACK_SEVERITIES = ["minor", "major", "critical"] as const;

export const supervisorFeedbackComments = pgTable(
  "supervisor_feedback_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feedbackId: uuid("feedback_id")
      .notNull()
      .references(() => supervisorFeedback.id, { onDelete: "cascade" }),
    /** Section key in the submitted version's snapshot. */
    sectionKey: text("section_key"),
    sectionTitle: text("section_title").notNull().default(""),
    quote: text("quote").notNull().default(""),
    body: text("body").notNull(),
    severity: text("severity").notNull().default("minor"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("supervisor_feedback_comments_idx").on(t.feedbackId), check("supervisor_feedback_comments_severity_check", sql`${t.severity} in (${inList(FEEDBACK_SEVERITIES)})`), check("supervisor_feedback_comments_body_size", sql`length(${t.body}) between 1 and 5000`)],
);

export const REVISION_STATUSES = ["open", "addressed", "verified", "reopened", "declined"] as const;

/**
 * Work arising from feedback. The researcher marks a task addressed with a
 * response; only a supervisor verifies it (or reopens it).
 */
export const revisionTasks = pgTable(
  "revision_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    reviewRequestId: uuid("review_request_id").references(() => reviewRequests.id, { onDelete: "set null" }),
    feedbackCommentId: uuid("feedback_comment_id").references(() => supervisorFeedbackComments.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    sectionKey: text("section_key"),
    status: text("status").notNull().default("open"),
    assigneeUserId: userRef("assignee_user_id"),
    dueDate: date("due_date"),
    response: text("response").notNull().default(""),
    /** "ai" when created from an accepted Supervisor Feedback Agent suggestion. */
    source: text("source").notNull().default("manual"),
    createdByUserId: userRef("created_by_user_id"),
    addressedAt: ts("addressed_at"),
    verifiedByUserId: userRef("verified_by_user_id"),
    verifiedAt: ts("verified_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("revision_tasks_project_idx").on(t.projectId, t.status),
    check("revision_tasks_status_check", sql`${t.status} in (${inList(REVISION_STATUSES)})`),
    check("revision_tasks_source_check", sql`${t.source} in ('manual', 'ai')`),
  ],
);
