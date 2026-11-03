import { diffDays, scheduleVariance } from "@researchmate/planning";
import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { type GanttBaseline, GanttChart } from "@/components/gantt";
import { Flag, Notice, PlanNotice, Stat } from "@/components/plan-ui";
import { EmptyState, Section } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import { baselineAction, decideProposalAction, proposeScheduleAction } from "@/server/actions/planning";
import { loadPlanView } from "@/server/plan";
import { planningService, workflowService } from "@/server/services";

export const metadata = { title: "Schedule" };

const slip = (d: number | null) => (d === null ? "—" : d === 0 ? "On time" : d > 0 ? `${d} day${d === 1 ? "" : "s"} late` : `${-d} day${d === -1 ? "" : "s"} early`);

export default async function SchedulePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadPlanView(projectId);
  const uid = v.session.user.id;
  const [baselineRows, proposal, wf] = await Promise.all([planningService().listBaselines(uid, projectId), planningService().pendingProposal(uid, projectId), workflowService().list(uid, projectId)]);
  const loaded = await Promise.all(baselineRows.slice(0, 6).map(async ({ b }) => ({ b, items: (await planningService().baselineItems(uid, b.id)).items })));
  const baselines: GanttBaseline[] = loaded.map(({ b, items }) => ({ id: b.id, name: `${b.name} (${formatDate(b.createdAt)})`, items }));
  const full = v.tier === "full";
  const latest = loaded[0];
  const variance = latest ? scheduleVariance(v.plan.tasks, latest.items) : null;
  const latestRow = baselineRows[0]?.b;
  const finishVar = latestRow?.plannedFinish && v.projectFinish ? diffDays(latestRow.plannedFinish, v.projectFinish) : null;
  const forecastVar = v.expectedCompletion && v.estimatedCompletion ? diffDays(v.expectedCompletion, v.estimatedCompletion) : null;
  const milestones = v.tasks.filter((t) => t.kind === "milestone");
  const critical = v.tasks.filter((t) => t.critical && !t.isSummary && t.status !== "done");
  const titleOf = new Map(v.tasks.map((t) => [t.id, t.title]));

  return (
    <>
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Planned finish" value={v.projectFinish ? formatDate(v.projectFinish) : "—"} note={v.expectedCompletion ? `Target ${formatDate(v.expectedCompletion)}` : "No target date set"} />
        <Stat
          label="Forecast completion"
          value={v.estimatedCompletion ? formatDate(v.estimatedCompletion) : "—"}
          note={forecastVar === null ? "From remaining work and today's date" : forecastVar > 0 ? `${forecastVar} days after the target` : "Within the target"}
          tone={forecastVar !== null && forecastVar > 0 ? "bad" : forecastVar !== null ? "good" : undefined}
        />
        <Stat label="Against baseline" value={finishVar === null ? "—" : slip(finishVar)} note={latestRow ? latestRow.name : "No baseline saved"} tone={finishVar !== null && finishVar > 0 ? "warn" : undefined} />
        <Stat label="Critical tasks open" value={critical.length} note="Any delay here delays the finish" tone={critical.length ? "warn" : undefined} />
      </div>

      <Section title="Gantt chart">
        {v.tasks.length === 0 ? (
          <EmptyState
            title="No tasks yet"
            body={full && wf.stages.length ? "Generate a proposed schedule from your workflow below, or add tasks one by one." : "Add tasks and milestones to see them on the timeline."}
            action={{ href: `/app/projects/${projectId}/tasks`, label: "Add tasks" }}
          />
        ) : (
          <GanttChart
            projectId={projectId}
            tasks={v.tasks}
            deps={v.deps.map((d) => ({ id: d.id, predecessorId: d.predecessorId, successorId: d.successorId, type: d.type as "FS", lagDays: d.lagDays }))}
            baselines={baselines}
            today={v.today}
            canEdit={full && v.canPlan}
            canApprove={v.canApprove}
            readOnlyReason={!full ? `The ${v.planName} plan shows a read-only timeline. Dependencies, drag-and-drop scheduling, baselines and critical path are part of full planning.` : !v.canPlan ? "You can view this schedule but not change it." : null}
          />
        )}
        {!full && <div className="mt-4"><PlanNotice>Full project planning is not included in the {v.planName} plan.</PlanNotice></div>}
      </Section>

      {full && (
        <Section title="Proposed schedule" description="Generate a plan from the workflow stages, scaled to your start and submission dates. It is only a proposal: nothing is added until an approver accepts it, and existing tasks are never changed.">
          {proposal ? (
            <div className="grid gap-4">
              <div className="rounded-md border border-amber/30 bg-amber-wash/60 p-4 text-sm">
                <p className="font-semibold">Awaiting review · created {formatDateTime(proposal.createdAt)}</p>
                <ul className="mt-2 list-disc pl-5 text-graphite">
                  {proposal.payload.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="text-left text-graphite">
                    <tr className="border-b border-rule">
                      <th className="py-2 pr-3 font-semibold">Proposed item</th>
                      <th className="py-2 pr-3 font-semibold">Start</th>
                      <th className="py-2 pr-3 font-semibold">End</th>
                      <th className="py-2 font-semibold">Days</th>
                    </tr>
                  </thead>
                  <tbody className="ruled">
                    {proposal.payload.tasks.map((t) => (
                      <tr key={t.ref}>
                        <td className="py-1.5 pr-3">{t.kind === "milestone" ? `◆ ${t.title}` : t.title}</td>
                        <td className="py-1.5 pr-3 tabular-nums">{formatDate(t.startDate)}</td>
                        <td className="py-1.5 pr-3 tabular-nums">{t.kind === "milestone" ? "—" : formatDate(t.endDate)}</td>
                        <td className="py-1.5 tabular-nums">{t.kind === "milestone" ? "—" : diffDays(t.startDate, t.endDate) + 1}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-3">
                {v.canApprove ? (
                  <ActionForm action={decideProposalAction} submitLabel={`Add ${proposal.payload.tasks.length} items to the plan`} pendingLabel="Adding…" className="flex gap-2">
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="proposalId" value={proposal.id} />
                    <input type="hidden" name="decision" value="approve" />
                  </ActionForm>
                ) : (
                  <Notice>An approver (the lead researcher) needs to accept this proposal.</Notice>
                )}
                {(v.canPlan || v.canApprove) && (
                  <ActionForm action={decideProposalAction} submitLabel="Discard" variant="quiet" className="flex gap-2">
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="proposalId" value={proposal.id} />
                    <input type="hidden" name="decision" value="reject" />
                  </ActionForm>
                )}
              </div>
            </div>
          ) : wf.stages.length === 0 ? (
            <Notice>
              This project has no workflow. <Link href={`/app/projects/${projectId}/workflow`}>Choose a workflow template</Link> to generate a schedule.
            </Notice>
          ) : v.canPlan ? (
            <ActionForm action={proposeScheduleAction} submitLabel="Propose a schedule" pendingLabel="Calculating…" className="grid max-w-xl gap-4 sm:grid-cols-2">
              <input type="hidden" name="projectId" value={projectId} />
              <Field label="Start date" name="startDate" type="date" defaultValue={v.project.startDate ?? v.today} required />
              <Field label="Submission date" name="submissionDate" type="date" defaultValue={v.project.expectedCompletionDate ?? ""} hint="Leave empty to use typical stage lengths." />
            </ActionForm>
          ) : (
            <Notice>No proposal is waiting for review.</Notice>
          )}
        </Section>
      )}

      {full && (
        <Section title="Baselines" description="A baseline is an approved snapshot of the schedule. Saving a new one never changes earlier baselines, so you can always compare against the original plan.">
          {v.canApprove && v.tasks.length > 0 && (
            <div className="mb-6 max-w-2xl">
              <ActionForm action={baselineAction} submitLabel="Save baseline" pendingLabel="Saving…" className="grid gap-4 sm:grid-cols-2" resetOnSuccess>
                <input type="hidden" name="projectId" value={projectId} />
                <Field label="Name" name="name" placeholder={`Baseline ${(baselineRows[0]?.b.number ?? 0) + 1}`} />
                <Field label="Note" name="note" placeholder="e.g. Approved with the proposal" />
              </ActionForm>
            </div>
          )}
          {baselineRows.length === 0 ? (
            <p className="text-sm text-graphite">No baselines yet.</p>
          ) : (
            <ul className="ruled text-sm">
              {baselineRows.map(({ b, approvedBy }) => (
                <li key={b.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span>
                    <span className="font-semibold">{b.name}</span> <span className="text-graphite">· #{b.number} · {b.taskCount} items · planned finish {formatDate(b.plannedFinish)}</span>
                    {b.note ? <span className="block text-graphite">{b.note}</span> : null}
                  </span>
                  <span className="text-graphite">
                    {approvedBy ?? "—"}, {formatDateTime(b.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {variance && variance.rows.some((r) => r.finishVarianceDays !== 0 || r.removed) && (
            <div className="mt-6 overflow-x-auto">
              <h3 className="mb-2 font-sans text-base font-semibold">Changes since “{latestRow!.name}”</h3>
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="text-left text-graphite">
                  <tr className="border-b border-rule">
                    <th className="py-2 pr-3 font-semibold">Item</th>
                    <th className="py-2 pr-3 font-semibold">Baseline end</th>
                    <th className="py-2 pr-3 font-semibold">Current end</th>
                    <th className="py-2 font-semibold">Variance</th>
                  </tr>
                </thead>
                <tbody className="ruled">
                  {variance.rows
                    .filter((r) => r.finishVarianceDays !== 0 || r.removed)
                    .map((r) => (
                      <tr key={r.taskId}>
                        <td className="py-1.5 pr-3">{r.title}</td>
                        <td className="py-1.5 pr-3 tabular-nums">{formatDate(r.baselineEnd)}</td>
                        <td className="py-1.5 pr-3 tabular-nums">{r.removed ? "Removed" : formatDate(r.currentEnd)}</td>
                        <td className={`py-1.5 tabular-nums ${(r.finishVarianceDays ?? 0) > 0 ? "text-margin" : "text-green-dark"}`}>{r.removed ? "—" : slip(r.finishVarianceDays)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {variance.added.length > 0 && <p className="mt-2 text-sm text-graphite">{variance.added.length} item(s) added since this baseline.</p>}
            </div>
          )}
        </Section>
      )}

      <Section title="Milestones">
        {milestones.length === 0 ? (
          <p className="text-sm text-graphite">No milestones yet. Add one from the task list (choose “Milestone”).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left text-graphite">
                <tr className="border-b border-rule">
                  <th className="py-2 pr-3 font-semibold">Milestone</th>
                  <th className="py-2 pr-3 font-semibold">Date</th>
                  <th className="py-2 pr-3 font-semibold">Forecast</th>
                  <th className="py-2 pr-3 font-semibold">Baseline</th>
                  <th className="py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="ruled">
                {milestones.map((m) => {
                  const b = latest?.items.find((i) => i.taskId === m.id);
                  const fc = m.forecastEnd && m.forecastEnd !== m.endDate ? m.forecastEnd : null;
                  return (
                    <tr key={m.id}>
                      <td className="py-1.5 pr-3">
                        <Link href={`/app/projects/${projectId}/tasks/${m.id}`}>{m.title}</Link> {m.locked && <Flag kind="locked" />}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">{formatDate(m.startDate)}</td>
                      <td className={`py-1.5 pr-3 tabular-nums ${fc ? "text-margin" : "text-graphite"}`}>{fc ? formatDate(fc) : m.status === "done" ? "Reached" : "On plan"}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{b ? `${formatDate(b.startDate)} · ${slip(diffDays(b.startDate, m.startDate))}` : "—"}</td>
                      <td className="py-1.5">{m.status === "done" ? "Reached" : m.overdue ? <Flag kind="overdue" /> : "Upcoming"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {full && v.tasks.length > 0 && (
        <Section title="Critical path" description="The chain of work with no slack: moving any of these later moves the project finish.">
          {critical.length === 0 ? (
            <p className="text-sm text-graphite">All critical work is done.</p>
          ) : (
            <ol className="ruled text-sm">
              {critical.map((t) => (
                <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                  <span>
                    <span className="mr-2 text-graphite tabular-nums">{t.wbs}</span>
                    <Link href={`/app/projects/${projectId}/tasks/${t.id}`}>{t.title}</Link> {t.overdue && <Flag kind="overdue" />}
                  </span>
                  <span className="text-graphite tabular-nums">
                    {formatDate(t.startDate)} – {formatDate(t.endDate)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {v.deps.length > 0 && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-graphite">All dependencies ({v.deps.length})</summary>
              <ul className="ruled mt-2">
                {v.deps.map((d) => (
                  <li key={d.id} className="py-1">
                    {titleOf.get(d.predecessorId)} → {titleOf.get(d.successorId)} <span className="text-graphite">({d.type}{d.lagDays ? `, ${d.lagDays > 0 ? "+" : ""}${d.lagDays} d` : ""})</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Section>
      )}
    </>
  );
}
