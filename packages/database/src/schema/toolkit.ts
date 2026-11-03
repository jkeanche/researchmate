import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { files } from "./files";
import { users } from "./identity";
import { researchProjects } from "./research";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const projectRef = () =>
  uuid("project_id")
    .notNull()
    .references(() => researchProjects.id, { onDelete: "cascade" });

export interface DatasetColumn {
  name: string;
  type: "numeric" | "categorical" | "text" | "date";
  label: string;
  missing: number;
  /** Optional value labels for coded variables, e.g. {"1": "Strongly disagree"}. */
  valueLabels?: Record<string, string>;
}

/** A parsed table (CSV/XLSX) kept with the file it came from, for reproducible analysis. */
export const datasets = pgTable(
  "datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    name: text("name").notNull(),
    sourceFileId: uuid("source_file_id").references(() => files.id, { onDelete: "set null" }),
    sourceFileVersion: integer("source_file_version"),
    sheet: text("sheet"),
    columns: jsonb("columns").$type<DatasetColumn[]>().notNull(),
    /** Rows as arrays aligned with columns; null = missing. */
    rows: jsonb("rows").$type<(string | number | null)[][]>().notNull(),
    rowCount: integer("row_count").notNull(),
    /** Cleaning steps applied in order (reproducible from the source). */
    steps: jsonb("steps").$type<Record<string, unknown>[]>().notNull().default([]),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("datasets_project_idx").on(t.projectId), check("datasets_rows_check", sql`${t.rowCount} between 0 and 100000`)],
);

/** A saved analysis: its specification, the method used, assumptions and the computed result. */
export const analyses = pgTable(
  "analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    method: text("method").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    notes: text("notes").notNull().default(""),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("analyses_project_idx").on(t.projectId, t.createdAt), check("analyses_kind_check", sql`${t.kind} in ('missing', 'descriptives', 'frequencies', 'crosstab', 'correlation', 'regression', 'ttest', 'anova')`)],
);

/** Mermaid diagrams (conceptual frameworks, flowcharts, ER, mind maps…), versioned by revision. */
export const diagrams = pgTable(
  "diagrams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedByUserId: userRef("updated_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("diagrams_project_idx").on(t.projectId), check("diagrams_source_size", sql`length(${t.source}) <= 50000`)],
);

export interface SurveyQuestion {
  id: string;
  type: "single" | "multiple" | "likert" | "open" | "number";
  text: string;
  required: boolean;
  options?: string[];
  /** Likert: number of points and anchor labels. */
  scale?: { points: number; low: string; high: string };
  section?: string;
}

/** Questionnaires (design and export; responses are collected outside ResearchMate for now). */
export const surveys = pgTable(
  "surveys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectRef(),
    title: text("title").notNull(),
    introduction: text("introduction").notNull().default(""),
    consent: text("consent").notNull().default(""),
    questions: jsonb("questions").$type<SurveyQuestion[]>().notNull().default([]),
    revision: integer("revision").notNull().default(1),
    updatedByUserId: userRef("updated_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("surveys_project_idx").on(t.projectId)],
);
