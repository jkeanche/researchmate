import { sql, type SQL } from "drizzle-orm";
import { check, customType, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { files } from "./files";
import { users } from "./identity";
import { researchQuestions } from "./planning";
import { researchProjects } from "./research";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const projectRef = () =>
  uuid("project_id")
    .notNull()
    .references(() => researchProjects.id, { onDelete: "cascade" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * Verification is a ladder; the platform never claims more than it has done:
 *   unverified → metadata_retrieved → metadata_verified → full_text_retrieved → full_text_reviewed
 * or verification_failed.
 */
export const VERIFICATION_STATUSES = ["unverified", "metadata_retrieved", "metadata_verified", "full_text_retrieved", "full_text_reviewed", "verification_failed"] as const;
/** What content we actually hold: bibliographic metadata, an abstract, or the full text. */
export const ACCESS_LEVELS = ["metadata", "abstract", "full_text"] as const;

export const references = pgTable(
  "references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    /** Used in documents as [@key]. Unique per project. */
    citationKey: text("citation_key").notNull(),
    /** CSL-JSON item (without id). */
    csl: jsonb("csl").$type<Record<string, unknown>>().notNull(),
    title: text("title").notNull(),
    year: integer("year"),
    firstAuthor: text("first_author"),
    doi: text("doi"),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    accessLevel: text("access_level").notNull().default("metadata"),
    sourceProvider: text("source_provider").notNull().default("manual"),
    externalIds: jsonb("external_ids").$type<Record<string, string>>().notNull().default({}),
    retrievedAt: ts("retrieved_at"),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    search: tsvector("search").generatedAlwaysAs((): SQL => sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(first_author, '') || ' ' || coalesce(csl->>'abstract', ''))`),
  },
  (t) => [
    uniqueIndex("references_key_idx").on(t.projectId, t.citationKey),
    uniqueIndex("references_doi_idx").on(t.projectId, t.doi).where(sql`${t.doi} is not null`),
    index("references_search_idx").using("gin", t.search),
    check("references_verification_check", sql`${t.verificationStatus} in (${inList(VERIFICATION_STATUSES)})`),
    check("references_access_check", sql`${t.accessLevel} in (${inList(ACCESS_LEVELS)})`),
    check("references_key_check", sql`${t.citationKey} ~ '^[A-Za-z0-9][A-Za-z0-9_:.-]{0,80}$'`),
  ],
);

export const sourceVerificationEvents = pgTable(
  "source_verification_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referenceId: uuid("reference_id")
      .notNull()
      .references(() => references.id, { onDelete: "cascade" }),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    method: text("method").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    actorUserId: userRef("actor_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("source_verification_events_ref_idx").on(t.referenceId, t.createdAt)],
);

export const researchThemes = pgTable(
  "research_themes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("research_themes_name_idx").on(t.projectId, t.name)],
);

/** A passage of evidence, traceable to its source, page and the claim it supports. */
export const evidenceRecords = pgTable(
  "evidence_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    referenceId: uuid("reference_id").references(() => references.id, { onDelete: "set null" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    page: integer("page"),
    passage: text("passage").notNull(),
    claim: text("claim").notNull().default(""),
    researchQuestionId: uuid("research_question_id").references(() => researchQuestions.id, { onDelete: "set null" }),
    themeId: uuid("theme_id").references(() => researchThemes.id, { onDelete: "set null" }),
    extractionMethod: text("extraction_method").notNull().default("manual"),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    reviewStatus: text("review_status").notNull().default("accepted"),
    notes: text("notes").notNull().default(""),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("evidence_records_project_idx").on(t.projectId),
    index("evidence_records_reference_idx").on(t.referenceId),
    check("evidence_records_method_check", sql`${t.extractionMethod} in ('manual', 'ai')`),
    check("evidence_records_verification_check", sql`${t.verificationStatus} in ('unverified', 'verified', 'disputed')`),
    check("evidence_records_review_check", sql`${t.reviewStatus} in ('pending', 'accepted', 'rejected')`),
    check("evidence_records_page_check", sql`${t.page} is null or ${t.page} > 0`),
  ],
);

/** One row per reference in the literature matrix (§10.6). `basis` records what the entry was written from. */
export const literatureMatrixEntries = pgTable(
  "literature_matrix_entries",
  {
    referenceId: uuid("reference_id")
      .primaryKey()
      .references(() => references.id, { onDelete: "cascade" }),
    projectId: projectRef(),
    objective: text("objective").notNull().default(""),
    methodology: text("methodology").notNull().default(""),
    population: text("population").notNull().default(""),
    findings: text("findings").notNull().default(""),
    limitations: text("limitations").notNull().default(""),
    researchGap: text("research_gap").notNull().default(""),
    themeIds: jsonb("theme_ids").$type<string[]>().notNull().default([]),
    basis: text("basis").notNull().default("metadata"),
    source: text("source").notNull().default("manual"),
    updatedByUserId: userRef("updated_by_user_id"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("literature_matrix_entries_project_idx").on(t.projectId), check("literature_matrix_basis_check", sql`${t.basis} in ('metadata', 'abstract', 'full_text')`), check("literature_matrix_source_check", sql`${t.source} in ('manual', 'ai')`)],
);

/** Extracted text, page by page, for search and evidence. */
export const filePassages = pgTable(
  "file_passages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    fileVersion: integer("file_version").notNull(),
    page: integer("page"),
    seq: smallint("seq").notNull().default(0),
    text: text("text").notNull(),
    method: text("method").notNull().default("text"),
    search: tsvector("search").generatedAlwaysAs((): SQL => sql`to_tsvector('english', text)`),
  },
  (t) => [index("file_passages_file_idx").on(t.fileId, t.fileVersion, t.page), index("file_passages_search_idx").using("gin", t.search), check("file_passages_method_check", sql`${t.method} in ('text', 'ocr')`)],
);
