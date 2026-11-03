import { listWorkflowTemplates, STAGE_STATUS_LABELS } from "@researchmate/research";
import { ActionForm, Field } from "@/components/action-form";
import { formatDuration, Notice, Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import { addStageAction, applyTemplateAction, stageControlAction, updateStageAction } from "@/server/actions/planning";
import { loadProject } from "@/server/plan";
import { db, memberService, workflowService } from "@/server/services";

export const metadata = { title: "Workflow" };

export default async function WorkflowPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { session, project, can, archived } = await loadProject(projectId);
  const uid = session.user.id;
  const [{ stages, waitingSeconds }, people, templates] = await Promise.all([workflowService().list(uid, projectId), memberService().assignable(uid, projectId), listWorkflowTemplates(db(), project.organizationId)]);
  const canPlan = can("project.plan.manage") && !archived;
  const canReview = (can("project.review") || can("project.plan.approve")) && !archived;
  const names = new Map(people.map((p) => [p.userId, p.displayName]));
  const done = stages.filter((s) => s.enabled && (s.status === "completed" || s.status === "skipped")).length;
  const enabled = stages.filter((s) => s.enabled).length;
  const current = stages.find((s) => s.enabled && (s.status === "in_progress" || s.status === "awaiting_approval"));

  const control = (stageId: string, intent: string, label: string, variant: "primary" | "quiet" = "quiet", note = false) => (
    <ActionForm key={intent} action={stageControlAction} submitLabel={label} variant={variant} className={note ? "grid gap-2" : "flex"}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="stageId" value={stageId} />
      <input type="hidden" name="intent" value={intent} />
      {note && <input name="note" className="input py-1 text-sm" placeholder="Note (optional)" aria-label="Decision note" maxLength={2000} />}
    </ActionForm>
  );

  if (!stages.length) {
    return (
      <Section title="Choose a workflow" description="A workflow is the sequence of research stages for this project. It is copied into the project, so you can then reorder, repeat, disable or edit stages freely.">
        {canPlan ? (
          <div className="max-w-xl">
            <ActionForm action={applyTemplateAction} submitLabel="Use this workflow" className="grid gap-4">
              <input type="hidden" name="projectId" value={projectId} />
              <div className="field">
                <label htmlFor="w-template">Template</label>
                <select id="w-template" name="templateKey" className="input">
                  {templates.map((t) => (
                    <option key={t.id} value={t.key}>{t.name}</option>
                  ))}
                </select>
              </div>
              <ul className="text-sm text-graphite">
                {templates.map((t) => (
                  <li key={t.id}>
                    <strong className="text-ink">{t.name}:</strong> {t.description}
                  </li>
                ))}
              </ul>
            </ActionForm>
          </div>
        ) : (
          <Notice>This project has no workflow yet.</Notice>
        )}
      </Section>
    );
  }

  return (
    <>
      <div className="mb-8 flex flex-wrap gap-x-10 gap-y-2 text-sm">
        <p>
          <span className="text-graphite">Stages complete</span> <strong className="tabular-nums">{done} of {enabled}</strong>
        </p>
        <p>
          <span className="text-graphite">Current stage</span> <strong>{current?.name ?? "—"}</strong>
        </p>
        <p>
          <span className="text-graphite">Time waiting for approvals</span> <strong>{formatDuration(waitingSeconds)}</strong>
        </p>
      </div>

      <Section title="Stages" description="Stages marked “approval” need sign-off (by the lead researcher or a supervisor) before they count as complete.">
        <ol className="grid gap-3">
          {stages.map((s, i) => (
            <li key={s.id} className={`rounded-md border bg-sheet p-4 ${s.enabled ? "border-rule" : "border-dashed border-rule opacity-70"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-graphite tabular-nums">Stage {i + 1}{s.iteration > 1 ? ` · round ${s.iteration}` : ""}</p>
                  <h3 className="font-sans text-base font-semibold">{s.name}</h3>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    {s.enabled ? <Tag tone={s.status}>{STAGE_STATUS_LABELS[s.status as keyof typeof STAGE_STATUS_LABELS]}</Tag> : <Tag tone="skipped">Disabled</Tag>}
                    {s.approvalRequired && <Tag tone="todo">Approval</Tag>}
                    {s.optional && <Tag tone="todo">Optional</Tag>}
                    {s.dueDate && <span className="text-graphite">Due {formatDate(s.dueDate)}</span>}
                    {s.responsibleUserId && <span className="text-graphite">· {names.get(s.responsibleUserId) ?? "Former member"}</span>}
                  </p>
                  {s.purpose && <p className="mt-2 max-w-2xl text-sm">{s.purpose}</p>}
                  {s.approvedAt && <p className="mt-1 text-xs text-graphite">Approved {formatDateTime(s.approvedAt)}{s.approvalNote ? ` · “${s.approvalNote}”` : ""}</p>}
                  {!s.approvedAt && s.approvalNote && <p className="mt-1 text-xs text-amber">Changes requested: “{s.approvalNote}”</p>}
                </div>
                {s.enabled && (canPlan || canReview) && (
                  <div className="flex flex-wrap items-start gap-2">
                    {canPlan && s.status === "not_started" && control(s.id, "start", "Start", "primary")}
                    {canPlan && s.status === "in_progress" && control(s.id, "complete", s.approvalRequired ? "Submit for approval" : "Mark complete", "primary")}
                    {canReview && s.status === "awaiting_approval" && control(s.id, "approve", "Approve", "primary", true)}
                    {canReview && s.status === "awaiting_approval" && control(s.id, "request_changes", "Request changes", "quiet", true)}
                    {canPlan && s.optional && s.status !== "completed" && s.status !== "skipped" && control(s.id, "skip", "Skip")}
                    {canPlan && (s.status === "completed" || s.status === "skipped") && control(s.id, "reopen", "Reopen")}
                  </div>
                )}
              </div>

              {canPlan && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-graphite">Edit stage</summary>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {i > 0 && control(s.id, "up", "Move up")}
                    {i < stages.length - 1 && control(s.id, "down", "Move down")}
                    {control(s.id, "repeat", "Repeat stage")}
                    {s.status !== "in_progress" && control(s.id, s.enabled ? "disable" : "enable", s.enabled ? "Disable" : "Enable")}
                  </div>
                  <div className="mt-4 max-w-3xl">
                    <ActionForm action={updateStageAction} submitLabel="Save stage" className="grid gap-4">
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="stageId" value={s.id} />
                      <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
                        <Field id={`s-${s.id}-name`} label="Name" name="name" defaultValue={s.name} required maxLength={200} />
                        <Field id={`s-${s.id}-days`} label="Typical length (days)" name="nominalDurationDays" type="number" min={1} max={1000} defaultValue={s.nominalDurationDays} />
                      </div>
                      {(
                        [
                          ["purpose", "Purpose", s.purpose],
                          ["requiredInputs", "Required inputs", s.requiredInputs],
                          ["expectedOutputs", "Expected outputs", s.expectedOutputs],
                          ["completionCriteria", "Completion criteria", s.completionCriteria],
                        ] as const
                      ).map(([n, l, val]) => (
                        <div key={n} className="field">
                          <label htmlFor={`s-${s.id}-${n}`}>{l}</label>
                          <textarea id={`s-${s.id}-${n}`} name={n} className="input min-h-16" defaultValue={val} maxLength={2000} />
                        </div>
                      ))}
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="field">
                          <label htmlFor={`s-${s.id}-resp`}>Responsible</label>
                          <select id={`s-${s.id}-resp`} name="responsibleUserId" className="input" defaultValue={s.responsibleUserId ?? ""}>
                            <option value="">—</option>
                            {people.map((p) => (
                              <option key={p.userId} value={p.userId}>{p.displayName}</option>
                            ))}
                          </select>
                        </div>
                        <Field id={`s-${s.id}-due`} label="Due date" name="dueDate" type="date" defaultValue={s.dueDate ?? ""} />
                      </div>
                      <div className="flex flex-wrap gap-5">
                        <label className="flex items-center gap-2">
                          <input type="checkbox" name="approvalRequired" defaultChecked={s.approvalRequired} /> Needs approval
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" name="optional" defaultChecked={s.optional} /> Optional (can be skipped)
                        </label>
                      </div>
                    </ActionForm>
                  </div>
                </details>
              )}
              {!canPlan && (s.expectedOutputs || s.completionCriteria) && (
                <dl className="mt-2 grid gap-1 text-sm text-graphite">
                  {s.expectedOutputs && <div><dt className="inline font-semibold">Outputs: </dt><dd className="inline">{s.expectedOutputs}</dd></div>}
                  {s.completionCriteria && <div><dt className="inline font-semibold">Done when: </dt><dd className="inline">{s.completionCriteria}</dd></div>}
                </dl>
              )}
            </li>
          ))}
        </ol>
      </Section>

      {canPlan && (
        <Section title="Add a stage">
          <div className="max-w-2xl">
            <ActionForm action={addStageAction} submitLabel="Add stage" resetOnSuccess className="grid gap-4 sm:grid-cols-[1fr_9rem]">
              <input type="hidden" name="projectId" value={projectId} />
              <Field label="Name" name="name" required maxLength={200} />
              <Field label="Typical length (days)" name="nominalDurationDays" type="number" min={1} max={1000} defaultValue={7} />
            </ActionForm>
          </div>
        </Section>
      )}
    </>
  );
}
