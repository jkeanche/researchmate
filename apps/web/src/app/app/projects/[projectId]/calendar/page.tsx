import { addDays, isIsoDate, toDay } from "@researchmate/planning";
import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { PlanNotice } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { eventAction } from "@/server/actions/planning";
import { loadPlanView } from "@/server/plan";
import { planningService } from "@/server/services";

export const metadata = { title: "Calendar" };

const EVENT_LABELS: Record<string, string> = {
  meeting: "Meeting",
  supervisor_meeting: "Supervisor meeting",
  deadline: "Deadline",
  fieldwork: "Fieldwork",
  conference: "Conference",
  other: "Other",
};
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function CalendarPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { projectId } = await params;
  const { month } = await searchParams;
  const v = await loadPlanView(projectId);
  const ym = month && /^\d{4}-\d{2}$/.test(month) && isIsoDate(`${month}-01`) ? month : v.today.slice(0, 7);
  const first = `${ym}-01`;
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const last = addDays(`${nextMonth}-01`, -1);
  // Grid from the Monday on/before the 1st to the Sunday on/after the last day.
  const firstDow = (toDay(first) + 3) % 7; // 0 = Monday
  const gridStart = addDays(first, -firstDow);
  const lastDow = (toDay(last) + 3) % 7;
  const gridEnd = addDays(last, 6 - lastDow);
  const days: string[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);

  const events = await planningService().listEvents(v.session.user.id, projectId, gridStart, gridEnd);
  type Item = { key: string; label: string; href?: string; tone: string };
  const byDay = new Map<string, Item[]>();
  const push = (d: string, it: Item) => {
    if (d < gridStart || d > gridEnd) return;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(it);
  };
  for (const t of v.tasks) {
    if (t.isSummary) continue;
    const href = `/app/projects/${projectId}/tasks/${t.id}`;
    if (t.kind === "milestone") push(t.startDate, { key: t.id, label: `◆ ${t.title}`, href, tone: t.overdue ? "bad" : "milestone" });
    else {
      push(t.endDate, { key: `${t.id}-e`, label: `Due: ${t.title}`, href, tone: t.overdue ? "bad" : t.status === "done" ? "done" : "task" });
      if (t.startDate !== t.endDate) push(t.startDate, { key: `${t.id}-s`, label: `Starts: ${t.title}`, href, tone: "start" });
    }
  }
  for (const e of events) for (let d = e.startDate; d <= e.endDate; d = addDays(d, 1)) push(d, { key: `${e.id}-${d}`, label: `${e.startTime && d === e.startDate ? `${e.startTime} ` : ""}${e.title}`, tone: "event" });

  const tone: Record<string, string> = {
    bad: "bg-margin-wash text-margin border-margin/30",
    milestone: "bg-amber-wash text-amber border-amber/30",
    task: "bg-green-wash text-green-dark border-green/30",
    done: "bg-rule-soft text-graphite border-rule line-through",
    start: "text-graphite border-transparent",
    event: "bg-ink text-sheet border-ink",
  };
  const monthName = new Date(`${first}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <>
      <Section
        title={monthName}
        aside={
          <nav aria-label="Month" className="flex gap-2 text-sm">
            <Link href={`?month=${prevMonth}`} className="btn btn-quiet px-3 py-1">← Previous</Link>
            <Link href="?" className="btn btn-quiet px-3 py-1">Today</Link>
            <Link href={`?month=${nextMonth}`} className="btn btn-quiet px-3 py-1">Next →</Link>
          </nav>
        }
      >
        <div className="hidden grid-cols-7 border-t border-l border-rule text-sm md:grid">
          {WEEKDAYS.map((d) => (
            <div key={d} className="border-r border-b border-rule bg-paper px-2 py-1 text-xs font-semibold text-graphite">{d}</div>
          ))}
          {days.map((d) => {
            const items = byDay.get(d) ?? [];
            const out = d.slice(0, 7) !== ym;
            return (
              <div key={d} className={`min-h-28 border-r border-b border-rule p-1.5 ${out ? "bg-paper/60 text-graphite" : "bg-sheet"} ${d === v.today ? "outline-2 -outline-offset-2 outline-margin" : ""}`}>
                <p className={`text-xs tabular-nums ${d === v.today ? "font-bold text-margin" : ""}`}>{Number(d.slice(8))}</p>
                <ul className="mt-1 grid gap-1">
                  {items.slice(0, 4).map((it) => (
                    <li key={it.key} className={`truncate rounded border px-1 py-0.5 text-[0.7rem] leading-tight ${tone[it.tone]}`} title={it.label}>
                      {it.href ? <Link href={it.href} className="no-underline">{it.label}</Link> : it.label}
                    </li>
                  ))}
                  {items.length > 4 && <li className="text-[0.7rem] text-graphite">+{items.length - 4} more</li>}
                </ul>
              </div>
            );
          })}
        </div>
        {/* Phone layout: agenda list */}
        <ol className="ruled text-sm md:hidden">
          {days
            .filter((d) => d.slice(0, 7) === ym && (byDay.get(d)?.length ?? 0) > 0)
            .map((d) => (
              <li key={d} className="py-2">
                <p className={`font-semibold ${d === v.today ? "text-margin" : ""}`}>{formatDate(d)}</p>
                <ul className="mt-1 grid gap-1">
                  {byDay.get(d)!.map((it) => (
                    <li key={it.key} className={`rounded border px-2 py-0.5 ${tone[it.tone]}`}>{it.href ? <Link href={it.href} className="no-underline">{it.label}</Link> : it.label}</li>
                  ))}
                </ul>
              </li>
            ))}
        </ol>
      </Section>

      <Section title="Events" description="Meetings, supervisor sessions, fieldwork trips and external deadlines.">
        {events.length > 0 && (
          <ul className="ruled mb-6 max-w-3xl text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  <strong>{e.title}</strong> <span className="text-graphite">· {EVENT_LABELS[e.kind]} · {formatDate(e.startDate)}{e.endDate !== e.startDate ? ` – ${formatDate(e.endDate)}` : ""}{e.startTime ? ` at ${e.startTime}` : ""}{e.location ? ` · ${e.location}` : ""}</span>
                </span>
                {v.canPlan && v.tier === "full" && (
                  <ActionForm action={eventAction} submitLabel="Remove" variant="quiet" className="flex">
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="eventId" value={e.id} />
                    <input type="hidden" name="intent" value="delete" />
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
        {v.tier !== "full" ? (
          <PlanNotice>Calendar events are part of full project planning, which is not included in the {v.planName} plan.</PlanNotice>
        ) : v.canPlan ? (
          <div className="max-w-3xl">
            <ActionForm action={eventAction} submitLabel="Add event" resetOnSuccess className="grid gap-4">
              <input type="hidden" name="projectId" value={projectId} />
              <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
                <Field label="Title" name="title" required maxLength={300} />
                <div className="field">
                  <label htmlFor="e-kind">Type</label>
                  <select id="e-kind" name="kind" className="input" defaultValue="meeting">
                    {Object.entries(EVENT_LABELS).map(([k, l]) => (
                      <option key={k} value={k}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-4">
                <Field label="Date" name="startDate" type="date" defaultValue={v.today} required />
                <Field label="Until" name="endDate" type="date" hint="Optional" />
                <Field label="Time" name="startTime" type="time" />
                <Field label="Location" name="location" maxLength={300} />
              </div>
            </ActionForm>
          </div>
        ) : null}
      </Section>
    </>
  );
}
