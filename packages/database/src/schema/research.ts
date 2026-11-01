import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { organizations, roles } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const RESEARCH_TYPES = [
  "undergraduate_project",
  "masters_thesis",
  "phd_dissertation",
  "journal_article",
  "conference_paper",
  "research_proposal",
  "scientific_paper",
  "institutional_research",
  "business_research",
  "technical_report",
  "independent_research",
  "custom",
] as const;

export const PROJECT_STATUSES = ["draft", "active", "on_hold", "completed", "archived"] as const;

export const CITATION_STYLES = ["apa7", "harvard", "mla", "chicago", "ieee", "vancouver", "custom"] as const;

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const researchProjects = pgTable(
  "research_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    researchType: text("research_type").notNull(),
    academicLevel: text("academic_level"),
    discipline: text("discipline"),
    institution: text("institution"),
    department: text("department"),
    methodology: text("methodology"),
    citationStyle: text("citation_style").notNull().default("apa7"),
    targetWordCount: integer("target_word_count"),
    targetPageCount: integer("target_page_count"),
    startDate: date("start_date", { mode: "string" }),
    expectedCompletionDate: date("expected_completion_date", { mode: "string" }),
    status: text("status").notNull().default("draft"),
    progressPercent: smallint("progress_percent").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    archivedAt: ts("archived_at"),
  },
  (t) => [
    index("research_projects_org_idx").on(t.organizationId),
    check("research_projects_type_check", sql`${t.researchType} in (${inList(RESEARCH_TYPES)})`),
    check("research_projects_status_check", sql`${t.status} in (${inList(PROJECT_STATUSES)})`),
    check("research_projects_citation_check", sql`${t.citationStyle} in (${inList(CITATION_STYLES)})`),
    check("research_projects_progress_check", sql`${t.progressPercent} between 0 and 100`),
    check(
      "research_projects_dates_check",
      sql`${t.expectedCompletionDate} is null or ${t.startDate} is null or ${t.expectedCompletionDate} >= ${t.startDate}`,
    ),
    check("research_projects_targets_check", sql`coalesce(${t.targetWordCount}, 0) >= 0 and coalesce(${t.targetPageCount}, 0) >= 0`),
  ],
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => researchProjects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleKey: text("role_key")
      .notNull()
      .references(() => roles.key),
    addedAt: ts("added_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index("project_members_user_idx").on(t.userId)],
);
