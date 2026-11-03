import {
  type Database,
  type DbOrTx,
  OBJECTIVE_KINDS,
  QUESTION_KINDS,
  researchHypotheses,
  researchObjectives,
  researchProjects,
  researchQuestions,
} from "@researchmate/database";
import { AppError } from "@researchmate/shared";
import { getProjectAccess, recordAudit, requireProjectPermission } from "@researchmate/tenancy";
import { and, asc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { parse, requiredText } from "./util";

const questionSchema = z.object({ kind: z.enum(QUESTION_KINDS).default("specific"), text: requiredText("Question", 2000) });
const objectiveSchema = z.object({
  kind: z.enum(OBJECTIVE_KINDS).default("specific"),
  text: requiredText("Objective", 2000),
  questionId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});
const hypothesisSchema = z.object({
  nullHypothesis: requiredText("Null hypothesis", 2000),
  alternativeHypothesis: requiredText("Alternative hypothesis", 2000),
  questionId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});

type Kind = "question" | "objective" | "hypothesis";
const TABLES = { question: researchQuestions, objective: researchObjectives, hypothesis: researchHypotheses } as const;

/** Throws READ_ONLY for archived projects. */
export async function assertProjectWritable(db: DbOrTx, projectId: string): Promise<void> {
  const [p] = await db.select({ status: researchProjects.status }).from(researchProjects).where(eq(researchProjects.id, projectId));
  if (!p) throw new AppError("NOT_FOUND", "Project not found.");
  if (p.status === "archived") throw new AppError("READ_ONLY", "This project is archived. Restore it before making changes.");
}

/**
 * Research questions, objectives and hypotheses. These are core project
 * metadata (available on every plan); editing requires project.update.
 */
export class ResearchContentService {
  constructor(private readonly db: Database) {}

  async list(actorUserId: string, projectId: string) {
    await getProjectAccess(this.db, actorUserId, projectId);
    const [questions, objectives, hypotheses] = await Promise.all([
      this.db.select().from(researchQuestions).where(eq(researchQuestions.projectId, projectId)).orderBy(asc(researchQuestions.sortOrder), asc(researchQuestions.createdAt)),
      this.db.select().from(researchObjectives).where(eq(researchObjectives.projectId, projectId)).orderBy(asc(researchObjectives.sortOrder), asc(researchObjectives.createdAt)),
      this.db.select().from(researchHypotheses).where(eq(researchHypotheses.projectId, projectId)).orderBy(asc(researchHypotheses.sortOrder), asc(researchHypotheses.createdAt)),
    ]);
    return { questions, objectives, hypotheses, alignment: alignment(questions, objectives, hypotheses) };
  }

  private async guard(actorUserId: string, projectId: string) {
    const access = await requireProjectPermission(this.db, actorUserId, projectId, "project.update");
    await assertProjectWritable(this.db, projectId);
    return access;
  }

  private async assertQuestionInProject(projectId: string, questionId: string | null | undefined) {
    if (!questionId) return;
    const [q] = await this.db.select({ id: researchQuestions.id }).from(researchQuestions).where(and(eq(researchQuestions.id, questionId), eq(researchQuestions.projectId, projectId)));
    if (!q) throw new AppError("VALIDATION", "The linked research question does not belong to this project.");
  }

  private async nextOrder(kind: Kind, projectId: string) {
    const t = TABLES[kind];
    const [r] = await this.db.select({ m: max(t.sortOrder) }).from(t).where(eq(t.projectId, projectId));
    return (r?.m ?? -1) + 1;
  }

  async addQuestion(actorUserId: string, projectId: string, input: unknown) {
    const data = parse(questionSchema, input);
    const access = await this.guard(actorUserId, projectId);
    const [row] = await this.db
      .insert(researchQuestions)
      .values({ ...data, projectId, sortOrder: await this.nextOrder("question", projectId), createdByUserId: actorUserId })
      .returning();
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "research.question.added", targetType: "project", targetId: projectId });
    return row!;
  }

  async addObjective(actorUserId: string, projectId: string, input: unknown) {
    const data = parse(objectiveSchema, input);
    const access = await this.guard(actorUserId, projectId);
    await this.assertQuestionInProject(projectId, data.questionId);
    const [row] = await this.db
      .insert(researchObjectives)
      .values({ kind: data.kind, text: data.text, questionId: data.questionId ?? null, projectId, sortOrder: await this.nextOrder("objective", projectId), createdByUserId: actorUserId })
      .returning();
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "research.objective.added", targetType: "project", targetId: projectId });
    return row!;
  }

  async addHypothesis(actorUserId: string, projectId: string, input: unknown) {
    const data = parse(hypothesisSchema, input);
    const access = await this.guard(actorUserId, projectId);
    await this.assertQuestionInProject(projectId, data.questionId);
    const [row] = await this.db
      .insert(researchHypotheses)
      .values({ ...data, questionId: data.questionId ?? null, projectId, sortOrder: await this.nextOrder("hypothesis", projectId), createdByUserId: actorUserId })
      .returning();
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "research.hypothesis.added", targetType: "project", targetId: projectId });
    return row!;
  }

  async update(actorUserId: string, kind: Kind, id: string, input: unknown) {
    const t = TABLES[kind];
    const [row] = await this.db.select({ projectId: t.projectId }).from(t).where(eq(t.id, id));
    if (!row) throw new AppError("NOT_FOUND", "Item not found.");
    await this.guard(actorUserId, row.projectId);
    const schema = kind === "question" ? questionSchema : kind === "objective" ? objectiveSchema : hypothesisSchema;
    const data = parse(schema.partial(), input) as Record<string, unknown>;
    if ("questionId" in data) await this.assertQuestionInProject(row.projectId, data.questionId as string | null);
    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    await this.db.update(t).set({ ...patch, updatedAt: new Date() }).where(eq(t.id, id));
  }

  async remove(actorUserId: string, kind: Kind, id: string) {
    const t = TABLES[kind];
    const [row] = await this.db.select({ projectId: t.projectId }).from(t).where(eq(t.id, id));
    if (!row) throw new AppError("NOT_FOUND", "Item not found.");
    const access = await this.guard(actorUserId, row.projectId);
    await this.db.delete(t).where(eq(t.id, id));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: `research.${kind}.removed`, targetType: "project", targetId: row.projectId });
  }

  /** Moves an item one place up or down among its siblings. */
  async move(actorUserId: string, kind: Kind, id: string, direction: "up" | "down") {
    const t = TABLES[kind];
    const [row] = await this.db.select({ projectId: t.projectId }).from(t).where(eq(t.id, id));
    if (!row) throw new AppError("NOT_FOUND", "Item not found.");
    await this.guard(actorUserId, row.projectId);
    await this.db.transaction(async (tx) => {
      const items = await tx.select({ id: t.id }).from(t).where(eq(t.projectId, row.projectId)).orderBy(asc(t.sortOrder), asc(t.createdAt)).for("update");
      const i = items.findIndex((x) => x.id === id);
      const j = direction === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= items.length) return;
      [items[i], items[j]] = [items[j]!, items[i]!];
      for (const [n, it] of items.entries()) await tx.update(t).set({ sortOrder: n }).where(eq(t.id, it.id));
    });
  }
}

export interface AlignmentRow {
  questionId: string;
  label: string;
  text: string;
  objectiveIds: string[];
  hypothesisIds: string[];
}

/**
 * Objective-to-question alignment: which objectives and hypotheses address
 * each question, plus the gaps (questions with no objective, objectives not
 * linked to any question).
 */
export function alignment(
  questions: { id: string; kind: string; text: string }[],
  objectives: { id: string; questionId: string | null }[],
  hypotheses: { id: string; questionId: string | null }[],
) {
  let main = 0;
  let spec = 0;
  const rows: AlignmentRow[] = questions.map((q) => ({
    questionId: q.id,
    label: q.kind === "main" ? `MQ${++main}` : `RQ${++spec}`,
    text: q.text,
    objectiveIds: objectives.filter((o) => o.questionId === q.id).map((o) => o.id),
    hypothesisIds: hypotheses.filter((h) => h.questionId === q.id).map((h) => h.id),
  }));
  return {
    rows,
    unansweredQuestionIds: rows.filter((r) => r.objectiveIds.length === 0).map((r) => r.questionId),
    unlinkedObjectiveIds: objectives.filter((o) => !o.questionId || !questions.some((q) => q.id === o.questionId)).map((o) => o.id),
  };
}
