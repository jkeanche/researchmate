import { analyses, type Database, datasets, type DatasetColumn, diagrams, files, fileVersions, projectRisks, projectStages, references, researchObjectives, researchProjects, researchQuestions, researchTasks, reviewRequests, surveys, type SurveyQuestion } from "@researchmate/database";
import { getEntitlements, tierOf } from "@researchmate/entitlements";
import { assertProjectWritable } from "@researchmate/research";
import { AppError } from "@researchmate/shared";
import type { StorageDriver } from "@researchmate/storage";
import { getProjectAccess, recordAudit } from "@researchmate/tenancy";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import Papa from "papaparse";
import { z } from "zod";
import { anova, type Cell, correlation, crosstab, describe, frequencies, METHODS, regression, ttest } from "./stats";

const MAX_ROWS = 100_000;
const MAX_COLS = 200;
const MAX_BYTES = 20 * 1024 * 1024;
const BASIC_ANALYSES = new Set(["missing", "descriptives", "frequencies", "crosstab"]);

export const DIAGRAM_TEMPLATES: Record<string, { title: string; source: string }> = {
  conceptual: { title: "Conceptual framework", source: "flowchart LR\n  IV[Independent variable] --> DV[Dependent variable]\n  MV[Moderator] -.-> DV\n  CV[Control variables] --> DV" },
  methodology: { title: "Methodology flowchart", source: "flowchart TD\n  A[Literature review] --> B[Research design]\n  B --> C[Sampling]\n  C --> D[Data collection]\n  D --> E[Data analysis]\n  E --> F[Findings and discussion]" },
  theory_of_change: { title: "Theory of change", source: "flowchart LR\n  I[Inputs] --> A[Activities] --> O[Outputs] --> OC[Outcomes] --> IM[Impact]\n  AS([Assumptions]) -.-> OC" },
  er: { title: "Entity relationship model", source: "erDiagram\n  HOUSEHOLD ||--o{ MEMBER : has\n  HOUSEHOLD ||--o{ TRANSACTION : makes\n  HOUSEHOLD {\n    string id\n    string county\n  }" },
  mindmap: { title: "Mind map", source: "mindmap\n  root((Research topic))\n    Theme A\n      Sub-theme\n    Theme B\n    Theme C" },
  logic_model: { title: "Logic model", source: "flowchart LR\n  subgraph Plan\n    R[Resources] --> AC[Activities]\n  end\n  subgraph Results\n    OP[Outputs] --> SO[Short-term outcomes] --> LO[Long-term outcomes]\n  end\n  AC --> OP" },
  decision_tree: { title: "Decision tree", source: "flowchart TD\n  Q1{Is the data normally distributed?} -->|Yes| T[t-test]\n  Q1 -->|No| M[Mann-Whitney U]" },
  org_chart: { title: "Organizational chart", source: "flowchart TD\n  PI[Principal investigator] --> RA1[Research assistant]\n  PI --> RA2[Research assistant]\n  PI --> S[Statistician]" },
};

const questionSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/, "Question ids start with a letter and use letters, digits and underscores."),
  type: z.enum(["single", "multiple", "likert", "open", "number"]),
  text: z.string().trim().min(3).max(1000),
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  scale: z.object({ points: z.number().int().min(3).max(11), low: z.string().max(80), high: z.string().max(80) }).optional(),
  section: z.string().max(200).optional(),
});

export const LIKERT_TEMPLATES: Record<string, { points: number; low: string; high: string }> = {
  agreement5: { points: 5, low: "Strongly disagree", high: "Strongly agree" },
  agreement7: { points: 7, low: "Strongly disagree", high: "Strongly agree" },
  frequency5: { points: 5, low: "Never", high: "Always" },
  satisfaction5: { points: 5, low: "Very dissatisfied", high: "Very satisfied" },
};

function inferColumns(header: string[], rows: Cell[][]): DatasetColumn[] {
  return header.map((name, j) => {
    const vals = rows.map((r) => r[j]).filter((v) => v !== null && v !== "");
    const numeric = vals.length > 0 && vals.every((v) => typeof v === "number");
    const distinct = new Set(vals.map(String)).size;
    const type: DatasetColumn["type"] = numeric ? "numeric" : distinct <= Math.max(20, vals.length * 0.05) ? "categorical" : "text";
    return { name, type, label: name, missing: rows.length - vals.length };
  });
}

const toCell = (v: unknown): Cell => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && v && "result" in v) return toCell((v as { result: unknown }).result);
  if (typeof v === "object" && v && "text" in v) return toCell((v as { text: unknown }).text);
  const s = String(v).trim();
  if (s === "" || /^(na|n\/a|null|nan|#n\/a)$/i.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return /^-?[\d,]*\.?\d+(e-?\d+)?$/i.test(s) && Number.isFinite(n) ? n : s;
};

/**
 * Research toolkit (§10): datasets and deterministic statistics, Mermaid
 * diagrams, questionnaires, and generated presentations/reports. Basic tier:
 * datasets, descriptive analyses, diagrams, surveys. Advanced tier adds
 * inferential statistics and generated slides/reports.
 */
export class ToolkitService {
  constructor(
    private readonly db: Database,
    private readonly deps: { driver?: StorageDriver } = {},
  ) {}

  async access(actorUserId: string, projectId: string, need: "read" | "write", minTier: "basic" | "advanced" = "basic") {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    const ent = await getEntitlements(this.db, access.organizationId);
    const tier = tierOf(ent, "toolkit");
    if (need === "write") {
      if (!access.permissions.has("project.update")) throw new AppError("FORBIDDEN", "You need edit access to the project.");
      await assertProjectWritable(this.db, projectId);
      if (tier === "none" || (minTier === "advanced" && tier !== "advanced")) throw new AppError("FEATURE_NOT_ENTITLED", `${minTier === "advanced" ? "Advanced research tools are" : "The research toolkit is"} not included in the ${ent.planName} plan.`, { feature: "toolkit" });
    }
    return { access, tier, planName: ent.planName };
  }

  // ----- Datasets ----------------------------------------------------------

  /** Imports a CSV or XLSX project file into a dataset (first row = variable names). */
  async importDataset(actorUserId: string, projectId: string, input: { fileId: string; name?: string; sheet?: string }) {
    const { access } = await this.access(actorUserId, projectId, "write");
    if (!access.permissions.has("project.files.read")) throw new AppError("FORBIDDEN", "You need access to the project's files.");
    const [f] = await this.db.select({ f: files, v: fileVersions }).from(files).innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion))).where(and(eq(files.id, input.fileId), isNull(files.deletedAt)));
    if (!f || f.f.projectId !== projectId) throw new AppError("VALIDATION", "Choose a file from this project.");
    if (Number(f.v.sizeBytes) > MAX_BYTES) throw new AppError("VALIDATION", "Datasets can be up to 20 MB.");
    const isCsv = f.f.mimeType === "text/csv" || /\.csv$/i.test(f.f.originalName);
    const isXlsx = f.f.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (!isCsv && !isXlsx) throw new AppError("VALIDATION", "Import a CSV or XLSX file.");
    const chunks: Buffer[] = [];
    for await (const c of await this.deps.driver!.get(f.v.storageKey)) chunks.push(Buffer.from(c as Buffer));
    const buf = Buffer.concat(chunks);
    let table: unknown[][];
    let sheet: string | null = null;
    if (isCsv) {
      const parsed = Papa.parse<string[]>(buf.toString("utf8").replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
      table = parsed.data;
    } else {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as never);
      const ws = input.sheet ? wb.getWorksheet(input.sheet) : wb.worksheets[0];
      if (!ws) throw new AppError("VALIDATION", "Sheet not found.");
      sheet = ws.name;
      table = [];
      ws.eachRow({ includeEmpty: false }, (row) => table.push((row.values as unknown[]).slice(1)));
    }
    if (table.length < 2) throw new AppError("VALIDATION", "The file needs a header row and at least one data row.");
    const header = (table[0] as unknown[]).map((h, j) => String(h ?? "").trim() || `V${j + 1}`).slice(0, MAX_COLS);
    const seen = new Set<string>();
    const names = header.map((h) => {
      let n = h.slice(0, 64);
      for (let k = 2; seen.has(n); k++) n = `${h.slice(0, 60)}_${k}`;
      seen.add(n);
      return n;
    });
    if (table.length - 1 > MAX_ROWS) throw new AppError("VALIDATION", `Datasets can have up to ${MAX_ROWS.toLocaleString("en")} rows.`);
    const rows = table.slice(1).map((r) => names.map((_, j) => toCell((r as unknown[])[j])));
    const columns = inferColumns(names, rows);
    const [row] = await this.db.insert(datasets).values({ projectId, name: (input.name || f.f.originalName).slice(0, 200), sourceFileId: f.f.id, sourceFileVersion: f.f.currentVersion, sheet, columns, rows, rowCount: rows.length, createdByUserId: actorUserId }).returning();
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "dataset.imported", targetType: "project", targetId: projectId, metadata: { datasetId: row!.id, rows: rows.length, columns: columns.length } });
    return row!;
  }

  async listDatasets(actorUserId: string, projectId: string) {
    await this.access(actorUserId, projectId, "read");
    return this.db.select({ id: datasets.id, name: datasets.name, rowCount: datasets.rowCount, columns: datasets.columns, createdAt: datasets.createdAt, sheet: datasets.sheet }).from(datasets).where(eq(datasets.projectId, projectId)).orderBy(desc(datasets.createdAt));
  }

  async dataset(actorUserId: string, datasetId: string) {
    const [d] = await this.db.select().from(datasets).where(eq(datasets.id, datasetId));
    if (!d) throw new AppError("NOT_FOUND", "Dataset not found.");
    await this.access(actorUserId, d.projectId, "read");
    return d;
  }

  /** Variable metadata (label, type, value labels) and simple, recorded cleaning steps. */
  async updateColumn(actorUserId: string, datasetId: string, name: string, patch: { label?: string; type?: DatasetColumn["type"]; valueLabels?: Record<string, string>; missingCodes?: string[] }) {
    const d = await this.dataset(actorUserId, datasetId);
    await this.access(actorUserId, d.projectId, "write");
    const j = d.columns.findIndex((c) => c.name === name);
    if (j < 0) throw new AppError("NOT_FOUND", "Variable not found.");
    const columns = d.columns.map((c) => ({ ...c }));
    const col = columns[j]!;
    // The edit form always sends the type; only a real change is a cleaning step.
    const typeChanged = !!patch.type && patch.type !== col.type;
    const steps = [...d.steps];
    if (patch.label !== undefined) col.label = patch.label.slice(0, 200);
    if (typeChanged) {
      col.type = patch.type!;
      if (patch.type !== "numeric") steps.push({ step: "set_type", variable: name, type: patch.type, at: new Date().toISOString() });
    }
    if (patch.valueLabels) col.valueLabels = patch.valueLabels;
    let rows = d.rows;
    if (patch.missingCodes?.length) {
      const codes = new Set(patch.missingCodes.map((s) => s.trim()).filter(Boolean));
      rows = d.rows.map((r) => r.map((v, k) => (k === j && v !== null && codes.has(String(v)) ? null : v)));
      steps.push({ step: "set_missing", variable: name, codes: [...codes], at: new Date().toISOString() });
    }
    if (typeChanged && patch.type === "numeric") {
      rows = rows.map((r) => r.map((v, k) => (k === j && v !== null && typeof v !== "number" ? (Number.isFinite(Number(v)) ? Number(v) : null) : v)));
      steps.push({ step: "to_numeric", variable: name, at: new Date().toISOString() });
    }
    col.missing = rows.filter((r) => r[j] === null || r[j] === "").length;
    await this.db.update(datasets).set({ columns, rows, steps, updatedAt: new Date() }).where(eq(datasets.id, datasetId));
  }

  private col(d: typeof datasets.$inferSelect, name: unknown, need?: "numeric") {
    const j = d.columns.findIndex((c) => c.name === name);
    if (j < 0) throw new AppError("VALIDATION", `Choose a variable${name ? ` (“${String(name)}” not found)` : ""}.`);
    if (need === "numeric" && d.columns[j]!.type !== "numeric") throw new AppError("VALIDATION", `“${d.columns[j]!.label}” isn't numeric.`);
    return d.rows.map((r) => r[j] ?? null);
  }

  /** Runs and saves an analysis. Calculations are deterministic and the method is recorded with the result. */
  async analyse(actorUserId: string, datasetId: string, kind: string, spec: Record<string, unknown>, notes = "") {
    const d = await this.dataset(actorUserId, datasetId);
    await this.access(actorUserId, d.projectId, "write", BASIC_ANALYSES.has(kind) ? "basic" : "advanced");
    let result: Record<string, unknown>;
    try {
      switch (kind) {
        case "missing":
          result = { rows: d.rowCount, variables: d.columns.map((c, j) => ({ name: c.name, label: c.label, missing: d.rows.filter((r) => r[j] === null || r[j] === "").length })) };
          break;
        case "descriptives":
          result = { variables: ((spec.variables as string[]) ?? []).map((v) => ({ name: v, ...describe(this.col(d, v, "numeric")) })) };
          if (!(result.variables as unknown[]).length) throw new AppError("VALIDATION", "Choose at least one numeric variable.");
          break;
        case "frequencies":
          result = { name: spec.variable, ...frequencies(this.col(d, spec.variable)) };
          break;
        case "crosstab":
          result = { row: spec.row, column: spec.column, ...crosstab(this.col(d, spec.row), this.col(d, spec.column)) };
          break;
        case "correlation":
          result = { x: spec.x, y: spec.y, ...correlation(this.col(d, spec.x, "numeric"), this.col(d, spec.y, "numeric"), spec.method === "spearman" ? "spearman" : "pearson") };
          break;
        case "regression": {
          const preds = ((spec.predictors as string[]) ?? []).map((p) => ({ name: p, values: this.col(d, p), categorical: d.columns.find((c) => c.name === p)!.type !== "numeric" }));
          if (!preds.length) throw new AppError("VALIDATION", "Choose at least one predictor.");
          result = { outcome: spec.outcome, ...regression(this.col(d, spec.outcome, "numeric"), preds) };
          break;
        }
        case "ttest":
          result = { outcome: spec.outcome, group: spec.group, ...ttest(this.col(d, spec.outcome, "numeric"), this.col(d, spec.group)) };
          break;
        case "anova":
          result = { outcome: spec.outcome, group: spec.group, ...anova(this.col(d, spec.outcome, "numeric"), this.col(d, spec.group)) };
          break;
        default:
          throw new AppError("VALIDATION", "Unknown analysis.");
      }
    } catch (err) {
      if (err instanceof AppError || (err as { name?: string }).name === "AppError") throw err;
      throw new AppError("VALIDATION", (err as Error).message);
    }
    const [row] = await this.db.insert(analyses).values({ projectId: d.projectId, datasetId, kind, spec, method: METHODS[kind]!, result, notes: notes.slice(0, 2000), createdByUserId: actorUserId }).returning();
    return row!;
  }

  async listAnalyses(actorUserId: string, datasetId: string) {
    const d = await this.dataset(actorUserId, datasetId);
    return this.db.select().from(analyses).where(eq(analyses.datasetId, d.id)).orderBy(desc(analyses.createdAt));
  }

  /** CSV of the (cleaned) dataset. */
  async datasetCsv(actorUserId: string, datasetId: string) {
    const d = await this.dataset(actorUserId, datasetId);
    const neutral = (v: Cell) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    return Papa.unparse({ fields: d.columns.map((c) => c.name), data: d.rows.map((r) => r.map(neutral)) });
  }

  // ----- Diagrams ----------------------------------------------------------

  async listDiagrams(actorUserId: string, projectId: string) {
    await this.access(actorUserId, projectId, "read");
    return this.db.select().from(diagrams).where(eq(diagrams.projectId, projectId)).orderBy(desc(diagrams.updatedAt));
  }

  async createDiagram(actorUserId: string, projectId: string, template: string, title?: string) {
    await this.access(actorUserId, projectId, "write");
    const t = DIAGRAM_TEMPLATES[template];
    if (!t) throw new AppError("VALIDATION", "Choose a diagram type.");
    const [row] = await this.db.insert(diagrams).values({ projectId, title: (title || t.title).slice(0, 200), kind: template, source: t.source, updatedByUserId: actorUserId }).returning();
    return row!;
  }

  async saveDiagram(actorUserId: string, diagramId: string, input: { title: string; source: string; revision: number }) {
    const [dg] = await this.db.select().from(diagrams).where(eq(diagrams.id, diagramId));
    if (!dg) throw new AppError("NOT_FOUND", "Diagram not found.");
    await this.access(actorUserId, dg.projectId, "write");
    if (input.source.length > 50_000) throw new AppError("VALIDATION", "Diagrams are limited to 50,000 characters.");
    // Rendering uses Mermaid's strict security level; init directives can't loosen it.
    if (/%%\{\s*init[\s\S]*securityLevel/i.test(input.source)) throw new AppError("VALIDATION", "Diagrams can't change Mermaid's security settings.");
    const [row] = await this.db
      .update(diagrams)
      .set({ title: input.title.trim().slice(0, 200) || dg.title, source: input.source, revision: sql`${diagrams.revision} + 1`, updatedByUserId: actorUserId, updatedAt: new Date() })
      .where(and(eq(diagrams.id, diagramId), eq(diagrams.revision, input.revision)))
      .returning();
    if (!row) throw new AppError("CONFLICT", "Someone else saved this diagram since you opened it. Reload and apply your changes again.");
    return row;
  }

  async deleteDiagram(actorUserId: string, diagramId: string) {
    const [dg] = await this.db.select().from(diagrams).where(eq(diagrams.id, diagramId));
    if (!dg) throw new AppError("NOT_FOUND", "Diagram not found.");
    await this.access(actorUserId, dg.projectId, "write");
    await this.db.delete(diagrams).where(eq(diagrams.id, diagramId));
  }

  // ----- Surveys -----------------------------------------------------------

  async listSurveys(actorUserId: string, projectId: string) {
    await this.access(actorUserId, projectId, "read");
    return this.db.select().from(surveys).where(eq(surveys.projectId, projectId)).orderBy(desc(surveys.updatedAt));
  }

  async survey(actorUserId: string, surveyId: string) {
    const [s] = await this.db.select().from(surveys).where(eq(surveys.id, surveyId));
    if (!s) throw new AppError("NOT_FOUND", "Questionnaire not found.");
    await this.access(actorUserId, s.projectId, "read");
    return s;
  }

  async createSurvey(actorUserId: string, projectId: string, title: string) {
    await this.access(actorUserId, projectId, "write");
    if (title.trim().length < 2) throw new AppError("VALIDATION", "Give the questionnaire a title.");
    const [row] = await this.db.insert(surveys).values({ projectId, title: title.trim().slice(0, 200), consent: "I have read the information above and agree to take part. I understand that participation is voluntary and that I can stop at any time.", updatedByUserId: actorUserId }).returning();
    return row!;
  }

  async saveSurvey(actorUserId: string, surveyId: string, input: { title?: string; introduction?: string; consent?: string; questions: unknown[]; revision: number }) {
    const s = await this.survey(actorUserId, surveyId);
    await this.access(actorUserId, s.projectId, "write");
    const qs = input.questions.map((q, i) => {
      const r = questionSchema.safeParse(q);
      if (!r.success) throw new AppError("VALIDATION", `Question ${i + 1}: ${r.error.issues[0]!.message}`);
      const d = r.data;
      if ((d.type === "single" || d.type === "multiple") && (d.options?.length ?? 0) < 2) throw new AppError("VALIDATION", `Question ${i + 1} needs at least two options.`);
      if (d.type === "likert" && !d.scale) throw new AppError("VALIDATION", `Question ${i + 1} needs a scale.`);
      return d as SurveyQuestion;
    });
    const ids = qs.map((q) => q.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw new AppError("VALIDATION", `Two questions use the id “${dup}”.`);
    if (qs.length > 300) throw new AppError("VALIDATION", "Up to 300 questions.");
    const [row] = await this.db
      .update(surveys)
      .set({ title: input.title?.trim().slice(0, 200) || s.title, introduction: (input.introduction ?? s.introduction).slice(0, 5000), consent: (input.consent ?? s.consent).slice(0, 5000), questions: qs, revision: sql`${surveys.revision} + 1`, updatedByUserId: actorUserId, updatedAt: new Date() })
      .where(and(eq(surveys.id, surveyId), eq(surveys.revision, input.revision)))
      .returning();
    if (!row) throw new AppError("CONFLICT", "Someone else saved this questionnaire since you opened it. Reload and apply your changes again.");
    return row;
  }

  /** Codebook rows: one variable per answer column, with codes for closed questions. */
  codebook(s: typeof surveys.$inferSelect) {
    return s.questions.flatMap((q) => {
      if (q.type === "multiple") return (q.options ?? []).map((o, i) => ({ variable: `${q.id}_${i + 1}`, question: `${q.text} — ${o}`, type: "0/1 (selected)", codes: "0 = not selected; 1 = selected" }));
      if (q.type === "single") return [{ variable: q.id, question: q.text, type: "categorical", codes: (q.options ?? []).map((o, i) => `${i + 1} = ${o}`).join("; ") }];
      if (q.type === "likert") return [{ variable: q.id, question: q.text, type: `ordinal 1–${q.scale!.points}`, codes: `1 = ${q.scale!.low}; ${q.scale!.points} = ${q.scale!.high}` }];
      return [{ variable: q.id, question: q.text, type: q.type === "number" ? "numeric" : "text", codes: "" }];
    });
  }

  // ----- Project data for slides and reports -------------------------------

  async projectData(actorUserId: string, projectId: string) {
    const { access } = await this.access(actorUserId, projectId, "read");
    const today = new Date().toISOString().slice(0, 10);
    const [[p], qs, objs, stages, tasks, risks, refCount, reviews] = await Promise.all([
      this.db.select().from(researchProjects).where(eq(researchProjects.id, projectId)),
      this.db.select().from(researchQuestions).where(eq(researchQuestions.projectId, projectId)).orderBy(asc(researchQuestions.sortOrder)),
      this.db.select().from(researchObjectives).where(eq(researchObjectives.projectId, projectId)).orderBy(asc(researchObjectives.sortOrder)),
      this.db.select().from(projectStages).where(eq(projectStages.projectId, projectId)).orderBy(asc(projectStages.sortOrder)),
      this.db.select().from(researchTasks).where(eq(researchTasks.projectId, projectId)).orderBy(asc(researchTasks.startDate)),
      this.db.select().from(projectRisks).where(eq(projectRisks.projectId, projectId)),
      this.db.select({ n: sql<number>`count(*)::int` }).from(references).where(eq(references.projectId, projectId)),
      this.db.select().from(reviewRequests).where(eq(reviewRequests.projectId, projectId)).orderBy(desc(reviewRequests.createdAt)).limit(5),
    ]);
    const leaf = tasks.filter((t) => t.kind !== "milestone" && t.status !== "cancelled");
    return {
      project: p!,
      canEdit: access.permissions.has("project.update"),
      questions: qs,
      objectives: objs,
      stages,
      milestones: tasks.filter((t) => t.kind === "milestone").map((t) => ({ title: t.title, date: t.endDate, done: t.status === "done" })),
      tasks: { total: leaf.length, done: leaf.filter((t) => t.status === "done").length, overdue: leaf.filter((t) => t.status !== "done" && t.endDate < today).map((t) => ({ title: t.title, due: t.endDate })), upcoming: leaf.filter((t) => t.status !== "done" && t.endDate >= today).slice(0, 8).map((t) => ({ title: t.title, due: t.endDate, progress: t.progressPercent })) },
      risks: risks.filter((r) => r.status !== "closed").sort((a, b) => b.likelihood * b.impact - a.likelihood * a.impact).slice(0, 6),
      referenceCount: refCount[0]?.n ?? 0,
      reviews,
      today,
    };
  }
}
