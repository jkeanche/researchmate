import {
  type Database,
  type DbOrTx,
  projectStages,
  researchProjects,
  STAGE_STATUSES,
  type StageDependencySpec,
  workflowStages,
  workflowTemplates,
} from "@researchmate/database";
import { AppError } from "@researchmate/shared";
import { getProjectAccess, notify, projectRecipients, recordAudit, requireProjectPermission } from "@researchmate/tenancy";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertProjectWritable } from "./content";
import { optionalDate, parse, requiredText } from "./util";

export type StageStatus = (typeof STAGE_STATUSES)[number];

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  awaiting_approval: "Awaiting approval",
  completed: "Completed",
  skipped: "Skipped",
};

const stagePatchSchema = z
  .object({
    name: requiredText("Stage name", 200),
    purpose: z.string().trim().max(2000),
    requiredInputs: z.string().trim().max(2000),
    expectedOutputs: z.string().trim().max(2000),
    completionCriteria: z.string().trim().max(2000),
    nominalDurationDays: z.coerce.number().int().min(1, "Duration must be at least 1 day").max(1000),
    enabled: z.boolean(),
    optional: z.boolean(),
    approvalRequired: z.boolean(),
    responsibleUserId: z.string().uuid().nullable().or(z.literal("").transform(() => null)),
    dueDate: optionalDate,
  })
  .partial();

/** Templates visible to an organization: active system templates plus its own. */
export async function listWorkflowTemplates(db: DbOrTx, organizationId: string) {
  return db
    .select()
    .from(workflowTemplates)
    .where(and(eq(workflowTemplates.isActive, true), or(isNull(workflowTemplates.organizationId), eq(workflowTemplates.organizationId, organizationId))))
    .orderBy(asc(workflowTemplates.name));
}

export async function defaultTemplateKeyFor(db: DbOrTx, organizationId: string, researchType: string): Promise<string | null> {
  const all = await listWorkflowTemplates(db, organizationId);
  return all.find((t) => t.defaultFor.includes(researchType))?.key ?? null;
}

/**
 * Copies a template's stages into the project. Runs inside the caller's
 * transaction; the project must not already have stages.
 */
export async function copyTemplateToProject(tx: DbOrTx, projectId: string, organizationId: string, templateKey: string) {
  const [tpl] = await tx
    .select()
    .from(workflowTemplates)
    .where(
      and(
        eq(workflowTemplates.key, templateKey),
        eq(workflowTemplates.isActive, true),
        or(isNull(workflowTemplates.organizationId), eq(workflowTemplates.organizationId, organizationId)),
      ),
    )
    .orderBy(desc(workflowTemplates.version))
    .limit(1);
  if (!tpl) throw new AppError("VALIDATION", "Unknown workflow template.");
  const [existing] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(projectStages).where(eq(projectStages.projectId, projectId));
  if ((existing?.n ?? 0) > 0) throw new AppError("CONFLICT", "This project already has a workflow.");
  const stages = await tx.select().from(workflowStages).where(eq(workflowStages.templateId, tpl.id)).orderBy(asc(workflowStages.sortOrder));
  if (stages.length) {
    await tx.insert(projectStages).values(
      stages.map((s) => ({
        projectId,
        templateStageId: s.id,
        key: s.key,
        name: s.name,
        purpose: s.purpose,
        expectedOutputs: s.expectedOutputs,
        completionCriteria: s.completionCriteria,
        nominalDurationDays: s.durationDays,
        dependsOn: s.dependsOn,
        milestoneName: s.milestoneName,
        sortOrder: s.sortOrder,
        optional: s.optional,
        approvalRequired: s.approvalRequired,
      })),
    );
  }
  await tx.update(researchProjects).set({ workflowTemplateKey: tpl.key, workflowTemplateVersion: tpl.version, updatedAt: new Date() }).where(eq(researchProjects.id, projectId));
  return { template: tpl, stageCount: stages.length };
}

export class WorkflowService {
  constructor(private readonly db: Database) {}

  async list(actorUserId: string, projectId: string) {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    const stages = await this.db.select().from(projectStages).where(eq(projectStages.projectId, projectId)).orderBy(asc(projectStages.sortOrder));
    const now = Date.now();
    const waitingSeconds = stages.reduce(
      (acc, s) => acc + s.approvalWaitSeconds + (s.awaitingApprovalSince ? Math.max(0, Math.round((now - s.awaitingApprovalSince.getTime()) / 1000)) : 0),
      0,
    );
    return { access, stages, waitingSeconds };
  }

  async applyTemplate(actorUserId: string, projectId: string, templateKey: string) {
    const access = await requireProjectPermission(this.db, actorUserId, projectId, "project.plan.manage");
    await assertProjectWritable(this.db, projectId);
    const r = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from research_projects where id = ${projectId} for update`);
      return copyTemplateToProject(tx, projectId, access.organizationId, templateKey);
    });
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "workflow.applied", targetType: "project", targetId: projectId, metadata: { template: templateKey, version: r.template.version } });
    return r;
  }

  private async stageFor(actorUserId: string, stageId: string, permission: "project.plan.manage" | "project.plan.approve" | "project.review") {
    const [stage] = await this.db.select().from(projectStages).where(eq(projectStages.id, stageId));
    if (!stage) throw new AppError("NOT_FOUND", "Stage not found.");
    const access = await requireProjectPermission(this.db, actorUserId, stage.projectId, permission);
    await assertProjectWritable(this.db, stage.projectId);
    return { stage, access };
  }

  async addStage(actorUserId: string, projectId: string, input: { name: string; purpose?: string; nominalDurationDays?: number }) {
    const access = await requireProjectPermission(this.db, actorUserId, projectId, "project.plan.manage");
    await assertProjectWritable(this.db, projectId);
    const data = parse(stagePatchSchema.required({ name: true }), input);
    const [last] = await this.db.select({ key: projectStages.key, sortOrder: projectStages.sortOrder }).from(projectStages).where(eq(projectStages.projectId, projectId)).orderBy(desc(projectStages.sortOrder)).limit(1);
    const key = `custom_${Date.now().toString(36)}`;
    const [row] = await this.db
      .insert(projectStages)
      .values({
        projectId,
        key,
        name: data.name,
        purpose: data.purpose ?? "",
        nominalDurationDays: data.nominalDurationDays ?? 7,
        dependsOn: last ? [{ key: last.key, type: "FS", lagDays: 0 }] : [],
        sortOrder: (last?.sortOrder ?? -1) + 1,
      })
      .returning();
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "workflow.stage.added", targetType: "project", targetId: projectId, metadata: { stage: data.name } });
    return row!;
  }

  async updateStage(actorUserId: string, stageId: string, input: unknown) {
    const data = parse(stagePatchSchema, input);
    const { stage, access } = await this.stageFor(actorUserId, stageId, "project.plan.manage");
    if (data.responsibleUserId) {
      // Must be someone who can see the project.
      await getProjectAccess(this.db, data.responsibleUserId, stage.projectId).catch(() => {
        throw new AppError("VALIDATION", "The responsible person must be a member of this project.");
      });
    }
    if (data.enabled === false && stage.status === "in_progress") throw new AppError("VALIDATION", "Finish or pause this stage before disabling it.");
    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    await this.db.update(projectStages).set({ ...patch, updatedAt: new Date() }).where(eq(projectStages.id, stageId));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "workflow.stage.updated", targetType: "project", targetId: stage.projectId, metadata: { stageId, fields: Object.keys(patch) } });
  }

  async moveStage(actorUserId: string, stageId: string, direction: "up" | "down") {
    const { stage } = await this.stageFor(actorUserId, stageId, "project.plan.manage");
    await this.db.transaction(async (tx) => {
      const rows = await tx.select({ id: projectStages.id }).from(projectStages).where(eq(projectStages.projectId, stage.projectId)).orderBy(asc(projectStages.sortOrder)).for("update");
      const i = rows.findIndex((r) => r.id === stageId);
      const j = direction === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= rows.length) return;
      [rows[i], rows[j]] = [rows[j]!, rows[i]!];
      for (const [n, r] of rows.entries()) await tx.update(projectStages).set({ sortOrder: n }).where(eq(projectStages.id, r.id));
    });
  }

  /** Adds another pass of a stage directly after it (e.g. a second round of data collection). */
  async repeatStage(actorUserId: string, stageId: string) {
    const { stage, access } = await this.stageFor(actorUserId, stageId, "project.plan.manage");
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(projectStages).where(eq(projectStages.projectId, stage.projectId)).orderBy(asc(projectStages.sortOrder)).for("update");
      const iterations = rows.filter((r) => r.key === stage.key || r.key.startsWith(`${stage.key}__`)).length;
      const key = `${stage.key}__${iterations + 1}`;
      for (const r of rows) if (r.sortOrder > stage.sortOrder) await tx.update(projectStages).set({ sortOrder: r.sortOrder + 1 }).where(eq(projectStages.id, r.id));
      const deps: StageDependencySpec[] = [{ key: stage.key, type: "FS", lagDays: 0 }];
      const [copy] = await tx
        .insert(projectStages)
        .values({
          projectId: stage.projectId,
          templateStageId: stage.templateStageId,
          key,
          name: stage.name,
          purpose: stage.purpose,
          requiredInputs: stage.requiredInputs,
          expectedOutputs: stage.expectedOutputs,
          completionCriteria: stage.completionCriteria,
          nominalDurationDays: stage.nominalDurationDays,
          dependsOn: deps,
          sortOrder: stage.sortOrder + 1,
          iteration: iterations + 1,
          optional: stage.optional,
          approvalRequired: stage.approvalRequired,
          responsibleUserId: stage.responsibleUserId,
        })
        .returning();
      // Stages that followed the original now follow the repeat.
      for (const r of rows) {
        if (r.id === stage.id) continue;
        if (r.dependsOn.some((d) => d.key === stage.key)) {
          await tx.update(projectStages).set({ dependsOn: r.dependsOn.map((d) => (d.key === stage.key ? { ...d, key } : d)) }).where(eq(projectStages.id, r.id));
        }
      }
      await recordAudit(tx, { organizationId: access.organizationId, actorUserId, action: "workflow.stage.repeated", targetType: "project", targetId: stage.projectId, metadata: { stage: stage.name, iteration: iterations + 1 } });
      return copy!;
    });
  }

  /**
   * Stage lifecycle. Approval-gated stages go through awaiting_approval; only
   * approvers (project.plan.approve) or reviewers (project.review) may decide,
   * and the time spent waiting is accumulated.
   */
  async transition(actorUserId: string, stageId: string, action: "start" | "complete" | "approve" | "request_changes" | "skip" | "reopen", note?: string) {
    const needs = action === "approve" || action === "request_changes" ? "project.review" : "project.plan.manage";
    const [stage] = await this.db.select().from(projectStages).where(eq(projectStages.id, stageId));
    if (!stage) throw new AppError("NOT_FOUND", "Stage not found.");
    const access = await getProjectAccess(this.db, actorUserId, stage.projectId);
    const allowed = needs === "project.review" ? access.permissions.has("project.review") || access.permissions.has("project.plan.approve") : access.permissions.has("project.plan.manage");
    if (!allowed) throw new AppError("FORBIDDEN", "You do not have permission to do that in this project.");
    await assertProjectWritable(this.db, stage.projectId);
    if (!stage.enabled) throw new AppError("VALIDATION", "Enable this stage first.");

    const now = new Date();
    const waited = () => (stage.awaitingApprovalSince ? Math.max(0, Math.round((now.getTime() - stage.awaitingApprovalSince.getTime()) / 1000)) : 0);
    const from = stage.status as StageStatus;
    let patch: Partial<typeof projectStages.$inferInsert>;
    switch (action) {
      case "start":
        if (from !== "not_started") throw new AppError("VALIDATION", "Only a stage that has not started can be started.");
        patch = { status: "in_progress", startedAt: now };
        break;
      case "complete":
        if (from !== "in_progress") throw new AppError("VALIDATION", "Start the stage before completing it.");
        patch = stage.approvalRequired ? { status: "awaiting_approval", awaitingApprovalSince: now } : { status: "completed", completedAt: now };
        break;
      case "approve":
        if (from !== "awaiting_approval") throw new AppError("VALIDATION", "This stage is not awaiting approval.");
        patch = { status: "completed", completedAt: now, approvedByUserId: actorUserId, approvedAt: now, approvalNote: note?.slice(0, 2000) ?? null, awaitingApprovalSince: null, approvalWaitSeconds: stage.approvalWaitSeconds + waited() };
        break;
      case "request_changes":
        if (from !== "awaiting_approval") throw new AppError("VALIDATION", "This stage is not awaiting approval.");
        patch = { status: "in_progress", approvalNote: note?.slice(0, 2000) ?? null, awaitingApprovalSince: null, approvalWaitSeconds: stage.approvalWaitSeconds + waited() };
        break;
      case "skip":
        if (!stage.optional) throw new AppError("VALIDATION", "Only optional stages can be skipped. Disable the stage instead.");
        if (from === "completed") throw new AppError("VALIDATION", "A completed stage cannot be skipped.");
        patch = { status: "skipped", awaitingApprovalSince: null, approvalWaitSeconds: stage.approvalWaitSeconds + waited() };
        break;
      case "reopen":
        if (from !== "completed" && from !== "skipped") throw new AppError("VALIDATION", "Only completed or skipped stages can be reopened.");
        patch = { status: from === "skipped" ? "not_started" : "in_progress", completedAt: null, approvedByUserId: null, approvedAt: null };
        break;
    }
    await this.db.update(projectStages).set({ ...patch, updatedAt: now }).where(and(eq(projectStages.id, stageId), eq(projectStages.status, from)));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: `workflow.stage.${action}`, targetType: "project", targetId: stage.projectId, metadata: { stageId, stage: stage.name, from, to: patch.status, note: note ? note.slice(0, 500) : undefined } });
    if (patch.status === "completed" || patch.status === "awaiting_approval") {
      const [p] = await this.db.select({ title: researchProjects.title }).from(researchProjects).where(eq(researchProjects.id, stage.projectId));
      const done = patch.status === "completed";
      await notify(this.db, {
        // Completion goes to everyone on the project; approval requests to those who can approve.
        userIds: await projectRecipients(this.db, stage.projectId, done ? "project.read" : "project.review", [actorUserId]),
        kind: "workflow.stage_completed",
        title: done ? `Stage completed: ${stage.name}` : `Stage awaiting approval: ${stage.name}`,
        body: done ? `“${stage.name}” in “${p?.title ?? "the project"}” is complete.${stage.milestoneName ? ` Milestone reached: ${stage.milestoneName}.` : ""}` : `“${stage.name}” in “${p?.title ?? "the project"}” is finished and needs approval before the project moves on.`,
        link: `/app/projects/${stage.projectId}/workflow`,
        projectId: stage.projectId,
        dedupeKey: `stage:${stageId}:${patch.status}:${now.toISOString()}`,
      });
    }
    return patch.status as StageStatus;
  }
}
