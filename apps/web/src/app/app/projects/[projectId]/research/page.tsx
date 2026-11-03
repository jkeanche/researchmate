import { ActionForm, Field } from "@/components/action-form";
import { Section } from "@/components/ui";
import { researchItemAction } from "@/server/actions/planning";
import { loadProject } from "@/server/plan";
import { contentService } from "@/server/services";

export const metadata = { title: "Research questions" };

export default async function ResearchPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { session, can, archived } = await loadProject(projectId);
  const { questions, objectives, hypotheses, alignment } = await contentService().list(session.user.id, projectId);
  const edit = can("project.update") && !archived;
  const label = new Map(alignment.rows.map((r) => [r.questionId, r.label]));
  const objLabel = new Map(objectives.map((o, i) => [o.id, `O${i + 1}`]));
  const hypLabel = new Map(hypotheses.map((h, i) => [h.id, `H${i + 1}`]));

  const controls = (kind: string, id: string, i: number, n: number) =>
    edit ? (
      <span className="no-print flex shrink-0 gap-1">
        {(
          [
            ["up", "↑", i > 0],
            ["down", "↓", i < n - 1],
            ["remove", "Remove", true],
          ] as const
        ).map(([intent, text, show]) =>
          show ? (
            <ActionForm key={intent} action={researchItemAction} submitLabel={text} variant="quiet" className="flex">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="intent" value={intent} />
            </ActionForm>
          ) : null,
        )}
      </span>
    ) : null;

  const questionSelect = (id: string, def?: string | null) => (
    <div className="field">
      <label htmlFor={id}>Answers question</label>
      <select id={id} name="questionId" className="input" defaultValue={def ?? ""}>
        <option value="">— Not linked —</option>
        {questions.map((q) => (
          <option key={q.id} value={q.id}>
            {label.get(q.id)}: {q.text.length > 70 ? `${q.text.slice(0, 68)}…` : q.text}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <>
      <Section title="Research questions">
        {questions.length === 0 && <p className="mb-4 text-sm text-graphite">No questions yet. Start with the main research question.</p>}
        <ol className="ruled mb-5 max-w-3xl">
          {questions.map((q, i) => (
            <li key={q.id} className="flex items-start justify-between gap-3 py-2">
              <p>
                <span className="mr-2 font-semibold tabular-nums text-green-dark">{label.get(q.id)}</span>
                {q.text}
              </p>
              {controls("question", q.id, i, questions.length)}
            </li>
          ))}
        </ol>
        {edit && (
          <div className="max-w-3xl">
            <ActionForm action={researchItemAction} submitLabel="Add question" resetOnSuccess className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="kind" value="question" />
              <div className="field">
                <label htmlFor="q-kind">Type</label>
                <select id="q-kind" name="questionKind" className="input" defaultValue={questions.some((q) => q.kind === "main") ? "specific" : "main"}>
                  <option value="main">Main question</option>
                  <option value="specific">Specific question</option>
                </select>
              </div>
              <Field id="q-text" label="Question" name="text" required maxLength={2000} />
            </ActionForm>
          </div>
        )}
      </Section>

      <Section title="Objectives">
        {objectives.length === 0 && <p className="mb-4 text-sm text-graphite">No objectives yet.</p>}
        <ol className="ruled mb-5 max-w-3xl">
          {objectives.map((o, i) => (
            <li key={o.id} className="flex items-start justify-between gap-3 py-2">
              <p>
                <span className="mr-2 font-semibold tabular-nums text-green-dark">{objLabel.get(o.id)}</span>
                {o.kind === "general" && <span className="mr-1 text-xs text-graphite uppercase">General ·</span>}
                {o.text}
                <span className="ml-2 text-xs text-graphite">{o.questionId && label.get(o.questionId) ? `→ ${label.get(o.questionId)}` : "Not linked to a question"}</span>
              </p>
              {controls("objective", o.id, i, objectives.length)}
            </li>
          ))}
        </ol>
        {edit && (
          <div className="max-w-3xl">
            <ActionForm action={researchItemAction} submitLabel="Add objective" resetOnSuccess className="grid gap-4">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="kind" value="objective" />
              <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                <div className="field">
                  <label htmlFor="o-kind">Type</label>
                  <select id="o-kind" name="objectiveKind" className="input" defaultValue="specific">
                    <option value="general">General</option>
                    <option value="specific">Specific</option>
                  </select>
                </div>
                <Field id="o-text" label="Objective" name="text" required maxLength={2000} />
              </div>
              {questionSelect("o-question")}
            </ActionForm>
          </div>
        )}
      </Section>

      <Section title="Hypotheses" description="Optional: for studies that test hypotheses.">
        {hypotheses.length > 0 && (
          <ol className="ruled mb-5 max-w-3xl text-sm">
            {hypotheses.map((h, i) => (
              <li key={h.id} className="flex items-start justify-between gap-3 py-2">
                <div>
                  <p className="font-semibold text-green-dark">
                    {hypLabel.get(h.id)} <span className="font-normal text-graphite">{h.questionId && label.get(h.questionId) ? `→ ${label.get(h.questionId)}` : ""}</span>
                  </p>
                  <p><span className="text-graphite">H₀:</span> {h.nullHypothesis}</p>
                  <p><span className="text-graphite">H₁:</span> {h.alternativeHypothesis}</p>
                </div>
                {controls("hypothesis", h.id, i, hypotheses.length)}
              </li>
            ))}
          </ol>
        )}
        {edit && (
          <div className="max-w-3xl">
            <ActionForm action={researchItemAction} submitLabel="Add hypothesis" resetOnSuccess className="grid gap-4">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="kind" value="hypothesis" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Null hypothesis (H₀)" name="nullHypothesis" required maxLength={2000} />
                <Field label="Alternative hypothesis (H₁)" name="alternativeHypothesis" required maxLength={2000} />
              </div>
              {questionSelect("h-question")}
            </ActionForm>
          </div>
        )}
      </Section>

      {questions.length > 0 && (
        <Section title="Alignment" description="Every question should be answered by at least one objective. Gaps are highlighted.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead className="text-left text-graphite">
                <tr className="border-b border-rule">
                  <th className="py-2 pr-3 font-semibold">Question</th>
                  <th className="py-2 pr-3 font-semibold">Objectives</th>
                  <th className="py-2 font-semibold">Hypotheses</th>
                </tr>
              </thead>
              <tbody className="ruled">
                {alignment.rows.map((r) => (
                  <tr key={r.questionId} className={r.objectiveIds.length ? "" : "bg-margin-wash/60"}>
                    <td className="py-2 pr-3">
                      <strong>{r.label}</strong> {r.text}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{r.objectiveIds.length ? r.objectiveIds.map((id) => objLabel.get(id)).join(", ") : <span className="font-semibold text-margin">None</span>}</td>
                    <td className="py-2 tabular-nums">{r.hypothesisIds.map((id) => hypLabel.get(id)).join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {alignment.unlinkedObjectiveIds.length > 0 && (
            <p className="mt-3 text-sm text-amber">Not linked to any question: {alignment.unlinkedObjectiveIds.map((id) => objLabel.get(id)).join(", ")}.</p>
          )}
        </Section>
      )}
    </>
  );
}
