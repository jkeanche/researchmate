import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { evidenceRecords, references } from "./literature";
import { researchProjects } from "./research";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const projectRef = () =>
  uuid("project_id")
    .notNull()
    .references(() => researchProjects.id, { onDelete: "cascade" });

export const DOCUMENT_TYPES = ["undergraduate_project", "masters_dissertation", "phd_thesis", "journal_article", "conference_paper", "proposal", "report", "custom"] as const;
/**
 * title/toc/references are generated; front = preliminary pages (roman
 * numbering, unnumbered headings); body = numbered chapters; appendix =
 * lettered appendices.
 */
export const SECTION_KINDS = ["title", "front", "toc", "body", "references", "appendix"] as const;
export const DOCUMENT_STATUSES = ["draft", "in_review", "final"] as const;

/** Catalogue of versioned templates. A (key, version) row is never edited; changes ship as a new version. */
export const documentTemplates = pgTable(
  "document_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    documentType: text("document_type").notNull(),
    description: text("description").notNull().default(""),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("document_templates_key_version_idx").on(t.key, t.version), check("document_templates_type_check", sql`${t.documentType} in (${inList(DOCUMENT_TYPES)})`)],
);

/** A project document (the blueprint's document_artifacts). Its current specification is the latest specification version. */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    title: text("title").notNull(),
    documentType: text("document_type").notNull(),
    templateKey: text("template_key"),
    templateVersion: integer("template_version"),
    status: text("status").notNull().default("draft"),
    specVersion: integer("spec_version").notNull().default(1),
    /** Title-page details: author, institution, degree, supervisor, date… */
    meta: jsonb("meta").$type<Record<string, string>>().notNull().default({}),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("documents_project_idx").on(t.projectId),
    check("documents_type_check", sql`${t.documentType} in (${inList(DOCUMENT_TYPES)})`),
    check("documents_status_check", sql`${t.status} in (${inList(DOCUMENT_STATUSES)})`),
  ],
);

/** Append-only history of a document's specification (the blueprint's document_specification_versions). */
export const documentSpecificationVersions = pgTable(
  "document_specification_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    note: text("note").notNull().default(""),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("document_spec_versions_idx").on(t.documentId, t.version)],
);

export const documentSections = pgTable(
  "document_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    required: boolean("required").notNull().default(false),
    sortOrder: integer("sort_order").notNull(),
    /** Section text in ResearchMate markup (see packages/documents/src/markup.ts). */
    content: text("content").notNull().default(""),
    wordLimit: integer("word_limit"),
    guidance: text("guidance").notNull().default(""),
    /** Optimistic concurrency for the editor. */
    version: integer("version").notNull().default(1),
    updatedByUserId: userRef("updated_by_user_id"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("document_sections_key_idx").on(t.documentId, t.key),
    index("document_sections_order_idx").on(t.documentId, t.sortOrder),
    check("document_sections_kind_check", sql`${t.kind} in (${inList(SECTION_KINDS)})`),
    check("document_sections_content_size", sql`length(${t.content}) <= 400000`),
  ],
);

/** Named snapshots of all sections; append-only. Exports always record the snapshot they were built from. */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    label: text("label").notNull().default(""),
    specVersion: integer("spec_version").notNull(),
    snapshot: jsonb("snapshot").$type<{ sections: { key: string; title: string; kind: string; content: string }[]; meta: Record<string, string>; title: string }>().notNull(),
    wordCount: integer("word_count").notNull().default(0),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("document_versions_number_idx").on(t.documentId, t.number)],
);

/** Index of [@key] citations, rebuilt whenever a section is saved. reference_id is null for keys not in the library. */
export const documentCitations = pgTable(
  "document_citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => documentSections.id, { onDelete: "cascade" }),
    referenceId: uuid("reference_id").references(() => references.id, { onDelete: "no action" }),
    citationKey: text("citation_key").notNull(),
    locator: text("locator"),
    ordinal: integer("ordinal").notNull(),
  },
  (t) => [index("document_citations_doc_idx").on(t.documentId), index("document_citations_ref_idx").on(t.referenceId)],
);

/** Evidence the writer linked to a section (traceability from claims to sources). */
export const documentSectionEvidence = pgTable(
  "document_section_evidence",
  {
    sectionId: uuid("section_id")
      .notNull()
      .references(() => documentSections.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidenceRecords.id, { onDelete: "cascade" }),
    linkedByUserId: userRef("linked_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sectionId, t.evidenceId] })],
);

export const documentComments = pgTable(
  "document_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id").references(() => documentSections.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    /** The text the comment refers to, copied when the comment was made. */
    quote: text("quote").notNull().default(""),
    body: text("body").notNull(),
    authorUserId: userRef("author_user_id"),
    resolvedAt: ts("resolved_at"),
    resolvedByUserId: userRef("resolved_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("document_comments_doc_idx").on(t.documentId, t.createdAt), check("document_comments_body_size", sql`length(${t.body}) between 1 and 5000`)],
);

export const EXPORT_FORMATS = ["docx", "pdf"] as const;
export const EXPORT_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

export const documentExports = pgTable(
  "document_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    status: text("status").notNull().default("queued"),
    storageKey: text("storage_key"),
    sizeBytes: integer("size_bytes"),
    pageCount: integer("page_count"),
    error: text("error"),
    requestedByUserId: userRef("requested_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("document_exports_doc_idx").on(t.documentId, t.createdAt),
    check("document_exports_format_check", sql`${t.format} in (${inList(EXPORT_FORMATS)})`),
    check("document_exports_status_check", sql`${t.status} in (${inList(EXPORT_STATUSES)})`),
  ],
);

export interface ValidationCheck {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export const documentValidationResults = pgTable(
  "document_validation_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exportId: uuid("export_id")
      .notNull()
      .references(() => documentExports.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    passed: boolean("passed").notNull(),
    checks: jsonb("checks").$type<ValidationCheck[]>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("document_validation_export_idx").on(t.exportId)],
);
