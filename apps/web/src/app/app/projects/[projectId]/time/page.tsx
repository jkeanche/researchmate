import { TIME_CATEGORIES } from "@researchmate/database";
import { diffDays, workload } from "@researchmate/planning";
import { ActionForm, Field } from "@/components/action-form";
import { formatDuration, formatMinutes, PlanNotice, Stat } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { timeAction } from "@/server/actions/planning";
import { loadPlanView } from "@/server/plan";
import { planningService, workflowService } from "@/server/services";

export const metadata = { title: "Time and workload" };

const CATEGORY_LABELS: Record<string, string> = {
  research: "Research and reading",
  writing: "Writing",
  analysis: "Analysis",
  data_collection: "Data collection",
  revision: "Revision",
  meeting: "Meetings",
  admin: "Administration",
  other: "Other",
};

export default async function TimePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadPlanView(projectId);
  const uid = v.session.user.id;
  const [time, wf, names] = await Promise.all([planningService().listTime(uid, projectId), workflowService().list(uid, projectId), planningService().namesFor([...v.plan.rows.map((r) => r.assigneeUserId), ...v.plan.assignments.map((a) => a.userId)])]);
  const full = v.tier === "full";
  const canLog = full && !v.archived && (v.canPlan || v.can("project.tasks.work"));
  const myTasks = v.tasks.filter((t) => !t.isSummary && t.kind === "task" && (v.canPlan || t.assigneeUserId === uid));
  const started = v.project.startDate ?? v.project.createdAt.toISOString().slice(0, 10);
  const elapsed = Math.max(0, diffDays(started, v.today));
  const active = time.totalMinutes - (time.byCategory.revision ?? 0);
  const wl = workload(
    v.plan.rows.map((r) => ({ ...v.plan.tasks.find((t) => t.id === r.id)!, assigneeUserId: r.assigneeUserId })),
    v.plan.assignments,
    v.today,
    12,
  );

  return (
    <>
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Calendar time elapsed" value={`${elapsed} days`} note={`Since ${formatDate(started)}`} />
        <Stat label="Active research time" value={formatMinutes(active)} note="Logged, excluding revisions" />
        <Stat label="Revision time" value={formatMinutes(time.byCategory.revision ?? 0)} />
        <Stat label="Waiting for approvals" value={formatDuration(wf.waitingSeconds)} note="Time stages spent awaiting sign-off" />
      </div>
      <p className="-mt-4 mb-8 text-xs text-graphite">AI processing time will appear here once AI features are introduced.</p>

      <Section title="Log time">
        {!full ? (
          <PlanNotice>Time tracking is part of full project planning, which is not included in the {v.planName} plan.</PlanNotice>
        ) : canLog ? (
          <div className="max-w-3xl">
            <ActionForm action={timeAction} submitLabel="Log time" resetOnSuccess className="grid gap-4">
              <input type="hidden" name="projectId" value={projectId} />
              <div className="grid gap-4 sm:grid-cols-4">
                <Field label="Date" name="entryDate" type="date" defaultValue={v.today} max={v.today} required />
                <Field label="Hours" name="hours" type="number" min={0} max={24} step={0.25} defaultValue={1} />
                <Field label="Minutes" name="minutes" type="number" min={0} max={59} step={5} defaultValue={0} />
                <div className="field">
                  <label htmlFor="t-cat">Activity</label>
                  <select id="t-cat" name="category" className="input" defaultValue="research">
                    {TIME_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="field">
                  <label htmlFor="t-task">Task</label>
                  <select id="t-task" name="taskId" className="input" defaultValue="">
                    <option value="">— Not task-specific —</option>
                    {myTasks.map((t) => (
                      <option key={t.id} value={t.id}>{t.wbs} {t.title}</option>
                    ))}
                  </select>
                </div>
                <Field label="Note" name="note" maxLength={1000} />
              </div>
            </ActionForm>
          </div>
        ) : (
          <p className="text-sm text-graphite">You can view time on this project but not log it.</p>
        )}
      </Section>

      <Section title="Time by activity">
        {time.totalMinutes === 0 ? (
          <p className="text-sm text-graphite">No time logged yet.</p>
        ) : (
          <ul className="grid max-w-xl gap-2 text-sm">
            {Object.entries(time.byCategory)
              .sort((a, b) => b[1] - a[1])
              .map(([k, m]) => (
                <li key={k} className="grid grid-cols-[11rem_1fr_6rem] items-center gap-3">
                  <span>{CATEGORY_LABELS[k] ?? k}</span>
                  <span className="h-2 rounded-sm bg-rule-soft">
                    <span className="block h-full rounded-sm bg-green" style={{ width: `${(m / time.totalMinutes) * 100}%` }} />
                  </span>
                  <span className="text-right tabular-nums">{formatMinutes(m)}</span>
                </li>
              ))}
          </ul>
        )}
        {time.rows.length > 0 && (
          <details className="mt-5 text-sm">
            <summary className="cursor-pointer text-graphite">All entries ({time.rows.length})</summary>
            <ul className="ruled mt-2 max-w-3xl">
              {time.rows.map(({ e, name, taskTitle }) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span>
                    <span className="tabular-nums">{formatDate(e.entryDate)}</span> · {formatMinutes(e.minutes)} · {CATEGORY_LABELS[e.category]} · {name ?? "Former member"}
                    {taskTitle ? ` · ${taskTitle}` : ""}
                    {e.note ? <span className="block text-graphite">{e.note}</span> : null}
                  </span>
                  {!v.archived && (e.userId === uid || v.canPlan) && (
                    <ActionForm action={timeAction} submitLabel="Remove" variant="quiet" className="flex">
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="entryId" value={e.id} />
                      <input type="hidden" name="intent" value="delete" />
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <Section title="Workload, next 12 weeks" description="Share of each person's week booked on open tasks in this project (owners count at 100% unless allocations are set on the task). Over 100% means overbooked.">
        {wl.rows.length === 0 ? (
          <p className="text-sm text-graphite">Assign owners to tasks to see workload.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr className="text-graphite">
                  <th className="py-1 pr-3 text-left font-semibold">Person</th>
                  {wl.weekStarts.map((w) => (
                    <th key={w} className="w-12 px-0.5 py-1 text-center font-semibold whitespace-nowrap">{w.slice(5).replace("-", "/")}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {wl.rows.map((r) => (
                  <tr key={r.userId}>
                    <th scope="row" className="py-1 pr-3 text-left font-normal whitespace-nowrap">{names.get(r.userId) ?? "Former member"}</th>
                    {r.load.map((pct, i) => (
                      <td
                        key={i}
                        className={`h-8 border border-sheet text-center tabular-nums ${pct > 100 ? "bg-margin-wash font-semibold text-margin" : pct >= 75 ? "bg-green/70 text-sheet" : pct > 0 ? "bg-green-wash text-green-dark" : "bg-paper text-graphite"}`}
                        aria-label={`Week of ${wl.weekStarts[i]}: ${pct}%`}
                      >
                        {pct || ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
