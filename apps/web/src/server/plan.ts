import { projectStages, researchProjects } from "@researchmate/database";
import { criticalPath, forecast, isLateStart, isOverdue, rollUp, summaryProgress, TaskTree } from "@researchmate/planning";
import { isAppError } from "@researchmate/shared";
import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { cache } from "react";
import { db, planningService, projectService } from "./services";
import { requireSession } from "./session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loads a project for a page, mapping "not found / no access" to a 404. */
export const loadProject = cache(async (projectId: string) => {
  const session = await requireSession();
  if (!UUID.test(projectId)) notFound();
  try {
    const { project, access } = await projectService().get(session.user.id, projectId);
    const can = (perm: string) => access.permissions.has(perm as never);
    return { session, project, access, can, archived: project.status === "archived" };
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
});

export interface ViewTask {
  id: string;
  wbs: string;
  depth: number;
  title: string;
  kind: "task" | "milestone";
  isSummary: boolean;
  parentId: string | null;
  startDate: string;
  endDate: string;
  progress: number;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
  stageId: string | null;
  stageName: string | null;
  critical: boolean;
  floatDays: number | null;
  overdue: boolean;
  lateStart: boolean;
  forecastEnd: string | null;
  locked: boolean;
  version: number;
  actualStartDate: string | null;
  actualEndDate: string | null;
  estimateHours: number | null;
}

/** Everything the planning views need, computed once per request. */
export const loadPlanView = cache(async (projectId: string) => {
  const base = await loadProject(projectId);
  const plan = await planningService().getPlan(base.session.user.id, projectId);
  const stages = await db().select({ id: projectStages.id, name: projectStages.name, iteration: projectStages.iteration }).from(projectStages).where(eq(projectStages.projectId, projectId)).orderBy(asc(projectStages.sortOrder));
  const stageName = new Map(stages.map((s) => [s.id, s.iteration > 1 ? `${s.name} (round ${s.iteration})` : s.name]));
  const names = await planningService().namesFor(plan.rows.map((r) => r.assigneeUserId));

  const rolled = new Map(rollUp(plan.tasks).map((t) => [t.id, t]));
  const tree = new TaskTree(plan.tasks);
  const outline = tree.outline();
  const sprog = summaryProgress(plan.tasks);
  const cp = plan.tasks.length ? criticalPath(plan.tasks, plan.planDeps) : null;
  const fc = plan.tasks.length ? forecast(plan.tasks, plan.planDeps, plan.today) : null;
  const rowById = new Map(plan.rows.map((r) => [r.id, r]));

  const tasks: ViewTask[] = outline.map(({ id, depth, wbs }) => {
    const r = rowById.get(id)!;
    const t = rolled.get(id)!;
    const isSummary = tree.isSummary(id);
    return {
      id,
      wbs,
      depth,
      title: r.title,
      kind: r.kind as ViewTask["kind"],
      isSummary,
      parentId: r.parentTaskId,
      startDate: t.startDate,
      endDate: t.endDate,
      progress: isSummary ? (sprog.get(id) ?? 0) : r.status === "done" ? 100 : r.progressPercent,
      status: r.status,
      priority: r.priority,
      assigneeUserId: r.assigneeUserId,
      assigneeName: r.assigneeUserId ? (names.get(r.assigneeUserId) ?? "Former member") : null,
      stageId: r.stageId,
      stageName: r.stageId ? (stageName.get(r.stageId) ?? null) : null,
      critical: cp?.critical.has(id) ?? false,
      floatDays: cp?.floatDays.get(id) ?? null,
      overdue: !isSummary && isOverdue(t, plan.today),
      lateStart: !isSummary && isLateStart({ ...t, actualStartDate: r.actualStartDate }, plan.today),
      forecastEnd: fc?.dates.get(id)?.endDate ?? null,
      locked: r.deadlineLocked,
      version: r.version,
      actualStartDate: r.actualStartDate,
      actualEndDate: r.actualEndDate,
      estimateHours: r.estimateHours,
    };
  });

  const [project] = await db().select({ expected: researchProjects.expectedCompletionDate }).from(researchProjects).where(eq(researchProjects.id, projectId));
  return {
    ...base,
    plan,
    tasks,
    stages: stages.map((s) => ({ id: s.id, name: stageName.get(s.id)! })),
    deps: plan.deps,
    today: plan.today,
    tier: plan.entitlement.tier,
    taskLimit: plan.entitlement.taskLimit,
    planName: plan.entitlement.planName,
    projectFinish: cp?.projectFinish ?? null,
    estimatedCompletion: fc?.estimatedCompletion ?? null,
    expectedCompletion: project?.expected ?? null,
    canPlan: base.can("project.plan.manage") && !base.archived,
    canApprove: base.can("project.plan.approve") && !base.archived,
  };
});

export type PlanView = Awaited<ReturnType<typeof loadPlanView>>;
