"use server";

import { recomputeProjectProgress } from "@researchmate/planning";
import { AppError, isAppError, logger } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type FormState, handle, str } from "../form";
import { contentService, db, memberService, planningService, projectService, workflowService } from "../services";
import { requireSession } from "../session";

const opt = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" ? v : undefined;
};
const bool = (form: FormData, k: string) => form.get(k) === "on" || form.get(k) === "true";
const refresh = (projectId: string) => revalidatePath(`/app/projects/${projectId}`, "layout");

// ---------------------------------------------------------------------------
// JSON actions used by the interactive Gantt chart and board
// ---------------------------------------------------------------------------

export type PlanActionResult =
  | { ok: true; changes: { id: string; title: string; startDate: string; endDate: string; reason: string }[]; message?: string }
  | { ok: false; error: string; code: string; locked?: boolean };

async function jsonAction(fn: () => Promise<PlanActionResult>): Promise<PlanActionResult> {
  try {
    return await fn();
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.message, code: err.code, locked: err.details?.planning === "LOCKED" };
    logger.error("plan_action.failed", { error: err instanceof Error ? err.stack : String(err) });
    return { ok: false, error: "Something went wrong on our side. Please try again.", code: "INTERNAL" };
  }
}

/** Gantt drag / resize / keyboard move. Validated and cascaded on the server. */
export async function ganttMoveAction(input: { taskId: string; startDate: string; endDate: string; version: number; confirmLocked?: boolean; reason?: string }): Promise<PlanActionResult> {
  return jsonAction(async () => {
    const s = await requireSession();
    const r = await planningService().updateTask(
      s.user.id,
      input.taskId,
      { startDate: input.startDate, endDate: input.endDate },
      { expectedVersion: input.version, confirmLockedChange: !!input.confirmLocked, source: "gantt", reason: input.reason },
    );
    refresh(r.task.projectId);
    return { ok: true, changes: r.changes.map((c) => ({ id: c.id, title: c.title, startDate: c.startDate, endDate: c.endDate, reason: c.reason })) };
  });
}

export async function boardStatusAction(input: { taskId: string; status: string }): Promise<PlanActionResult> {
  return jsonAction(async () => {
    const s = await requireSession();
    const r = await planningService().updateTask(s.user.id, input.taskId, { status: input.status });
    refresh(r.task.projectId);
    return { ok: true, changes: [], message: r.message };
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function taskFields(form: FormData) {
  return {
    title: opt(form, "title"),
    kind: opt(form, "kind"),
    description: opt(form, "description"),
    startDate: opt(form, "startDate"),
    endDate: opt(form, "endDate") || undefined,
    parentTaskId: opt(form, "parentTaskId"),
    stageId: opt(form, "stageId"),
    assigneeUserId: opt(form, "assigneeUserId"),
    priority: opt(form, "priority"),
    estimateHours: opt(form, "estimateHours") || null,
    requiresCompletionApproval: bool(form, "requiresCompletionApproval"),
  };
}

export async function createTaskAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const r = await planningService().createTask(s.user.id, projectId, taskFields(form));
    refresh(projectId);
    const moved = r.changes.filter((c) => c.id !== r.task.id).length;
    return { success: `Added “${r.task.title}”.${moved ? ` ${moved} other item(s) moved to keep dependencies valid.` : ""}` };
  });
}

/** Saves the task form. Only fields that actually changed are sent, so assistants can update progress without touching plan fields. */
export async function updateTaskAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const taskId = str(form, "taskId");
    const { task } = await planningService().getTask(s.user.id, taskId);
    const next: Record<string, unknown> = {
      title: opt(form, "title"),
      description: opt(form, "description"),
      startDate: opt(form, "startDate"),
      endDate: task.kind === "milestone" ? opt(form, "startDate") : opt(form, "endDate"),
      parentTaskId: form.has("parentTaskId") ? str(form, "parentTaskId") || null : undefined,
      stageId: form.has("stageId") ? str(form, "stageId") || null : undefined,
      assigneeUserId: form.has("assigneeUserId") ? str(form, "assigneeUserId") || null : undefined,
      priority: opt(form, "priority"),
      status: opt(form, "status"),
      progressPercent: opt(form, "progressPercent") !== undefined ? Number(opt(form, "progressPercent")) : undefined,
      estimateHours: form.has("estimateHours") ? (str(form, "estimateHours") === "" ? null : Number(str(form, "estimateHours"))) : undefined,
      actualStartDate: form.has("actualStartDate") ? str(form, "actualStartDate") || null : undefined,
      actualEndDate: form.has("actualEndDate") ? str(form, "actualEndDate") || null : undefined,
      requiresCompletionApproval: form.has("planFields") ? bool(form, "requiresCompletionApproval") : undefined,
      deadlineLocked: form.has("approverFields") ? bool(form, "deadlineLocked") : undefined,
    };
    const current = task as unknown as Record<string, unknown>;
    const changed = Object.fromEntries(
      Object.entries(next).filter(([k, v]) => v !== undefined && String(current[k] ?? "") !== String(v ?? "") && !(k === "estimateHours" && Number(current[k] ?? NaN) === Number(v))),
    );
    if (!Object.keys(changed).length) return { success: "No changes to save." };
    const r = await planningService().updateTask(s.user.id, taskId, changed, {
      expectedVersion: Number(str(form, "version")) || undefined,
      confirmLockedChange: bool(form, "confirmLockedChange"),
      reason: opt(form, "reason"),
    });
    refresh(task.projectId);
    const moved = r.changes.filter((c) => c.id !== taskId);
    return { success: [r.message ?? "Task saved.", moved.length ? `Also moved: ${moved.map((m) => `“${m.title}”`).join(", ")}.` : ""].filter(Boolean).join(" ") };
  });
}

export async function deleteTaskAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    await planningService().deleteTask(s.user.id, str(form, "taskId"));
    refresh(projectId);
    if (str(form, "redirect")) redirect(`/app/projects/${projectId}/tasks`);
    return { success: "Task deleted." };
  });
}

export async function moveTaskOrderAction(form: FormData): Promise<void> {
  const s = await requireSession();
  await planningService().moveTask(s.user.id, str(form, "taskId"), str(form, "direction") === "up" ? "up" : "down");
  refresh(str(form, "projectId"));
}

export async function approveCompletionAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    await planningService().approveCompletion(s.user.id, str(form, "taskId"));
    refresh(str(form, "projectId"));
    return { success: "Completion approved." };
  });
}

// Dependencies

export async function addDependencyAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const taskId = str(form, "taskId");
    const other = str(form, "otherTaskId");
    const direction = str(form, "direction"); // "predecessor": other → task ; "successor": task → other
    const dep = direction === "successor" ? { predecessorId: taskId, successorId: other } : { predecessorId: other, successorId: taskId };
    const r = await planningService().addDependency(s.user.id, projectId, { ...dep, type: str(form, "type") || "FS", lagDays: str(form, "lagDays") || "0" }, { confirmLockedChange: bool(form, "confirmLockedChange") });
    refresh(projectId);
    return { success: `Dependency added.${r.changes.length ? ` Moved to fit: ${r.changes.map((c) => `“${c.title}”`).join(", ")}.` : ""}` };
  });
}

export async function updateDependencyAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const r = await planningService().updateDependency(s.user.id, str(form, "dependencyId"), { type: str(form, "type"), lagDays: str(form, "lagDays") });
    refresh(str(form, "projectId"));
    return { success: `Dependency updated.${r.changes.length ? ` Moved: ${r.changes.map((c) => `“${c.title}”`).join(", ")}.` : ""}` };
  });
}

export async function removeDependencyAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    await planningService().removeDependency(s.user.id, str(form, "dependencyId"));
    refresh(str(form, "projectId"));
    return { success: "Dependency removed." };
  });
}

// Checklist, comments, assignments

export async function checklistAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const intent = str(form, "intent");
    if (intent === "add") await planningService().addChecklistItem(s.user.id, str(form, "taskId"), str(form, "text"));
    else if (intent === "remove") await planningService().removeChecklistItem(s.user.id, str(form, "itemId"));
    else await planningService().setChecklistItem(s.user.id, str(form, "itemId"), intent === "check");
    refresh(str(form, "projectId"));
    return intent === "add" ? { success: "Added." } : {};
  });
}

export async function commentAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    await planningService().addComment(s.user.id, str(form, "taskId"), str(form, "body"));
    refresh(str(form, "projectId"));
    return { success: "Comment posted." };
  });
}

export async function assignmentAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    if (str(form, "intent") === "remove") await planningService().removeAssignment(s.user.id, str(form, "taskId"), str(form, "userId"));
    else await planningService().setAssignment(s.user.id, str(form, "taskId"), str(form, "userId"), Number(str(form, "allocationPercent")));
    refresh(str(form, "projectId"));
    return { success: "Resources updated." };
  });
}

// ---------------------------------------------------------------------------
// Schedule: baselines and proposals
// ---------------------------------------------------------------------------

export async function baselineAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const b = await planningService().createBaseline(s.user.id, projectId, { name: str(form, "name"), note: str(form, "note") });
    refresh(projectId);
    return { success: `Saved “${b.name}”. Earlier baselines are kept unchanged.` };
  });
}

export async function proposeScheduleAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    await planningService().proposeFromWorkflow(s.user.id, projectId, { startDate: str(form, "startDate") || undefined, submissionDate: form.has("submissionDate") ? str(form, "submissionDate") || null : undefined });
    refresh(projectId);
    return { success: "Proposed schedule ready for review below. Nothing has been added to the plan yet." };
  });
}

export async function decideProposalAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    if (str(form, "decision") === "approve") {
      const r = await planningService().approveProposal(s.user.id, str(form, "proposalId"));
      refresh(projectId);
      return { success: `Added ${r.created} tasks and milestones to the plan.` };
    }
    await planningService().rejectProposal(s.user.id, str(form, "proposalId"));
    refresh(projectId);
    return { success: "Proposal discarded." };
  });
}

// ---------------------------------------------------------------------------
// Risks, events, time
// ---------------------------------------------------------------------------

function riskFields(form: FormData) {
  return {
    title: str(form, "title"),
    description: str(form, "description"),
    category: str(form, "category"),
    likelihood: str(form, "likelihood"),
    impact: str(form, "impact"),
    status: str(form, "status") || "open",
    ownerUserId: str(form, "ownerUserId"),
    mitigation: str(form, "mitigation"),
    contingency: str(form, "contingency"),
    taskId: str(form, "taskId"),
    reviewDate: str(form, "reviewDate"),
  };
}

export async function riskAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const intent = str(form, "intent");
    if (intent === "delete") await planningService().deleteRisk(s.user.id, str(form, "riskId"));
    else if (intent === "update") await planningService().updateRisk(s.user.id, str(form, "riskId"), riskFields(form));
    else await planningService().createRisk(s.user.id, projectId, riskFields(form));
    refresh(projectId);
    return { success: intent === "delete" ? "Risk removed." : intent === "update" ? "Risk saved." : "Risk added." };
  });
}

export async function eventAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    if (str(form, "intent") === "delete") await planningService().deleteEvent(s.user.id, str(form, "eventId"));
    else
      await planningService().createEvent(s.user.id, projectId, {
        title: str(form, "title"),
        kind: str(form, "kind"),
        startDate: str(form, "startDate"),
        endDate: str(form, "endDate") || null,
        startTime: str(form, "startTime") || null,
        location: str(form, "location"),
        notes: str(form, "notes"),
      });
    refresh(projectId);
    return { success: str(form, "intent") === "delete" ? "Event removed." : "Event added." };
  });
}

export async function timeAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    if (str(form, "intent") === "delete") {
      await planningService().deleteTime(s.user.id, str(form, "entryId"));
      refresh(projectId);
      return { success: "Entry removed." };
    }
    const hours = Number(str(form, "hours") || 0);
    const minutes = Math.round(hours * 60) + Number(str(form, "minutes") || 0);
    await planningService().logTime(s.user.id, projectId, { taskId: str(form, "taskId"), entryDate: str(form, "entryDate"), minutes, category: str(form, "category"), note: str(form, "note") });
    refresh(projectId);
    return { success: "Time logged." };
  });
}

// ---------------------------------------------------------------------------
// Workflow stages
// ---------------------------------------------------------------------------

export async function applyTemplateAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const r = await workflowService().applyTemplate(s.user.id, projectId, str(form, "templateKey"));
    refresh(projectId);
    return { success: `Applied “${r.template.name}” (${r.stageCount} stages).` };
  });
}

export async function addStageAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    await workflowService().addStage(s.user.id, projectId, { name: str(form, "name"), purpose: str(form, "purpose"), nominalDurationDays: Number(str(form, "nominalDurationDays") || 7) });
    refresh(projectId);
    return { success: "Stage added." };
  });
}

export async function updateStageAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    await workflowService().updateStage(s.user.id, str(form, "stageId"), {
      name: str(form, "name"),
      purpose: str(form, "purpose"),
      requiredInputs: str(form, "requiredInputs"),
      expectedOutputs: str(form, "expectedOutputs"),
      completionCriteria: str(form, "completionCriteria"),
      nominalDurationDays: str(form, "nominalDurationDays"),
      approvalRequired: bool(form, "approvalRequired"),
      optional: bool(form, "optional"),
      responsibleUserId: str(form, "responsibleUserId"),
      dueDate: str(form, "dueDate"),
    });
    refresh(str(form, "projectId"));
    return { success: "Stage saved." };
  });
}

export async function stageControlAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const stageId = str(form, "stageId");
    const intent = str(form, "intent");
    const wf = workflowService();
    if (intent === "up" || intent === "down") await wf.moveStage(s.user.id, stageId, intent);
    else if (intent === "repeat") await wf.repeatStage(s.user.id, stageId);
    else if (intent === "enable" || intent === "disable") await wf.updateStage(s.user.id, stageId, { enabled: intent === "enable" });
    else if (["start", "complete", "approve", "request_changes", "skip", "reopen"].includes(intent)) await wf.transition(s.user.id, stageId, intent as never, str(form, "note") || undefined);
    else throw new AppError("VALIDATION", "Unknown action.");
    refresh(str(form, "projectId"));
    return {};
  });
}

// ---------------------------------------------------------------------------
// Research content
// ---------------------------------------------------------------------------

export async function researchItemAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const kind = str(form, "kind") as "question" | "objective" | "hypothesis";
    if (!["question", "objective", "hypothesis"].includes(kind)) throw new AppError("VALIDATION", "Unknown item.");
    const intent = str(form, "intent");
    const svc = contentService();
    const fields =
      kind === "question"
        ? { kind: str(form, "questionKind") || "specific", text: str(form, "text") }
        : kind === "objective"
          ? { kind: str(form, "objectiveKind") || "specific", text: str(form, "text"), questionId: str(form, "questionId") }
          : { nullHypothesis: str(form, "nullHypothesis"), alternativeHypothesis: str(form, "alternativeHypothesis"), questionId: str(form, "questionId") };
    if (intent === "remove") await svc.remove(s.user.id, kind, str(form, "id"));
    else if (intent === "up" || intent === "down") await svc.move(s.user.id, kind, str(form, "id"), intent);
    else if (intent === "update") await svc.update(s.user.id, kind, str(form, "id"), fields);
    else if (kind === "question") await svc.addQuestion(s.user.id, projectId, fields);
    else if (kind === "objective") await svc.addObjective(s.user.id, projectId, fields);
    else await svc.addHypothesis(s.user.id, projectId, fields);
    refresh(projectId);
    return intent === "add" || !intent ? { success: "Added." } : intent === "update" ? { success: "Saved." } : {};
  });
}

// ---------------------------------------------------------------------------
// Team and progress mode
// ---------------------------------------------------------------------------

export async function projectMemberAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    if (str(form, "intent") === "remove") await memberService().remove(s.user.id, projectId, str(form, "userId"));
    else await memberService().add(s.user.id, projectId, str(form, "userId"), str(form, "roleKey"));
    refresh(projectId);
    return { success: "Team updated." };
  });
}

export async function progressSourceAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const source = str(form, "progressSource") === "manual" ? "manual" : "tasks";
    await projectService().update(s.user.id, projectId, { progressSource: source, ...(source === "manual" ? { progressPercent: str(form, "progressPercent") || undefined } : {}) });
    if (source === "tasks") await recomputeProjectProgress(db(), projectId);
    refresh(projectId);
    return { success: source === "tasks" ? "Progress now follows your tasks." : "Progress saved." };
  });
}
