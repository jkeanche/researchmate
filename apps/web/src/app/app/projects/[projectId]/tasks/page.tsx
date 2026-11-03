import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Board } from "@/components/board";
import { Flag, PlanNotice, PRIORITY_LABELS, TaskStatusTag } from "@/components/plan-ui";
import { NewTaskFields } from "@/components/task-form";
import { EmptyState, Meter, Section } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { createTaskAction, moveTaskOrderAction } from "@/server/actions/planning";
import { loadPlanView } from "@/server/plan";
import { memberService } from "@/server/services";

export const metadata = { title: "Tasks" };

export default async function TasksPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { projectId } = await params;
  const q = await searchParams;
  const v = await loadPlanView(projectId);
  const uid = v.session.user.id;
  const people = await memberService().assignable(uid, projectId);
  const view = q.view === "board" ? "board" : q.view === "wbs" ? "wbs" : "list";
  const canWork = v.can("project.tasks.work") && !v.archived;

  const filtered = v.tasks.filter(
    (t) =>
      (!q.status || (q.status === "open" ? t.status !== "done" && t.status !== "cancelled" : q.status === "overdue" ? t.overdue : t.status === q.status)) &&
      (!q.owner || (q.owner === "me" ? t.assigneeUserId === uid : t.assigneeUserId === q.owner)) &&
      (!q.stage || t.stageId === q.stage),
  );
  const atLimit = v.taskLimit !== null && v.tasks.length >= v.taskLimit;
  const link = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ ...q, ...patch }).filter(([, val]) => val) as [string, string][]);
    return `?${p.toString()}`;
  };

  return (
    <>
      <Section
        title="Tasks and milestones"
        aside={
          <nav aria-label="View" className="flex gap-1 text-sm">
            {(["list", "wbs", "board"] as const).map((k) => (
              <Link key={k} href={link({ view: k === "list" ? undefined : k })} aria-current={view === k ? "page" : undefined} className={`rounded px-2 py-1 no-underline ${view === k ? "bg-ink text-sheet" : "hover:bg-rule-soft"}`}>
                {k === "list" ? "List" : k === "wbs" ? "Work breakdown" : "Board"}
              </Link>
            ))}
          </nav>
        }
      >
        <form className="mb-5 flex flex-wrap items-end gap-3 text-sm" method="get">
          {view !== "list" && <input type="hidden" name="view" value={view} />}
          <div className="field">
            <label htmlFor="q-status">Show</label>
            <select id="q-status" name="status" className="input py-1.5" defaultValue={q.status ?? ""}>
              <option value="">All</option>
              <option value="open">Not done</option>
              <option value="overdue">Overdue</option>
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="blocked">Blocked</option>
              <option value="in_review">In review</option>
              <option value="done">Done</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="q-owner">Owner</label>
            <select id="q-owner" name="owner" className="input py-1.5" defaultValue={q.owner ?? ""}>
              <option value="">Everyone</option>
              <option value="me">Me</option>
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>{p.displayName}</option>
              ))}
            </select>
          </div>
          {v.stages.length > 0 && (
            <div className="field">
              <label htmlFor="q-stage">Stage</label>
              <select id="q-stage" name="stage" className="input max-w-56 py-1.5" defaultValue={q.stage ?? ""}>
                <option value="">All stages</option>
                {v.stages.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}
          <button className="btn btn-quiet py-1.5">Filter</button>
        </form>

        {v.tasks.length === 0 ? (
          <EmptyState title="No tasks yet" body={v.tier === "full" ? "Add a first task below, or generate a full schedule from your workflow on the Schedule tab." : "Add tasks and milestones below to plan your research."} />
        ) : view === "board" ? (
          <Board
            projectId={projectId}
            cards={filtered
              .filter((t) => !t.isSummary && t.status !== "cancelled")
              .map((t) => ({
                id: t.id,
                wbs: t.wbs,
                title: t.title,
                kind: t.kind,
                status: t.status,
                priority: t.priority,
                endDate: t.endDate,
                assigneeName: t.assigneeName,
                canMove: v.canPlan || (canWork && t.assigneeUserId === uid),
                overdue: t.overdue,
                critical: t.critical && v.tier === "full",
                progress: t.progress,
              }))}
          />
        ) : view === "wbs" ? (
          <ol className="text-sm">
            {filtered.map((t) => (
              <li key={t.id} className="flex items-baseline gap-3 border-b border-rule-soft py-1.5" style={{ paddingLeft: `${t.depth * 1.5}rem` }}>
                <span className="w-12 shrink-0 text-graphite tabular-nums">{t.wbs}</span>
                <Link href={`/app/projects/${projectId}/tasks/${t.id}`} className={t.isSummary ? "font-semibold" : ""}>
                  {t.kind === "milestone" ? "◆ " : ""}
                  {t.title}
                </Link>
                <span className="ml-auto text-graphite tabular-nums">{t.progress}%</span>
                {v.canPlan && (
                  <span className="no-print flex gap-1">
                    {(["up", "down"] as const).map((d) => (
                      <form key={d} action={moveTaskOrderAction}>
                        <input type="hidden" name="taskId" value={t.id} />
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="direction" value={d} />
                        <button className="rounded px-1.5 text-graphite hover:bg-rule-soft" aria-label={`Move “${t.title}” ${d}`}>{d === "up" ? "↑" : "↓"}</button>
                      </form>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="text-left text-graphite">
                <tr className="border-b border-rule">
                  <th className="py-2 pr-2 font-semibold">WBS</th>
                  <th className="py-2 pr-3 font-semibold">Task</th>
                  <th className="py-2 pr-3 font-semibold">Dates</th>
                  <th className="py-2 pr-3 font-semibold">Owner</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-3 font-semibold">Priority</th>
                  <th className="py-2 text-right font-semibold">Done</th>
                </tr>
              </thead>
              <tbody className="ruled">
                {filtered.map((t) => (
                  <tr key={t.id} className="align-top">
                    <td className="py-2 pr-2 text-graphite tabular-nums">{t.wbs}</td>
                    <td className="py-2 pr-3" style={{ paddingLeft: `${t.depth * 1.1}rem` }}>
                      <Link href={`/app/projects/${projectId}/tasks/${t.id}`} className={t.isSummary ? "font-semibold" : ""}>
                        {t.kind === "milestone" ? "◆ " : ""}
                        {t.title}
                      </Link>
                      <span className="ml-1.5 inline-flex flex-wrap gap-1">
                        {t.overdue && <Flag kind="overdue" />}
                        {!t.overdue && t.lateStart && <Flag kind="late" />}
                        {t.critical && v.tier === "full" && t.status !== "done" && <Flag kind="critical" />}
                        {t.locked && <Flag kind="locked" />}
                      </span>
                      {t.stageName && <span className="block text-xs text-graphite">{t.stageName}</span>}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{t.kind === "milestone" ? formatDate(t.startDate) : `${formatDate(t.startDate)} – ${formatDate(t.endDate)}`}</td>
                    <td className="py-2 pr-3">{t.assigneeName ?? <span className="text-graphite">—</span>}</td>
                    <td className="py-2 pr-3"><TaskStatusTag status={t.status} /></td>
                    <td className="py-2 pr-3">{PRIORITY_LABELS[t.priority]}</td>
                    <td className="py-2 text-right tabular-nums">{t.progress}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && <p className="py-4 text-sm text-graphite">No tasks match these filters.</p>}
          </div>
        )}
      </Section>

      {v.canPlan && (
        <Section title="Add a task or milestone">
          {v.taskLimit !== null && (
            <div className="mb-4 max-w-sm">
              <Meter label="Tasks in this project" used={v.tasks.length} limit={v.taskLimit} format={(n) => String(n)} />
            </div>
          )}
          {atLimit ? (
            <PlanNotice>The {v.planName} plan allows {v.taskLimit} tasks and milestones per project.</PlanNotice>
          ) : (
            <div className="max-w-3xl">
              <ActionForm action={createTaskAction} submitLabel="Add" pendingLabel="Adding…" resetOnSuccess className="grid gap-4">
                <input type="hidden" name="projectId" value={projectId} />
                <NewTaskFields
                  today={v.project.startDate && v.project.startDate > v.today ? v.project.startDate : v.today}
                  parents={v.tasks.filter((t) => t.kind === "task").map((t) => ({ id: t.id, label: `${t.wbs} ${t.title}` }))}
                  stages={v.stages.map((s) => ({ id: s.id, label: s.name }))}
                  people={people.map((p) => ({ id: p.userId, label: p.displayName }))}
                />
              </ActionForm>
            </div>
          )}
        </Section>
      )}
    </>
  );
}
