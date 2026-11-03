import { RISK_CATEGORIES, RISK_STATUSES } from "@researchmate/database";
import { ActionForm, Field } from "@/components/action-form";
import { PlanNotice, Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { riskAction } from "@/server/actions/planning";
import { loadPlanView } from "@/server/plan";
import { memberService, planningService } from "@/server/services";

export const metadata = { title: "Risks" };

const CATEGORY_LABELS: Record<string, string> = {
  schedule: "Schedule",
  data_collection: "Data collection",
  ethics: "Ethics",
  financial: "Financial",
  technical: "Technical",
  personnel: "Personnel",
  supervision: "Supervision",
  other: "Other",
};
const STATUS_LABELS: Record<string, string> = { open: "Open", mitigating: "Mitigating", occurred: "Occurred", closed: "Closed" };
const LEVELS = ["Very low", "Low", "Medium", "High", "Very high"];
const severity = (score: number) => (score >= 15 ? "bad" : score >= 8 ? "warn" : "ok");
const cellTone = { bad: "bg-margin-wash text-margin", warn: "bg-amber-wash text-amber", ok: "bg-green-wash text-green-dark" };

type Risk = Awaited<ReturnType<ReturnType<typeof planningService>["listRisks"]>>[number]["risk"];

function RiskFields({ r, people, tasks }: { r?: Risk; people: { userId: string; displayName: string }[]; tasks: { id: string; label: string }[] }) {
  const id = r?.id ?? "new";
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
        <Field id={`r-${id}-title`} label="Risk" name="title" defaultValue={r?.title} required maxLength={300} />
        <div className="field">
          <label htmlFor={`r-${id}-cat`}>Category</label>
          <select id={`r-${id}-cat`} name="category" className="input" defaultValue={r?.category ?? "schedule"}>
            {RISK_CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        {(["likelihood", "impact"] as const).map((k) => (
          <div key={k} className="field">
            <label htmlFor={`r-${id}-${k}`}>{k === "likelihood" ? "Likelihood" : "Impact"}</label>
            <select id={`r-${id}-${k}`} name={k} className="input" defaultValue={String(r?.[k] ?? 3)}>
              {LEVELS.map((l, i) => (
                <option key={l} value={i + 1}>{i + 1} · {l}</option>
              ))}
            </select>
          </div>
        ))}
        <div className="field">
          <label htmlFor={`r-${id}-status`}>Status</label>
          <select id={`r-${id}-status`} name="status" className="input" defaultValue={r?.status ?? "open"}>
            {RISK_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <Field id={`r-${id}-review`} label="Review by" name="reviewDate" type="date" defaultValue={r?.reviewDate ?? ""} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="field">
          <label htmlFor={`r-${id}-owner`}>Owner</label>
          <select id={`r-${id}-owner`} name="ownerUserId" className="input" defaultValue={r?.ownerUserId ?? ""}>
            <option value="">—</option>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>{p.displayName}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`r-${id}-task`}>Affects task</label>
          <select id={`r-${id}-task`} name="taskId" className="input" defaultValue={r?.taskId ?? ""}>
            <option value="">—</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>
      {(
        [
          ["description", "Description", r?.description],
          ["mitigation", "Mitigation (reduce the chance or impact)", r?.mitigation],
          ["contingency", "Contingency (what to do if it happens)", r?.contingency],
        ] as const
      ).map(([n, l, val]) => (
        <div key={n} className="field">
          <label htmlFor={`r-${id}-${n}`}>{l}</label>
          <textarea id={`r-${id}-${n}`} name={n} className="input min-h-16" defaultValue={val ?? ""} maxLength={5000} />
        </div>
      ))}
    </>
  );
}

export default async function RisksPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadPlanView(projectId);
  const [risks, people] = await Promise.all([planningService().listRisks(v.session.user.id, projectId), memberService().assignable(v.session.user.id, projectId)]);
  const edit = v.canPlan && v.tier === "full";
  const live = risks.filter((r) => r.risk.status === "open" || r.risk.status === "mitigating" || r.risk.status === "occurred");
  const taskOpts = v.tasks.map((t) => ({ id: t.id, label: `${t.wbs} ${t.title}` }));
  const taskTitle = new Map(taskOpts.map((t) => [t.id, t.label]));

  return (
    <>
      <Section title="Risk matrix" description="Open and mitigating risks by likelihood and impact. Scores of 15 or more need attention first.">
        <div className="overflow-x-auto">
          <table className="border-collapse text-xs" aria-label="Risk matrix: likelihood rows, impact columns">
            <thead>
              <tr>
                <th className="p-1" />
                {LEVELS.map((l, i) => (
                  <th key={l} scope="col" className="w-20 p-1 font-semibold text-graphite">Impact {i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[5, 4, 3, 2, 1].map((lk) => (
                <tr key={lk}>
                  <th scope="row" className="pr-2 text-right font-semibold whitespace-nowrap text-graphite">Likelihood {lk}</th>
                  {[1, 2, 3, 4, 5].map((im) => {
                    const n = live.filter((r) => r.risk.likelihood === lk && r.risk.impact === im).length;
                    return (
                      <td key={im} className={`h-12 border border-sheet text-center text-base font-semibold tabular-nums ${cellTone[severity(lk * im)]}`} aria-label={`Likelihood ${lk}, impact ${im}: ${n} risk${n === 1 ? "" : "s"}`}>
                        {n || ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Risk register">
        {risks.length === 0 && <p className="mb-4 text-sm text-graphite">No risks recorded yet.</p>}
        <ul className="mb-6 grid gap-3">
          {risks.map(({ risk: r, ownerName }) => {
            const score = r.likelihood * r.impact;
            return (
              <li key={r.id} className="rounded-md border border-rule bg-sheet p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-sans text-base font-semibold">{r.title}</h3>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-graphite">
                      <span className={`rounded px-1.5 py-0.5 font-semibold tabular-nums ${cellTone[severity(score)]}`}>Score {score}</span>
                      <Tag tone={r.status}>{STATUS_LABELS[r.status]}</Tag>
                      {CATEGORY_LABELS[r.category]} · L{r.likelihood} × I{r.impact}
                      {ownerName ? ` · ${ownerName}` : ""}
                      {r.reviewDate ? ` · review by ${formatDate(r.reviewDate)}` : ""}
                      {r.taskId && taskTitle.get(r.taskId) ? ` · affects ${taskTitle.get(r.taskId)}` : ""}
                    </p>
                  </div>
                </div>
                {r.description && <p className="mt-2 text-sm">{r.description}</p>}
                {(r.mitigation || r.contingency) && (
                  <dl className="mt-2 grid gap-1 text-sm">
                    {r.mitigation && <div><dt className="inline font-semibold">Mitigation: </dt><dd className="inline">{r.mitigation}</dd></div>}
                    {r.contingency && <div><dt className="inline font-semibold">Contingency: </dt><dd className="inline">{r.contingency}</dd></div>}
                  </dl>
                )}
                {edit && (
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-graphite">Edit</summary>
                    <div className="mt-3 grid max-w-3xl gap-3">
                      <ActionForm action={riskAction} submitLabel="Save risk" className="grid gap-4">
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="riskId" value={r.id} />
                        <input type="hidden" name="intent" value="update" />
                        <RiskFields r={r} people={people} tasks={taskOpts} />
                      </ActionForm>
                      <ActionForm action={riskAction} submitLabel="Delete risk" variant="danger" className="flex">
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="riskId" value={r.id} />
                        <input type="hidden" name="intent" value="delete" />
                      </ActionForm>
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
        {v.tier !== "full" ? (
          <PlanNotice>The risk register is part of full project planning, which is not included in the {v.planName} plan.</PlanNotice>
        ) : edit ? (
          <details className="max-w-3xl" open={risks.length === 0}>
            <summary className="cursor-pointer font-semibold">Add a risk</summary>
            <div className="mt-4">
              <ActionForm action={riskAction} submitLabel="Add risk" resetOnSuccess className="grid gap-4">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="intent" value="create" />
                <RiskFields people={people} tasks={taskOpts} />
              </ActionForm>
            </div>
          </details>
        ) : null}
      </Section>
    </>
  );
}
