import { isAppError } from "@researchmate/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { ConfirmAction } from "@/components/client-bits";
import { DEP_TYPE_LABELS, Flag, formatMinutes, PRIORITY_LABELS, TASK_STATUS_LABELS, TaskStatusTag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  addDependencyAction,
  approveCompletionAction,
  assignmentAction,
  checklistAction,
  commentAction,
  deleteTaskAction,
  removeDependencyAction,
  updateTaskAction,
} from "@/server/actions/planning";
import { loadPlanView } from "@/server/plan";
import { financeService, memberService, planningService } from "@/server/services";
import { estimateAction } from "@/server/actions/finance";
import { formatMoney, toDecimalString } from "@researchmate/finance/money";

export const metadata = { title: "Task" };

const SOURCE_LABELS: Record<string, string> = {
  manual: "Edited",
  gantt: "Moved on the Gantt chart",
  cascade: "Moved to keep a dependency valid",
  rollup: "Follows its subtasks",
  proposal: "From an approved proposal",
  locked_override: "Approved deadline moved by an approver",
};

export default async function TaskPage({ params }: { params: Promise<{ projectId: string; taskId: string }> }) {
  const { projectId, taskId } = await params;
  const v = await loadPlanView(projectId);
  const uid = v.session.user.id;
  let detail;
  try {
    detail = await planningService().getTask(uid, taskId);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (detail.task.projectId !== projectId) notFound();
  const t = detail.task;
  const view = v.tasks.find((x) => x.id === taskId)!;
  const people = await memberService().assignable(uid, projectId);
  const fs = await financeService().getSettings(uid, projectId);
  const financeOn = !!fs.settings?.enabled && fs.canRead;
  const [estimates, categories] = financeOn
    ? await Promise.all([financeService().listEstimates(uid, projectId).then((e) => e.filter((x) => x.taskId === taskId)), financeService().categories(v.project.organizationId)])
    : [[], []];
  const canEstimate = financeOn && fs.entitled && v.can("finance.manage") && !v.archived;
  const titleOf = new Map(v.tasks.map((x) => [x.id, `${x.wbs} ${x.title}`]));
  const names = new Map(people.map((p) => [p.userId, p.displayName]));
  const full = v.tier === "full";
  const canPlan = v.canPlan;
  const canWork = canPlan || (v.can("project.tasks.work") && t.assigneeUserId === uid && !v.archived);
  const canComment = !v.archived && (canPlan || v.can("project.tasks.work") || v.can("project.review"));
  const descendants = new Set<string>();
  const collect = (id: string) => v.tasks.filter((x) => x.parentId === id).forEach((c) => (descendants.add(c.id), collect(c.id)));
  collect(taskId);
  const parentOptions = v.tasks.filter((x) => x.kind === "task" && x.id !== taskId && !descendants.has(x.id));
  const linked = new Set([taskId, ...detail.predecessors.map((d) => d.predecessorId), ...detail.successors.map((d) => d.successorId)]);
  const depCandidates = v.tasks.filter((x) => !linked.has(x.id) && !descendants.has(x.id));
  const hidden = (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
    </>
  );

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm">
            <Link href={`/app/projects/${projectId}/tasks`} className="text-graphite">Tasks</Link> <span className="text-graphite">/ {view.wbs}</span>
          </p>
          <h2 className="mt-1 text-2xl">
            {t.kind === "milestone" ? "◆ " : ""}
            {t.title}
          </h2>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-graphite">
            <TaskStatusTag status={t.status} />
            {view.isSummary ? "Summary task · " : ""}
            {t.kind === "milestone" ? formatDate(view.startDate) : `${formatDate(view.startDate)} – ${formatDate(view.endDate)}`}
            {view.overdue && <Flag kind="overdue" />}
            {view.critical && full && t.status !== "done" && <Flag kind="critical" />}
            {t.deadlineLocked && <Flag kind="locked" />}
          </p>
        </div>
        {canPlan && (!t.deadlineLocked || v.canApprove) && (
          <ConfirmAction action={deleteTaskAction} fields={{ projectId, taskId, redirect: "1" }} label="Delete" confirmText={`Delete “${t.title}”${view.isSummary ? " and all its subtasks" : ""}? Baselines keep their record of it.`} />
        )}
      </div>

      {t.status === "in_review" && t.requiresCompletionApproval && (
        <div className="mb-8 flex flex-wrap items-center gap-3 rounded-md border border-amber/30 bg-amber-wash px-4 py-3 text-sm">
          <span>Marked complete and waiting for approval.</span>
          {v.canApprove && (
            <ActionForm action={approveCompletionAction} submitLabel="Approve completion" className="flex gap-2">
              {hidden}
            </ActionForm>
          )}
        </div>
      )}

      <Section title="Details">
        {canWork || v.canApprove ? (
          <div className="max-w-3xl">
            <ActionForm action={updateTaskAction} submitLabel="Save" pendingLabel="Saving…" className="grid gap-5">
              {hidden}
              <input type="hidden" name="version" value={t.version} />
              {canPlan && (
                <>
                  <input type="hidden" name="planFields" value="1" />
                  <Field label="Title" name="title" defaultValue={t.title} required maxLength={300} />
                  <div className="field">
                    <label htmlFor="f-description">Description</label>
                    <textarea id="f-description" name="description" className="input" defaultValue={t.description} maxLength={10000} />
                  </div>
                  {view.isSummary ? (
                    <p className="text-sm text-graphite">Dates follow the subtasks ({formatDate(view.startDate)} – {formatDate(view.endDate)}). Move the whole group on the Gantt chart.</p>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label={t.kind === "milestone" ? "Date" : "Start"} name="startDate" type="date" defaultValue={t.startDate} required />
                      {t.kind === "task" && <Field label="End" name="endDate" type="date" defaultValue={t.endDate} required />}
                    </div>
                  )}
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="field">
                      <label htmlFor="f-parent">Part of</label>
                      <select id="f-parent" name="parentTaskId" className="input" defaultValue={t.parentTaskId ?? ""}>
                        <option value="">— Top level —</option>
                        {parentOptions.map((p) => (
                          <option key={p.id} value={p.id}>{p.wbs} {p.title}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="f-stage">Stage</label>
                      <select id="f-stage" name="stageId" className="input" defaultValue={t.stageId ?? ""}>
                        <option value="">—</option>
                        {v.stages.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="f-assignee">Owner</label>
                      <select id="f-assignee" name="assigneeUserId" className="input" defaultValue={t.assigneeUserId ?? ""}>
                        <option value="">Unassigned</option>
                        {people.map((p) => (
                          <option key={p.userId} value={p.userId}>{p.displayName}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3 sm:items-end">
                    <div className="field">
                      <label htmlFor="f-priority">Priority</label>
                      <select id="f-priority" name="priority" className="input" defaultValue={t.priority}>
                        {Object.entries(PRIORITY_LABELS).map(([k, l]) => (
                          <option key={k} value={k}>{l}</option>
                        ))}
                      </select>
                    </div>
                    <Field label="Estimate (hours)" name="estimateHours" type="number" min={0} step={0.5} defaultValue={t.estimateHours ?? ""} />
                    <label className="flex items-center gap-2 pb-2 text-sm">
                      <input type="checkbox" name="requiresCompletionApproval" defaultChecked={t.requiresCompletionApproval} /> Completion needs approval
                    </label>
                  </div>
                </>
              )}
              {canWork && (
                <div className="grid gap-4 sm:grid-cols-4">
                  <div className="field">
                    <label htmlFor="f-status">Status</label>
                    <select id="f-status" name="status" className="input" defaultValue={t.status}>
                      {Object.entries(TASK_STATUS_LABELS).map(([k, l]) => (
                        <option key={k} value={k}>{l}</option>
                      ))}
                    </select>
                  </div>
                  {!view.isSummary && <Field label="Progress (%)" name="progressPercent" type="number" min={0} max={100} step={5} defaultValue={t.progressPercent} />}
                  <Field label="Actual start" name="actualStartDate" type="date" defaultValue={t.actualStartDate ?? ""} />
                  <Field label="Actual end" name="actualEndDate" type="date" defaultValue={t.actualEndDate ?? ""} />
                </div>
              )}
              {v.canApprove && (
                <fieldset className="grid gap-3 rounded-md border border-rule p-4">
                  <legend className="px-1 text-sm font-semibold">Approver</legend>
                  <input type="hidden" name="approverFields" value="1" />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="deadlineLocked" defaultChecked={t.deadlineLocked} /> This is an approved deadline (others can’t move it, and cascades stop here)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="confirmLockedChange" /> Allow this save to move approved deadlines
                  </label>
                  <Field label="Reason for moving a deadline" name="reason" hint="Recorded in the schedule history." />
                </fieldset>
              )}
            </ActionForm>
          </div>
        ) : (
          <dl className="grid max-w-3xl gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            {[
              ["Owner", t.assigneeUserId ? (names.get(t.assigneeUserId) ?? "—") : "Unassigned"],
              ["Priority", PRIORITY_LABELS[t.priority]],
              ["Progress", `${view.progress}%`],
              ["Stage", view.stageName ?? "—"],
              ["Actual dates", t.actualStartDate ? `${formatDate(t.actualStartDate)} – ${formatDate(t.actualEndDate)}` : "—"],
              ["Estimate", t.estimateHours ? `${t.estimateHours} h` : "—"],
            ].map(([k, val]) => (
              <div key={k} className="grid grid-cols-[8rem_1fr] gap-2">
                <dt className="text-graphite">{k}</dt>
                <dd>{val}</dd>
              </div>
            ))}
            {t.description && <p className="whitespace-pre-line sm:col-span-2">{t.description}</p>}
          </dl>
        )}
        <p className="mt-4 text-sm text-graphite">Time logged: {formatMinutes(detail.minutesLogged)}{t.estimateHours ? ` of ${t.estimateHours} h estimated` : ""}. <Link href={`/app/projects/${projectId}/time`}>Log time</Link></p>
      </Section>

      <Section title="Dependencies" description="Predecessors must reach their link point before this item can; changes push later work automatically.">
        <div className="grid gap-6 md:grid-cols-2">
          {(
            [
              ["Waits for", detail.predecessors, "predecessorId"],
              ["Then", detail.successors, "successorId"],
            ] as const
          ).map(([label, list, key]) => (
            <div key={label}>
              <h3 className="mb-2 font-sans text-sm font-semibold">{label}</h3>
              {list.length === 0 ? (
                <p className="text-sm text-graphite">None.</p>
              ) : (
                <ul className="ruled text-sm">
                  {list.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <span>
                        <Link href={`/app/projects/${projectId}/tasks/${d[key]}`}>{titleOf.get(d[key])}</Link>
                        <span className="block text-xs text-graphite">
                          {DEP_TYPE_LABELS[d.type]}
                          {d.lagDays ? `, ${d.lagDays > 0 ? "+" : ""}${d.lagDays} days lag` : ""}
                        </span>
                      </span>
                      {canPlan && full && (
                        <ActionForm action={removeDependencyAction} submitLabel="Remove" variant="quiet" className="flex">
                          {hidden}
                          <input type="hidden" name="dependencyId" value={d.id} />
                        </ActionForm>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        {canPlan && full && depCandidates.length > 0 && (
          <div className="mt-6 max-w-3xl">
            <ActionForm action={addDependencyAction} submitLabel="Add dependency" pendingLabel="Checking…" className="grid gap-4 sm:grid-cols-[9rem_1fr_10rem_6rem]">
              {hidden}
              <div className="field">
                <label htmlFor="d-direction">This item</label>
                <select id="d-direction" name="direction" className="input" defaultValue="predecessor">
                  <option value="predecessor">waits for</option>
                  <option value="successor">comes before</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="d-other">Task</label>
                <select id="d-other" name="otherTaskId" className="input" required>
                  {depCandidates.map((c) => (
                    <option key={c.id} value={c.id}>{c.wbs} {c.title}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="d-type">Link</label>
                <select id="d-type" name="type" className="input" defaultValue="FS">
                  {Object.entries(DEP_TYPE_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </select>
              </div>
              <Field label="Lag (days)" name="lagDays" type="number" defaultValue={0} min={-365} max={365} />
            </ActionForm>
          </div>
        )}
        {!full && <p className="mt-3 text-sm text-graphite">Dependencies are part of full project planning, which is not included in the {v.planName} plan.</p>}
      </Section>

      <Section title="Checklist">
        {detail.checklist.length === 0 && <p className="mb-3 text-sm text-graphite">No checklist items.</p>}
        <ul className="ruled mb-4 max-w-2xl text-sm">
          {detail.checklist.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className={c.done ? "text-graphite line-through" : ""}>{c.text}</span>
              {canWork && (
                <span className="flex gap-2">
                  <ActionForm action={checklistAction} submitLabel={c.done ? "Undo" : "Done"} variant="quiet" className="flex">
                    {hidden}
                    <input type="hidden" name="itemId" value={c.id} />
                    <input type="hidden" name="intent" value={c.done ? "uncheck" : "check"} />
                  </ActionForm>
                  <ActionForm action={checklistAction} submitLabel="Remove" variant="quiet" className="flex">
                    {hidden}
                    <input type="hidden" name="itemId" value={c.id} />
                    <input type="hidden" name="intent" value="remove" />
                  </ActionForm>
                </span>
              )}
            </li>
          ))}
        </ul>
        {canWork && (
          <div className="max-w-2xl">
            <ActionForm action={checklistAction} submitLabel="Add item" resetOnSuccess className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              {hidden}
              <input type="hidden" name="intent" value="add" />
              <Field label="New checklist item" name="text" maxLength={500} required />
            </ActionForm>
          </div>
        )}
      </Section>

      {full && (
        <Section title="People and allocation" description="Who works on this, and how much of their time it takes. Feeds the workload view.">
          <ul className="ruled mb-4 max-w-2xl text-sm">
            {detail.assignments.length === 0 && <li className="py-1.5 text-graphite">{t.assigneeUserId ? `${names.get(t.assigneeUserId) ?? "Owner"} at 100% (the owner, by default).` : "Nobody yet."}</li>}
            {detail.assignments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-1.5">
                <span>
                  {names.get(a.userId) ?? "Former member"} · {a.allocationPercent}%
                </span>
                {canPlan && (
                  <ActionForm action={assignmentAction} submitLabel="Remove" variant="quiet" className="flex">
                    {hidden}
                    <input type="hidden" name="userId" value={a.userId} />
                    <input type="hidden" name="intent" value="remove" />
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
          {canPlan && people.length > 0 && (
            <div className="max-w-2xl">
              <ActionForm action={assignmentAction} submitLabel="Assign" className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
                {hidden}
                <div className="field">
                  <label htmlFor="a-user">Person</label>
                  <select id="a-user" name="userId" className="input">
                    {people.map((p) => (
                      <option key={p.userId} value={p.userId}>{p.displayName}</option>
                    ))}
                  </select>
                </div>
                <Field label="Allocation (%)" name="allocationPercent" type="number" min={1} max={100} defaultValue={50} required />
              </ActionForm>
            </div>
          )}
        </Section>
      )}

      {financeOn && (
        <Section title="Cost estimate" description="Planned cost of this task. Estimates feed the budget forecast; they are never counted as spending, and moving the task never changes the approved budget.">
          <ul className="ruled mb-4 max-w-2xl text-sm">
            {estimates.length === 0 && <li className="py-1.5 text-graphite">No estimate.</li>}
            {estimates.map((e) => (
              <li key={e.id} className="flex justify-between gap-3 py-1.5">
                <span>{categories.find((c) => c.key === e.categoryKey)?.name ?? e.categoryKey}{e.note ? <span className="text-graphite"> · {e.note}</span> : null}</span>
                <span className="tabular-nums">{formatMoney(e.amountBaseMinor, fs.settings!.baseCurrency)}</span>
              </li>
            ))}
          </ul>
          {canEstimate && (
            <div className="max-w-2xl">
              <ActionForm action={estimateAction} submitLabel="Save estimate" resetOnSuccess className="grid gap-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
                {hidden}
                <div className="field">
                  <label htmlFor="ce-cat">Category</label>
                  <select id="ce-cat" name="categoryKey" className="input">
                    {categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                  </select>
                </div>
                <Field label={`Amount (${fs.settings!.baseCurrency})`} name="amount" inputMode="decimal" hint="0 removes it." defaultValue={estimates[0] ? toDecimalString(estimates[0].amountBaseMinor, fs.settings!.baseCurrency) : ""} />
              </ActionForm>
            </div>
          )}
        </Section>
      )}

      <Section title="Comments">
        <ul className="mb-4 grid max-w-2xl gap-3 text-sm">
          {detail.comments.length === 0 && <li className="text-graphite">No comments yet.</li>}
          {detail.comments.map((c) => (
            <li key={c.id} className="rounded-md border border-rule bg-sheet px-3 py-2">
              <p className="text-xs text-graphite">
                {c.authorName ?? "Former member"} · {formatDateTime(c.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-line">{c.body}</p>
            </li>
          ))}
        </ul>
        {canComment && (
          <div className="max-w-2xl">
            <ActionForm action={commentAction} submitLabel="Post comment" resetOnSuccess className="grid gap-3">
              {hidden}
              <div className="field">
                <label htmlFor="c-body">Comment</label>
                <textarea id="c-body" name="body" className="input" required maxLength={5000} />
              </div>
            </ActionForm>
          </div>
        )}
      </Section>

      <Section title="Schedule history">
        {detail.revisions.length === 0 ? (
          <p className="text-sm text-graphite">The dates haven’t changed since this item was created.</p>
        ) : (
          <ul className="ruled max-w-3xl text-sm">
            {detail.revisions.map(({ r, name }) => (
              <li key={r.id} className="py-1.5">
                <span className="tabular-nums">
                  {formatDate(r.oldStartDate)} – {formatDate(r.oldEndDate)} → <strong>{formatDate(r.newStartDate)} – {formatDate(r.newEndDate)}</strong>
                </span>
                <span className="block text-xs text-graphite">
                  {SOURCE_LABELS[r.source] ?? r.source} · {name ?? "—"} · {formatDateTime(r.createdAt)}
                  {r.reason ? ` · “${r.reason}”` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
