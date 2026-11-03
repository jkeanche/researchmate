import {
  type Database,
  type DbOrTx,
  EVENT_KINDS,
  projectCalendarEvents,
  projectResourceAssignments,
  projectRisks,
  projectScheduleBaselineItems,
  projectScheduleBaselines,
  projectScheduleRevisions,
  projectStages,
  researchProjects,
  researchTasks,
  researchTimeEntries,
  RISK_CATEGORIES,
  RISK_STATUSES,
  type SchedulePayload,
  scheduleProposals,
  TASK_PRIORITIES,
  TASK_STATUSES,
  taskChecklistItems,
  taskComments,
  taskDependencies,
  TIME_CATEGORIES,
  userProfiles,
} from "@researchmate/database";
import { getEntitlements, limitOf, tierOf } from "@researchmate/entitlements";
import { assertProjectWritable, parse } from "@researchmate/research";
import { AppError } from "@researchmate/shared";
import { getProjectAccess, type ProjectAccess, recordAudit } from "@researchmate/tenancy";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { addDays, isIsoDate, todayIso, toDay } from "./dates";
import {
  type DateChange,
  type PlanDependency,
  PlanningError,
  type PlanTask,
  reschedule,
  rollUp,
  validateNewDependency,
  validateParent,
  weightedProgress,
  findCycle,
} from "./engine";
import { proposeSchedule } from "./proposal";

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export type PlanningTier = "none" | "overview" | "full";

/**
 * planning.gantt tiers:
 *   overview — tasks and milestones (up to planning.tasks.max per project),
 *              task list, board, calendar and a read-only timeline
 *   full     — plus dependencies, drag scheduling, critical path, baselines,
 *              schedule proposals, risks, events, time tracking, workload
 * Reads are never blocked by the tier, so a downgraded project stays visible.
 */
export async function planningEntitlement(db: DbOrTx, organizationId: string) {
  const ent = await getEntitlements(db, organizationId);
  return { tier: tierOf(ent, "planning.gantt") as PlanningTier, taskLimit: limitOf(ent, "planning.tasks.max"), planName: ent.planName };
}

async function requireTier(db: DbOrTx, organizationId: string, min: "overview" | "full", what: string) {
  const e = await planningEntitlement(db, organizationId);
  const rank = { none: 0, overview: 1, full: 2 } as const;
  if (rank[e.tier] < rank[min]) {
    throw new AppError("FEATURE_NOT_ENTITLED", `${what} ${min === "full" ? "is part of full project planning, which" : "is"} not included in the ${e.planName} plan.`, {
      feature: "planning.gantt",
      required: min,
    });
  }
  return e;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const isoDate = (label: string) => z.string().refine(isIsoDate, `${label} must be a valid date`);
const optionalIso = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isIsoDate(v), "must be a valid date");
const optionalUuid = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^[0-9a-f-]{36}$/i.test(v), "Invalid id");

const taskCreateSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(300),
    kind: z.enum(["task", "milestone"]).default("task"),
    description: z.string().trim().max(10_000).default(""),
    startDate: isoDate("Start date"),
    endDate: optionalIso,
    parentTaskId: optionalUuid,
    stageId: optionalUuid,
    assigneeUserId: optionalUuid,
    priority: z.enum(TASK_PRIORITIES).default("normal"),
    estimateHours: z.coerce.number().min(0).max(100_000).nullable().optional(),
    requiresCompletionApproval: z.boolean().default(false),
  })
  .transform((v) => ({ ...v, endDate: v.kind === "milestone" ? v.startDate : (v.endDate ?? v.startDate) }))
  .refine((v) => v.endDate >= v.startDate, { message: "The end date must be on or after the start date", path: ["endDate"] });

const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(300),
    description: z.string().trim().max(10_000),
    startDate: isoDate("Start date"),
    endDate: isoDate("End date"),
    parentTaskId: optionalUuid,
    stageId: optionalUuid,
    assigneeUserId: optionalUuid,
    priority: z.enum(TASK_PRIORITIES),
    status: z.enum(TASK_STATUSES),
    progressPercent: z.coerce.number().int().min(0).max(100),
    estimateHours: z.coerce.number().min(0).max(100_000).nullable(),
    actualStartDate: optionalIso,
    actualEndDate: optionalIso,
    deadlineLocked: z.boolean(),
    requiresCompletionApproval: z.boolean(),
  })
  .partial();

const PLAN_FIELDS = ["title", "description", "startDate", "endDate", "parentTaskId", "stageId", "assigneeUserId", "priority", "estimateHours", "requiresCompletionApproval"] as const;
const WORK_FIELDS = ["status", "progressPercent", "actualStartDate", "actualEndDate"] as const;

const dependencySchema = z.object({
  predecessorId: z.string().uuid(),
  successorId: z.string().uuid(),
  type: z.enum(["FS", "SS", "FF", "SF"]).default("FS"),
  lagDays: z.coerce.number().int().min(-365).max(365).default(0),
});

const riskSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(300),
  description: z.string().trim().max(5000).default(""),
  category: z.enum(RISK_CATEGORIES).default("other"),
  likelihood: z.coerce.number().int().min(1).max(5),
  impact: z.coerce.number().int().min(1).max(5),
  status: z.enum(RISK_STATUSES).default("open"),
  ownerUserId: optionalUuid,
  mitigation: z.string().trim().max(5000).default(""),
  contingency: z.string().trim().max(5000).default(""),
  taskId: optionalUuid,
  reviewDate: optionalIso,
});

const eventSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(300),
    kind: z.enum(EVENT_KINDS).default("meeting"),
    startDate: isoDate("Date"),
    endDate: optionalIso,
    startTime: z
      .string()
      .optional()
      .nullable()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), "Time must be HH:MM"),
    location: z.string().trim().max(300).default(""),
    notes: z.string().trim().max(5000).default(""),
  })
  .transform((v) => ({ ...v, endDate: v.endDate ?? v.startDate }))
  .refine((v) => v.endDate >= v.startDate, { message: "The end date must be on or after the start date", path: ["endDate"] });

const timeSchema = z.object({
  taskId: optionalUuid,
  entryDate: isoDate("Date"),
  minutes: z.coerce.number().int().min(1, "Enter at least one minute").max(1440, "At most 24 hours per entry"),
  category: z.enum(TIME_CATEGORIES).default("research"),
  note: z.string().trim().max(1000).default(""),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TaskRow = typeof researchTasks.$inferSelect;

export function toPlanTask(r: TaskRow): PlanTask {
  return {
    id: r.id,
    parentId: r.parentTaskId,
    kind: r.kind as PlanTask["kind"],
    title: r.title,
    startDate: r.startDate,
    endDate: r.endDate,
    status: r.status,
    progressPercent: r.progressPercent,
    deadlineLocked: r.deadlineLocked,
    actualStartDate: r.actualStartDate,
    actualEndDate: r.actualEndDate,
    sortOrder: r.sortOrder,
  };
}

function toPlanDep(d: typeof taskDependencies.$inferSelect): PlanDependency {
  return { predecessorId: d.predecessorId, successorId: d.successorId, type: d.type as PlanDependency["type"], lagDays: d.lagDays };
}

/** Maps engine errors to user-facing domain errors. */
function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof PlanningError) throw new AppError(err.code === "LOCKED" ? "CONFLICT" : "VALIDATION", err.message, { planning: err.code, ...err.details });
    throw err;
  }
}

async function lockProject(tx: DbOrTx, projectId: string) {
  await tx.execute(sql`select id from research_projects where id = ${projectId} for update`);
}

async function loadGraph(tx: DbOrTx, projectId: string) {
  const [rows, deps] = await Promise.all([
    tx.select().from(researchTasks).where(eq(researchTasks.projectId, projectId)).orderBy(asc(researchTasks.sortOrder), asc(researchTasks.createdAt)),
    tx.select().from(taskDependencies).where(eq(taskDependencies.projectId, projectId)),
  ]);
  return { rows, deps, tasks: rows.map(toPlanTask), planDeps: deps.map(toPlanDep) };
}

async function userToday(db: DbOrTx, userId: string): Promise<string> {
  const [p] = await db.select({ tz: userProfiles.timezone }).from(userProfiles).where(eq(userProfiles.userId, userId));
  return todayIso(new Date(), p?.tz ?? "UTC");
}

async function assertMemberCanAccess(db: DbOrTx, userId: string | null | undefined, projectId: string, label = "The assignee") {
  if (!userId) return;
  await getProjectAccess(db, userId, projectId).catch(() => {
    throw new AppError("VALIDATION", `${label} must be a member of this project.`);
  });
}

/** Writes date changes produced by the engine and logs a revision for each. */
async function persistChanges(tx: DbOrTx, projectId: string, actorUserId: string, changes: DateChange[], source: "manual" | "gantt" | "proposal", lockedOverride: Set<string>, reason = "") {
  for (const c of changes) {
    await tx
      .update(researchTasks)
      .set({ startDate: c.startDate, endDate: c.endDate, version: sql`${researchTasks.version} + 1`, updatedAt: new Date() })
      .where(eq(researchTasks.id, c.id));
    const src = lockedOverride.has(c.id) ? "locked_override" : c.reason === "edit" ? source : c.reason;
    await tx.insert(projectScheduleRevisions).values({
      projectId,
      taskId: c.id,
      changedByUserId: actorUserId,
      source: src,
      oldStartDate: c.oldStartDate,
      oldEndDate: c.oldEndDate,
      newStartDate: c.startDate,
      newEndDate: c.endDate,
      reason: reason.slice(0, 1000),
    });
  }
}

export async function recomputeProjectProgress(tx: DbOrTx, projectId: string): Promise<number | null> {
  const [p] = await tx.select({ source: researchProjects.progressSource }).from(researchProjects).where(eq(researchProjects.id, projectId));
  if (p?.source !== "tasks") return null;
  const rows = await tx.select().from(researchTasks).where(eq(researchTasks.projectId, projectId));
  const value = weightedProgress(rows.map(toPlanTask));
  await tx.update(researchProjects).set({ progressPercent: value }).where(eq(researchProjects.id, projectId));
  return value;
}

function lockedChangedIds(tasks: PlanTask[], changes: DateChange[]) {
  const locked = new Set(tasks.filter((t) => t.deadlineLocked).map((t) => t.id));
  return new Set(changes.filter((c) => locked.has(c.id) && c.oldEndDate !== c.endDate).map((c) => c.id));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface UpdateTaskOptions {
  /** Reject the update if the task changed since the client loaded it. */
  expectedVersion?: number;
  /** An approver explicitly confirms moving an approved (locked) deadline. */
  confirmLockedChange?: boolean;
  source?: "manual" | "gantt";
  reason?: string;
}

export class PlanningService {
  constructor(private readonly db: Database) {}

  private async access(actorUserId: string, projectId: string) {
    return getProjectAccess(this.db, actorUserId, projectId);
  }

  private can(a: ProjectAccess, p: string) {
    return a.permissions.has(p as never);
  }

  private async requirePlanEditor(actorUserId: string, projectId: string, minTier: "overview" | "full", what: string) {
    const a = await this.access(actorUserId, projectId);
    if (!this.can(a, "project.plan.manage")) throw new AppError("FORBIDDEN", "You do not have permission to change this project's plan.");
    await assertProjectWritable(this.db, projectId);
    const ent = await requireTier(this.db, a.organizationId, minTier, what);
    return { access: a, ent };
  }

  private async taskRow(taskId: string) {
    const [row] = await this.db.select().from(researchTasks).where(eq(researchTasks.id, taskId));
    if (!row) throw new AppError("NOT_FOUND", "Task not found.");
    return row;
  }

  // ----- Reads -------------------------------------------------------------

  /** Raw plan data for a project (tasks, dependencies, entitlement, today). */
  async getPlan(actorUserId: string, projectId: string) {
    const access = await this.access(actorUserId, projectId);
    const [{ rows, deps, tasks, planDeps }, ent, today, assignments] = await Promise.all([
      loadGraph(this.db, projectId),
      planningEntitlement(this.db, access.organizationId),
      userToday(this.db, actorUserId),
      this.db.select().from(projectResourceAssignments).where(eq(projectResourceAssignments.projectId, projectId)),
    ]);
    return { access, entitlement: ent, today, rows, deps, tasks, planDeps, assignments };
  }

  async getTask(actorUserId: string, taskId: string) {
    const row = await this.taskRow(taskId);
    const access = await this.access(actorUserId, row.projectId);
    const [checklist, comments, revisions, predecessors, successors, assignments, time] = await Promise.all([
      this.db.select().from(taskChecklistItems).where(eq(taskChecklistItems.taskId, taskId)).orderBy(asc(taskChecklistItems.sortOrder), asc(taskChecklistItems.createdAt)),
      this.db
        .select({ id: taskComments.id, body: taskComments.body, createdAt: taskComments.createdAt, authorUserId: taskComments.authorUserId, authorName: userProfiles.displayName })
        .from(taskComments)
        .leftJoin(userProfiles, eq(userProfiles.userId, taskComments.authorUserId))
        .where(eq(taskComments.taskId, taskId))
        .orderBy(asc(taskComments.createdAt)),
      this.db
        .select({ r: projectScheduleRevisions, name: userProfiles.displayName })
        .from(projectScheduleRevisions)
        .leftJoin(userProfiles, eq(userProfiles.userId, projectScheduleRevisions.changedByUserId))
        .where(eq(projectScheduleRevisions.taskId, taskId))
        .orderBy(desc(projectScheduleRevisions.createdAt))
        .limit(50),
      this.db.select().from(taskDependencies).where(eq(taskDependencies.successorId, taskId)),
      this.db.select().from(taskDependencies).where(eq(taskDependencies.predecessorId, taskId)),
      this.db.select().from(projectResourceAssignments).where(eq(projectResourceAssignments.taskId, taskId)),
      this.db.select().from(researchTimeEntries).where(eq(researchTimeEntries.taskId, taskId)),
    ]);
    return { access, task: row, checklist, comments, revisions, predecessors, successors, assignments, minutesLogged: time.reduce((a, t) => a + t.minutes, 0) };
  }

  // ----- Tasks -------------------------------------------------------------

  async createTask(actorUserId: string, projectId: string, input: unknown) {
    const data = parse(taskCreateSchema, input);
    const { access, ent } = await this.requirePlanEditor(actorUserId, projectId, "overview", "Task planning");
    await assertMemberCanAccess(this.db, data.assigneeUserId, projectId);
    const result = await this.db.transaction(async (tx) => {
      await lockProject(tx, projectId);
      const g = await loadGraph(tx, projectId);
      if (ent.taskLimit !== null && g.rows.length >= ent.taskLimit) {
        throw new AppError("QUOTA_EXCEEDED", `The ${ent.planName} plan allows ${ent.taskLimit} tasks and milestones per project. Upgrade for unlimited planning.`, {
          feature: "planning.tasks.max",
          limit: ent.taskLimit,
        });
      }
      if (data.parentTaskId) wrap(() => validateParent(g.tasks, null, data.parentTaskId, g.planDeps));
      if (data.stageId) {
        const [st] = await tx.select({ id: projectStages.id }).from(projectStages).where(and(eq(projectStages.id, data.stageId), eq(projectStages.projectId, projectId)));
        if (!st) throw new AppError("VALIDATION", "That stage does not belong to this project.");
      }
      const siblings = g.rows.filter((r) => r.parentTaskId === (data.parentTaskId ?? null));
      const [row] = await tx
        .insert(researchTasks)
        .values({
          ...data,
          estimateHours: data.estimateHours ?? null,
          projectId,
          sortOrder: siblings.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1,
          createdByUserId: actorUserId,
        })
        .returning();
      // A new subtask can extend its parent and push the parent's successors.
      const after = [...g.tasks, toPlanTask(row!)];
      const r = wrap(() => reschedule(after, g.planDeps, []));
      await persistChanges(tx, projectId, actorUserId, r.changes, "manual", new Set());
      await recomputeProjectProgress(tx, projectId);
      await recordAudit(tx, { organizationId: access.organizationId, actorUserId, action: "task.created", targetType: "task", targetId: row!.id, metadata: { projectId, kind: data.kind } });
      return { task: row!, changes: r.changes };
    });
    return result;
  }

  async updateTask(actorUserId: string, taskId: string, input: unknown, opts: UpdateTaskOptions = {}) {
    const data = parse(taskPatchSchema, input);
    const before = await this.taskRow(taskId);
    const projectId = before.projectId;
    const access = await this.access(actorUserId, projectId);
    await assertProjectWritable(this.db, projectId);

    const keys = Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== undefined);
    const canManage = this.can(access, "project.plan.manage");
    const canApprove = this.can(access, "project.plan.approve");
    const canWork = canManage || (this.can(access, "project.tasks.work") && before.assigneeUserId === actorUserId);
    if (keys.some((k) => (PLAN_FIELDS as readonly string[]).includes(k)) && !canManage) throw new AppError("FORBIDDEN", "You do not have permission to change this task.");
    if (keys.some((k) => (WORK_FIELDS as readonly string[]).includes(k)) && !canWork) throw new AppError("FORBIDDEN", "Only the assignee or a planner can update this task's progress.");
    if (keys.includes("deadlineLocked") && !canApprove) throw new AppError("FORBIDDEN", "Only an approver can lock or unlock a deadline.");
    if (opts.confirmLockedChange && !canApprove) throw new AppError("FORBIDDEN", "Only an approver can move an approved deadline.");
    if (data.parentTaskId !== undefined && data.parentTaskId === taskId) throw new AppError("VALIDATION", "A task cannot be its own parent.");
    await requireTier(this.db, access.organizationId, opts.source === "gantt" ? "full" : "overview", opts.source === "gantt" ? "Drag-and-drop scheduling" : "Task planning");
    await assertMemberCanAccess(this.db, data.assigneeUserId, projectId);
    const today = await userToday(this.db, actorUserId);

    return this.db.transaction(async (tx) => {
      await lockProject(tx, projectId);
      const g = await loadGraph(tx, projectId);
      const row = g.rows.find((r) => r.id === taskId)!;
      if (opts.expectedVersion !== undefined && row.version !== opts.expectedVersion) {
        throw new AppError("CONFLICT", "This task was changed by someone else. Reload to see the latest version.", { version: row.version });
      }
      if (data.stageId) {
        const [st] = await tx.select({ id: projectStages.id }).from(projectStages).where(and(eq(projectStages.id, data.stageId), eq(projectStages.projectId, projectId)));
        if (!st) throw new AppError("VALIDATION", "That stage does not belong to this project.");
      }

      // Hierarchy changes first, so date rules see the new structure.
      let tasks = g.tasks;
      if (data.parentTaskId !== undefined && data.parentTaskId !== row.parentTaskId) {
        wrap(() => validateParent(g.tasks, taskId, data.parentTaskId ?? null, g.planDeps));
        tasks = tasks.map((t) => (t.id === taskId ? { ...t, parentId: data.parentTaskId ?? null } : t));
      }

      // Status rules.
      const patch: Partial<typeof researchTasks.$inferInsert> = {};
      for (const k of keys) if (k !== "startDate" && k !== "endDate") (patch as Record<string, unknown>)[k] = (data as Record<string, unknown>)[k];
      let message: string | undefined;
      const status = data.status ?? row.status;
      if (data.progressPercent !== undefined && data.progressPercent > 0 && status === "todo" && data.status === undefined) patch.status = "in_progress";
      if ((patch.status ?? status) === "in_progress" && !row.actualStartDate && data.actualStartDate === undefined) patch.actualStartDate = today;
      if (data.status === "done" && row.status !== "done") {
        const needsApproval = (data.requiresCompletionApproval ?? row.requiresCompletionApproval) && !canApprove;
        if (needsApproval) {
          patch.status = "in_review";
          message = "Sent for completion approval.";
        } else {
          patch.progressPercent = 100;
          patch.actualEndDate = data.actualEndDate ?? row.actualEndDate ?? today;
          patch.actualStartDate = data.actualStartDate ?? row.actualStartDate ?? (row.startDate < patch.actualEndDate! ? row.startDate : patch.actualEndDate);
          if (row.requiresCompletionApproval) {
            patch.completionApprovedByUserId = actorUserId;
            patch.completionApprovedAt = new Date();
          }
        }
      }
      if (data.status && data.status !== "done" && row.status === "done") {
        patch.completionApprovedByUserId = null;
        patch.completionApprovedAt = null;
        if (data.actualEndDate === undefined) patch.actualEndDate = null;
      }
      if (row.kind === "milestone" && (data.startDate || data.endDate)) {
        const d = data.startDate ?? data.endDate!;
        data.startDate = d;
        data.endDate = d;
      }

      // Date changes through the scheduling engine (validation + cascade).
      let changes: DateChange[] = [];
      let lockedOverride = new Set<string>();
      const datesChanged = (data.startDate && data.startDate !== row.startDate) || (data.endDate && data.endDate !== row.endDate);
      const edits = datesChanged ? [{ id: taskId, startDate: data.startDate ?? row.startDate, endDate: data.endDate ?? row.endDate }] : [];
      if (edits.length || tasks !== g.tasks) {
        const r = wrap(() => reschedule(tasks, g.planDeps, edits, { allowLockedChanges: !!opts.confirmLockedChange && canApprove }));
        changes = r.changes;
        lockedOverride = lockedChangedIds(tasks, changes);
      }

      if (Object.keys(patch).length) {
        await tx
          .update(researchTasks)
          .set({ ...patch, version: sql`${researchTasks.version} + 1`, updatedAt: new Date() })
          .where(eq(researchTasks.id, taskId));
      }
      await persistChanges(tx, projectId, actorUserId, changes, opts.source ?? "manual", lockedOverride, opts.reason);
      await recomputeProjectProgress(tx, projectId);
      await recordAudit(tx, {
        organizationId: access.organizationId,
        actorUserId,
        action: lockedOverride.size ? "task.deadline_override" : "task.updated",
        targetType: "task",
        targetId: taskId,
        metadata: { projectId, fields: keys, moved: changes.length, lockedOverride: [...lockedOverride] },
      });
      const [updated] = await tx.select().from(researchTasks).where(eq(researchTasks.id, taskId));
      return { task: updated!, changes, message };
    });
  }

  async approveCompletion(actorUserId: string, taskId: string) {
    const row = await this.taskRow(taskId);
    const access = await this.access(actorUserId, row.projectId);
    if (!this.can(access, "project.plan.approve")) throw new AppError("FORBIDDEN", "Only an approver can approve task completion.");
    await assertProjectWritable(this.db, row.projectId);
    if (row.status !== "in_review") throw new AppError("VALIDATION", "This task is not awaiting approval.");
    const today = await userToday(this.db, actorUserId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(researchTasks)
        .set({
          status: "done",
          progressPercent: 100,
          actualEndDate: row.actualEndDate ?? today,
          actualStartDate: row.actualStartDate ?? (row.startDate < today ? row.startDate : today),
          completionApprovedByUserId: actorUserId,
          completionApprovedAt: new Date(),
          version: sql`${researchTasks.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(researchTasks.id, taskId), eq(researchTasks.status, "in_review")));
      await recomputeProjectProgress(tx, row.projectId);
      await recordAudit(tx, { organizationId: access.organizationId, actorUserId, action: "task.completion_approved", targetType: "task", targetId: taskId, metadata: { projectId: row.projectId } });
    });
  }

  async deleteTask(actorUserId: string, taskId: string) {
    const row = await this.taskRow(taskId);
    const { access } = await this.requirePlanEditor(actorUserId, row.projectId, "overview", "Task planning");
    if (row.deadlineLocked && !this.can(access, "project.plan.approve")) throw new AppError("FORBIDDEN", "This task has an approved deadline. Only an approver can delete it.");
    await this.db.transaction(async (tx) => {
      await lockProject(tx, row.projectId);
      await tx.delete(researchTasks).where(eq(researchTasks.id, taskId));
      const g = await loadGraph(tx, row.projectId);
      const r = wrap(() => reschedule(g.tasks, g.planDeps, []));
      await persistChanges(tx, row.projectId, actorUserId, r.changes, "manual", new Set());
      await recomputeProjectProgress(tx, row.projectId);
      await recordAudit(tx, { organizationId: access.organizationId, actorUserId, action: "task.deleted", targetType: "task", targetId: taskId, metadata: { projectId: row.projectId, title: row.title } });
    });
  }

  async moveTask(actorUserId: string, taskId: string, direction: "up" | "down") {
    const row = await this.taskRow(taskId);
    await this.requirePlanEditor(actorUserId, row.projectId, "overview", "Task planning");
    await this.db.transaction(async (tx) => {
      await lockProject(tx, row.projectId);
      const sibs = (await tx.select().from(researchTasks).where(eq(researchTasks.projectId, row.projectId)).orderBy(asc(researchTasks.sortOrder), asc(researchTasks.createdAt))).filter(
        (r) => r.parentTaskId === row.parentTaskId,
      );
      const i = sibs.findIndex((s) => s.id === taskId);
      const j = direction === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= sibs.length) return;
      [sibs[i], sibs[j]] = [sibs[j]!, sibs[i]!];
      for (const [n, s] of sibs.entries()) await tx.update(researchTasks).set({ sortOrder: n }).where(eq(researchTasks.id, s.id));
    });
  }

  // ----- Dependencies ------------------------------------------------------

  async addDependency(actorUserId: string, projectId: string, input: unknown, opts: { confirmLockedChange?: boolean } = {}) {
    const dep = parse(dependencySchema, input);
    const { access } = await this.requirePlanEditor(actorUserId, projectId, "full", "Task dependencies");
    const canApprove = this.can(access, "project.plan.approve");
    return this.db.transaction(async (tx) => {
      await lockProject(tx, projectId);
      const g = await loadGraph(tx, projectId);
      wrap(() => validateNewDependency(g.tasks, g.planDeps, dep));
      const r = wrap(() => reschedule(g.tasks, [...g.planDeps, dep], [], { allowLockedChanges: !!opts.confirmLockedChange && canApprove }));
      const [row] = await tx.insert(taskDependencies).values({ ...dep, projectId, createdByUserId: actorUserId }).returning();
      await persistChanges(tx, projectId, actorUserId, r.changes, "manual", lockedChangedIds(g.tasks, r.changes), "Dependency added");
      await recordAudit(tx, { organizationId: access.organizationId, actorUserId, action: "task.dependency.added", targetType: "project", targetId: projectId, metadata: { ...dep, moved: r.changes.length } });
      return { dependency: row!, changes: r.changes };
    });
  }

  async updateDependency(actorUserId: string, dependencyId: string, input: { type?: string; lagDays?: number | string }, opts: { confirmLockedChange?: boolean } = {}) {
    const [existing] = await this.db.select().from(taskDependencies).where(eq(taskDependencies.id, dependencyId));
    if (!existing) throw new AppError("NOT_FOUND", "Dependency not found.");
    const next = parse(dependencySchema, { ...existing, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) });
    const { access } = await this.requirePlanEditor(actorUserId, existing.projectId, "full", "Task dependencies");
    const canApprove = this.can(access, "project.plan.approve");
    return this.db.transaction(async (tx) => {
      await lockProject(tx, existing.projectId);
      const g = await loadGraph(tx, existing.projectId);
      const others = g.deps.filter((d) => d.id !== dependencyId).map(toPlanDep);
      const r = wrap(() => reschedule(g.tasks, [...others, next], [], { allowLockedChanges: !!opts.confirmLockedChange && canApprove }));
      await tx.update(taskDependencies).set({ type: next.type, lagDays: next.lagDays }).where(eq(taskDependencies.id, dependencyId));
      await persistChanges(tx, existing.projectId, actorUserId, r.changes, "manual", lockedChangedIds(g.tasks, r.changes), "Dependency changed");
      await recordAudit(tx, { organizationId: access.organizationId, actorUserId, action: "task.dependency.updated", targetType: "project", targetId: existing.projectId, metadata: { dependencyId, type: next.type, lagDays: next.lagDays } });
      return { changes: r.changes };
    });
  }

  async removeDependency(actorUserId: string, dependencyId: string) {
    const [existing] = await this.db.select().from(taskDependencies).where(eq(taskDependencies.id, dependencyId));
    if (!existing) throw new AppError("NOT_FOUND", "Dependency not found.");
    const { access } = await this.requirePlanEditor(actorUserId, existing.projectId, "full", "Task dependencies");
    await this.db.delete(taskDependencies).where(eq(taskDependencies.id, dependencyId));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "task.dependency.removed", targetType: "project", targetId: existing.projectId, metadata: { dependencyId } });
  }

  // ----- Baselines ---------------------------------------------------------

  async createBaseline(actorUserId: string, projectId: string, input: { name?: string; note?: string }) {
    const access = await this.access(actorUserId, projectId);
    if (!this.can(access, "project.plan.approve")) throw new AppError("FORBIDDEN", "Only an approver can save a schedule baseline.");
    await assertProjectWritable(this.db, projectId);
    await requireTier(this.db, access.organizationId, "full", "Schedule baselines");
    return this.db.transaction(async (tx) => {
      await lockProject(tx, projectId);
      const g = await loadGraph(tx, projectId);
      if (!g.rows.length) throw new AppError("VALIDATION", "Add tasks before saving a baseline.");
      const rolled = rollUp(g.tasks);
      const [m] = await tx.select({ n: max(projectScheduleBaselines.number) }).from(projectScheduleBaselines).where(eq(projectScheduleBaselines.projectId, projectId));
      const number = (m?.n ?? 0) + 1;
      const name = (input.name ?? "").trim().slice(0, 200) || `Baseline ${number}`;
      const [b] = await tx
        .insert(projectScheduleBaselines)
        .values({
          projectId,
          number,
          name,
          note: (input.note ?? "").trim().slice(0, 2000),
          approvedByUserId: actorUserId,
          plannedFinish: rolled.reduce((acc, t) => (t.endDate > acc ? t.endDate : acc), rolled[0]!.endDate),
          taskCount: rolled.length,
        })
        .returning();
      const est = new Map(g.rows.map((r) => [r.id, r.estimateHours]));
      await tx.insert(projectScheduleBaselineItems).values(
        rolled.map((t) => ({ baselineId: b!.id, taskId: t.id, kind: t.kind, title: t.title, startDate: t.startDate, endDate: t.endDate, estimateHours: est.get(t.id) ?? null })),
      );
      await recordAudit(tx, { organizationId: access.organizationId, actorUserId, action: "schedule.baseline.saved", targetType: "project", targetId: projectId, metadata: { number, name, tasks: rolled.length } });
      return b!;
    });
  }

  async listBaselines(actorUserId: string, projectId: string) {
    await this.access(actorUserId, projectId);
    return this.db
      .select({ b: projectScheduleBaselines, approvedBy: userProfiles.displayName })
      .from(projectScheduleBaselines)
      .leftJoin(userProfiles, eq(userProfiles.userId, projectScheduleBaselines.approvedByUserId))
      .where(eq(projectScheduleBaselines.projectId, projectId))
      .orderBy(desc(projectScheduleBaselines.number));
  }

  async baselineItems(actorUserId: string, baselineId: string) {
    const [b] = await this.db.select().from(projectScheduleBaselines).where(eq(projectScheduleBaselines.id, baselineId));
    if (!b) throw new AppError("NOT_FOUND", "Baseline not found.");
    await this.access(actorUserId, b.projectId);
    const items = await this.db.select().from(projectScheduleBaselineItems).where(eq(projectScheduleBaselineItems.baselineId, baselineId));
    return { baseline: b, items };
  }

  // ----- Schedule proposals ------------------------------------------------

  /** Generates a proposed schedule from the project's workflow stages. Nothing changes until approved. */
  async proposeFromWorkflow(actorUserId: string, projectId: string, input: { startDate?: string; submissionDate?: string | null }) {
    const { access } = await this.requirePlanEditor(actorUserId, projectId, "full", "Automatic scheduling");
    const [project] = await this.db.select().from(researchProjects).where(eq(researchProjects.id, projectId));
    const startDate = input.startDate || project!.startDate || (await userToday(this.db, actorUserId));
    const submission = input.submissionDate === undefined ? project!.expectedCompletionDate : input.submissionDate || null;
    if (!isIsoDate(startDate) || (submission && !isIsoDate(submission))) throw new AppError("VALIDATION", "Enter valid dates.");
    const stages = await this.db.select().from(projectStages).where(eq(projectStages.projectId, projectId)).orderBy(asc(projectStages.sortOrder));
    if (!stages.length) throw new AppError("VALIDATION", "Apply a workflow template to this project first.");
    const proposal = wrap(() =>
      proposeSchedule(
        stages.map((s) => ({
          id: s.id,
          key: s.key,
          name: s.iteration > 1 ? `${s.name} (round ${s.iteration})` : s.name,
          nominalDurationDays: s.nominalDurationDays,
          dependsOn: s.dependsOn,
          milestoneName: s.milestoneName,
          include: s.enabled && s.status !== "skipped" && s.status !== "completed",
        })),
        startDate,
        submission,
      ),
    );
    const payload: SchedulePayload = { tasks: proposal.tasks, dependencies: proposal.dependencies, assumptions: proposal.assumptions };
    return this.db.transaction(async (tx) => {
      await tx.update(scheduleProposals).set({ status: "superseded" }).where(and(eq(scheduleProposals.projectId, projectId), eq(scheduleProposals.status, "pending")));
      const [row] = await tx.insert(scheduleProposals).values({ projectId, source: "template", payload, createdByUserId: actorUserId }).returning();
      await recordAudit(tx, { organizationId: access.organizationId, actorUserId, action: "schedule.proposal.created", targetType: "project", targetId: projectId, metadata: { tasks: proposal.tasks.length, finish: proposal.finishDate } });
      return { proposal: row!, finishDate: proposal.finishDate };
    });
  }

  async pendingProposal(actorUserId: string, projectId: string) {
    await this.access(actorUserId, projectId);
    const [p] = await this.db
      .select()
      .from(scheduleProposals)
      .where(and(eq(scheduleProposals.projectId, projectId), eq(scheduleProposals.status, "pending")))
      .orderBy(desc(scheduleProposals.createdAt))
      .limit(1);
    return p ?? null;
  }

  /** Adds the proposed tasks to the plan. Existing tasks are never changed. */
  async approveProposal(actorUserId: string, proposalId: string) {
    const [p] = await this.db.select().from(scheduleProposals).where(eq(scheduleProposals.id, proposalId));
    if (!p) throw new AppError("NOT_FOUND", "Proposal not found.");
    const access = await this.access(actorUserId, p.projectId);
    if (!this.can(access, "project.plan.approve")) throw new AppError("FORBIDDEN", "Only an approver can accept a proposed schedule.");
    await assertProjectWritable(this.db, p.projectId);
    const ent = await requireTier(this.db, access.organizationId, "full", "Automatic scheduling");
    return this.db.transaction(async (tx) => {
      await lockProject(tx, p.projectId);
      const [cur] = await tx.select().from(scheduleProposals).where(eq(scheduleProposals.id, proposalId)).for("update");
      if (cur!.status !== "pending") throw new AppError("CONFLICT", "This proposal has already been decided.");
      const g = await loadGraph(tx, p.projectId);
      if (ent.taskLimit !== null && g.rows.length + p.payload.tasks.length > ent.taskLimit) {
        throw new AppError("QUOTA_EXCEEDED", `Adding ${p.payload.tasks.length} tasks would exceed the ${ent.taskLimit}-task limit of the ${ent.planName} plan.`, { feature: "planning.tasks.max" });
      }
      const validStages = new Set((await tx.select({ id: projectStages.id }).from(projectStages).where(eq(projectStages.projectId, p.projectId))).map((s) => s.id));
      const base = g.rows.filter((r) => !r.parentTaskId).reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
      const ids = new Map<string, string>();
      for (const [i, t] of p.payload.tasks.entries()) {
        const [row] = await tx
          .insert(researchTasks)
          .values({
            projectId: p.projectId,
            stageId: t.stageId && validStages.has(t.stageId) ? t.stageId : null,
            kind: t.kind,
            title: t.title,
            startDate: t.startDate,
            endDate: t.endDate,
            sortOrder: base + i,
            createdByUserId: actorUserId,
          })
          .returning({ id: researchTasks.id });
        ids.set(t.ref, row!.id);
      }
      const newDeps = p.payload.dependencies
        .filter((d) => ids.has(d.predecessorRef) && ids.has(d.successorRef))
        .map((d) => ({ predecessorId: ids.get(d.predecessorRef)!, successorId: ids.get(d.successorRef)!, type: d.type, lagDays: d.lagDays }));
      const allTasks = (await loadGraph(tx, p.projectId)).tasks;
      if (findCycle(allTasks, [...g.planDeps, ...newDeps])) throw new AppError("VALIDATION", "The proposal conflicts with the existing plan.");
      if (newDeps.length) await tx.insert(taskDependencies).values(newDeps.map((d) => ({ ...d, projectId: p.projectId, createdByUserId: actorUserId })));
      for (const t of p.payload.tasks) {
        if (t.kind === "task" && t.stageId && validStages.has(t.stageId)) await tx.update(projectStages).set({ dueDate: t.endDate }).where(eq(projectStages.id, t.stageId));
      }
      await tx.update(scheduleProposals).set({ status: "approved", decidedByUserId: actorUserId, decidedAt: new Date() }).where(eq(scheduleProposals.id, proposalId));
      await recomputeProjectProgress(tx, p.projectId);
      await recordAudit(tx, { organizationId: access.organizationId, actorUserId, action: "schedule.proposal.approved", targetType: "project", targetId: p.projectId, metadata: { proposalId, tasks: ids.size } });
      return { created: ids.size };
    });
  }

  async rejectProposal(actorUserId: string, proposalId: string) {
    const [p] = await this.db.select().from(scheduleProposals).where(eq(scheduleProposals.id, proposalId));
    if (!p) throw new AppError("NOT_FOUND", "Proposal not found.");
    const access = await this.access(actorUserId, p.projectId);
    if (!this.can(access, "project.plan.manage") && !this.can(access, "project.plan.approve")) throw new AppError("FORBIDDEN", "You do not have permission to do that.");
    await this.db
      .update(scheduleProposals)
      .set({ status: "rejected", decidedByUserId: actorUserId, decidedAt: new Date() })
      .where(and(eq(scheduleProposals.id, proposalId), eq(scheduleProposals.status, "pending")));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "schedule.proposal.rejected", targetType: "project", targetId: p.projectId, metadata: { proposalId } });
  }

  // ----- Checklists and comments ------------------------------------------

  private async taskForWork(actorUserId: string, taskId: string) {
    const row = await this.taskRow(taskId);
    const access = await this.access(actorUserId, row.projectId);
    const ok = this.can(access, "project.plan.manage") || (this.can(access, "project.tasks.work") && row.assigneeUserId === actorUserId);
    if (!ok) throw new AppError("FORBIDDEN", "Only the assignee or a planner can change this task.");
    await assertProjectWritable(this.db, row.projectId);
    return { row, access };
  }

  async addChecklistItem(actorUserId: string, taskId: string, text: string) {
    await this.taskForWork(actorUserId, taskId);
    const t = text.trim();
    if (!t || t.length > 500) throw new AppError("VALIDATION", "Checklist items need 1–500 characters.");
    const [m] = await this.db.select({ n: max(taskChecklistItems.sortOrder) }).from(taskChecklistItems).where(eq(taskChecklistItems.taskId, taskId));
    const [row] = await this.db.insert(taskChecklistItems).values({ taskId, text: t, sortOrder: (m?.n ?? -1) + 1 }).returning();
    return row!;
  }

  async setChecklistItem(actorUserId: string, itemId: string, done: boolean) {
    const [item] = await this.db.select().from(taskChecklistItems).where(eq(taskChecklistItems.id, itemId));
    if (!item) throw new AppError("NOT_FOUND", "Checklist item not found.");
    await this.taskForWork(actorUserId, item.taskId);
    await this.db.update(taskChecklistItems).set({ done }).where(eq(taskChecklistItems.id, itemId));
  }

  async removeChecklistItem(actorUserId: string, itemId: string) {
    const [item] = await this.db.select().from(taskChecklistItems).where(eq(taskChecklistItems.id, itemId));
    if (!item) throw new AppError("NOT_FOUND", "Checklist item not found.");
    await this.taskForWork(actorUserId, item.taskId);
    await this.db.delete(taskChecklistItems).where(eq(taskChecklistItems.id, itemId));
  }

  async addComment(actorUserId: string, taskId: string, body: string) {
    const row = await this.taskRow(taskId);
    const access = await this.access(actorUserId, row.projectId);
    if (!["project.plan.manage", "project.tasks.work", "project.review"].some((p) => this.can(access, p))) throw new AppError("FORBIDDEN", "You cannot comment on this project's tasks.");
    await assertProjectWritable(this.db, row.projectId);
    const b = body.trim();
    if (!b || b.length > 5000) throw new AppError("VALIDATION", "Comments need 1–5,000 characters.");
    const [c] = await this.db.insert(taskComments).values({ taskId, authorUserId: actorUserId, body: b }).returning();
    return c!;
  }

  // ----- Resource assignments ---------------------------------------------

  async setAssignment(actorUserId: string, taskId: string, userId: string, allocationPercent: number) {
    const row = await this.taskRow(taskId);
    await this.requirePlanEditor(actorUserId, row.projectId, "full", "Resource assignments");
    if (!Number.isInteger(allocationPercent) || allocationPercent < 1 || allocationPercent > 100) throw new AppError("VALIDATION", "Allocation must be between 1% and 100%.");
    await assertMemberCanAccess(this.db, userId, row.projectId, "The person");
    await this.db
      .insert(projectResourceAssignments)
      .values({ projectId: row.projectId, taskId, userId, allocationPercent })
      .onConflictDoUpdate({ target: [projectResourceAssignments.taskId, projectResourceAssignments.userId], set: { allocationPercent } });
  }

  async removeAssignment(actorUserId: string, taskId: string, userId: string) {
    const row = await this.taskRow(taskId);
    await this.requirePlanEditor(actorUserId, row.projectId, "full", "Resource assignments");
    await this.db.delete(projectResourceAssignments).where(and(eq(projectResourceAssignments.taskId, taskId), eq(projectResourceAssignments.userId, userId)));
  }

  // ----- Risks -------------------------------------------------------------

  async listRisks(actorUserId: string, projectId: string) {
    await this.access(actorUserId, projectId);
    return this.db
      .select({ risk: projectRisks, ownerName: userProfiles.displayName })
      .from(projectRisks)
      .leftJoin(userProfiles, eq(userProfiles.userId, projectRisks.ownerUserId))
      .where(eq(projectRisks.projectId, projectId))
      .orderBy(desc(sql`${projectRisks.likelihood} * ${projectRisks.impact}`), asc(projectRisks.createdAt));
  }

  private async checkRiskRefs(projectId: string, data: { ownerUserId: string | null; taskId: string | null }) {
    await assertMemberCanAccess(this.db, data.ownerUserId, projectId, "The risk owner");
    if (data.taskId) {
      const [t] = await this.db.select({ id: researchTasks.id }).from(researchTasks).where(and(eq(researchTasks.id, data.taskId), eq(researchTasks.projectId, projectId)));
      if (!t) throw new AppError("VALIDATION", "The linked task does not belong to this project.");
    }
  }

  async createRisk(actorUserId: string, projectId: string, input: unknown) {
    const data = parse(riskSchema, input);
    const { access } = await this.requirePlanEditor(actorUserId, projectId, "full", "The risk register");
    await this.checkRiskRefs(projectId, data);
    const [row] = await this.db.insert(projectRisks).values({ ...data, projectId, createdByUserId: actorUserId }).returning();
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "risk.created", targetType: "project", targetId: projectId, metadata: { riskId: row!.id } });
    return row!;
  }

  async updateRisk(actorUserId: string, riskId: string, input: unknown) {
    const [r] = await this.db.select().from(projectRisks).where(eq(projectRisks.id, riskId));
    if (!r) throw new AppError("NOT_FOUND", "Risk not found.");
    const data = parse(riskSchema, input);
    const { access } = await this.requirePlanEditor(actorUserId, r.projectId, "full", "The risk register");
    await this.checkRiskRefs(r.projectId, data);
    await this.db.update(projectRisks).set({ ...data, updatedAt: new Date() }).where(eq(projectRisks.id, riskId));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "risk.updated", targetType: "project", targetId: r.projectId, metadata: { riskId, status: data.status } });
  }

  async deleteRisk(actorUserId: string, riskId: string) {
    const [r] = await this.db.select().from(projectRisks).where(eq(projectRisks.id, riskId));
    if (!r) throw new AppError("NOT_FOUND", "Risk not found.");
    const { access } = await this.requirePlanEditor(actorUserId, r.projectId, "full", "The risk register");
    await this.db.delete(projectRisks).where(eq(projectRisks.id, riskId));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "risk.deleted", targetType: "project", targetId: r.projectId, metadata: { riskId, title: r.title } });
  }

  // ----- Calendar events ---------------------------------------------------

  async listEvents(actorUserId: string, projectId: string, from?: string, to?: string) {
    await this.access(actorUserId, projectId);
    const rows = await this.db.select().from(projectCalendarEvents).where(eq(projectCalendarEvents.projectId, projectId)).orderBy(asc(projectCalendarEvents.startDate));
    return rows.filter((e) => (!from || e.endDate >= from) && (!to || e.startDate <= to));
  }

  async createEvent(actorUserId: string, projectId: string, input: unknown) {
    const data = parse(eventSchema, input);
    const { access } = await this.requirePlanEditor(actorUserId, projectId, "full", "Calendar events");
    const [row] = await this.db.insert(projectCalendarEvents).values({ ...data, projectId, createdByUserId: actorUserId }).returning();
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "calendar.event.created", targetType: "project", targetId: projectId, metadata: { eventId: row!.id } });
    return row!;
  }

  async deleteEvent(actorUserId: string, eventId: string) {
    const [e] = await this.db.select().from(projectCalendarEvents).where(eq(projectCalendarEvents.id, eventId));
    if (!e) throw new AppError("NOT_FOUND", "Event not found.");
    await this.requirePlanEditor(actorUserId, e.projectId, "full", "Calendar events");
    await this.db.delete(projectCalendarEvents).where(eq(projectCalendarEvents.id, eventId));
  }

  // ----- Time tracking -----------------------------------------------------

  async logTime(actorUserId: string, projectId: string, input: unknown) {
    const data = parse(timeSchema, input);
    const access = await this.access(actorUserId, projectId);
    await assertProjectWritable(this.db, projectId);
    await requireTier(this.db, access.organizationId, "full", "Time tracking");
    const canManage = this.can(access, "project.plan.manage");
    if (!canManage && !this.can(access, "project.tasks.work")) throw new AppError("FORBIDDEN", "You cannot log time on this project.");
    if (data.taskId) {
      const [t] = await this.db.select().from(researchTasks).where(and(eq(researchTasks.id, data.taskId), eq(researchTasks.projectId, projectId)));
      if (!t) throw new AppError("VALIDATION", "The task does not belong to this project.");
      if (!canManage && t.assigneeUserId !== actorUserId) throw new AppError("FORBIDDEN", "You can only log time on tasks assigned to you.");
    }
    const today = await userToday(this.db, actorUserId);
    if (data.entryDate > addDays(today, 1)) throw new AppError("VALIDATION", "Time can't be logged for future dates.");
    const [row] = await this.db.insert(researchTimeEntries).values({ ...data, projectId, userId: actorUserId }).returning();
    return row!;
  }

  async deleteTime(actorUserId: string, entryId: string) {
    const [e] = await this.db.select().from(researchTimeEntries).where(eq(researchTimeEntries.id, entryId));
    if (!e) throw new AppError("NOT_FOUND", "Time entry not found.");
    const access = await this.access(actorUserId, e.projectId);
    if (e.userId !== actorUserId && !this.can(access, "project.plan.manage")) throw new AppError("FORBIDDEN", "You can only delete your own time entries.");
    await assertProjectWritable(this.db, e.projectId);
    await this.db.delete(researchTimeEntries).where(eq(researchTimeEntries.id, entryId));
  }

  async listTime(actorUserId: string, projectId: string) {
    await this.access(actorUserId, projectId);
    const rows = await this.db
      .select({ e: researchTimeEntries, name: userProfiles.displayName, taskTitle: researchTasks.title })
      .from(researchTimeEntries)
      .leftJoin(userProfiles, eq(userProfiles.userId, researchTimeEntries.userId))
      .leftJoin(researchTasks, eq(researchTasks.id, researchTimeEntries.taskId))
      .where(eq(researchTimeEntries.projectId, projectId))
      .orderBy(desc(researchTimeEntries.entryDate), desc(researchTimeEntries.createdAt));
    const byCategory: Record<string, number> = {};
    for (const r of rows) byCategory[r.e.category] = (byCategory[r.e.category] ?? 0) + r.e.minutes;
    return { rows, byCategory, totalMinutes: rows.reduce((a, r) => a + r.e.minutes, 0) };
  }

  // ----- People ------------------------------------------------------------

  async namesFor(userIds: (string | null)[]) {
    const ids = [...new Set(userIds.filter((x): x is string => !!x))];
    if (!ids.length) return new Map<string, string>();
    const rows = await this.db.select({ id: userProfiles.userId, name: userProfiles.displayName }).from(userProfiles).where(inArray(userProfiles.userId, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}

/** Weekly workload per person, as % of one full-time person (100 = fully booked). */
export function workload(
  tasks: (PlanTask & { assigneeUserId: string | null })[],
  assignments: { taskId: string; userId: string; allocationPercent: number }[],
  fromIso: string,
  weeks: number,
) {
  const start = toDay(fromIso);
  // Align to Monday (1970-01-01 was a Thursday, day 0 → weekday index 3).
  const monday = start - ((start + 3) % 7);
  const isSummary = new Set(tasks.filter((t) => t.parentId).map((t) => t.parentId!));
  const people = new Map<string, number[]>();
  for (const t of tasks) {
    if (isSummary.has(t.id) || t.kind === "milestone" || t.status === "done" || t.status === "cancelled") continue;
    const own = assignments.filter((a) => a.taskId === t.id);
    const alloc = own.length ? own.map((a) => [a.userId, a.allocationPercent] as const) : t.assigneeUserId ? [[t.assigneeUserId, 100] as const] : [];
    const s = toDay(t.startDate);
    const f = toDay(t.endDate) + 1;
    for (const [user, pct] of alloc) {
      if (!people.has(user)) people.set(user, Array(weeks).fill(0));
      const row = people.get(user)!;
      for (let w = 0; w < weeks; w++) {
        const ws = monday + w * 7;
        const overlap = Math.max(0, Math.min(f, ws + 7) - Math.max(s, ws));
        row[w]! += (pct * overlap) / 7;
      }
    }
  }
  const weekStarts = Array.from({ length: weeks }, (_, w) => monday + w * 7);
  return {
    weekStarts: weekStarts.map((d) => new Date(d * 86_400_000).toISOString().slice(0, 10)),
    rows: [...people].map(([userId, load]) => ({ userId, load: load.map((x) => Math.round(x)) })),
  };
}
