import { isAppError } from "@researchmate/shared";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { AnalysisForm } from "@/components/analysis-form";
import { AnalysisResult } from "@/components/analysis-result";
import { PlanNotice } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { toolkitAction } from "@/server/actions/toolkit";
import { toolkitService } from "@/server/services";
import { ANALYSIS_LABELS, loadToolkit } from "@/server/toolkit";

export const metadata = { title: "Dataset" };

export default async function DatasetPage({ params }: { params: Promise<{ projectId: string; datasetId: string }> }) {
  const { projectId, datasetId } = await params;
  const v = await loadToolkit(projectId);
  const uid = v.session.user.id;
  const tk = await toolkitService();
  if (!/^[0-9a-f-]{36}$/i.test(datasetId)) notFound();
  const d = await tk.dataset(uid, datasetId).catch((e) => (isAppError(e) && e.code === "NOT_FOUND" ? null : Promise.reject(e)));
  if (!d || d.projectId !== projectId) notFound();
  const results = await tk.listAnalyses(uid, datasetId);
  const preview = d.rows.slice(0, 10);

  return (
    <>
      <h2 className="mb-1 text-xl font-semibold">{d.name}</h2>
      <p className="mb-6 text-sm text-graphite">
        {d.rowCount.toLocaleString("en")} rows · {d.columns.length} variables{d.sheet ? ` · sheet “${d.sheet}”` : ""} · <a href={`/api/projects/${projectId}/toolkit/dataset?id=${d.id}`}>Download cleaned CSV</a>
      </p>

      <Section title="Variables" description="Types are inferred on import. Set a label, change the type, or mark codes such as -99 as missing; each change is recorded as a cleaning step.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm">
            <thead>
              <tr className="text-left">
                <th scope="col" className="border-b border-rule px-2 py-1">Variable</th>
                <th scope="col" className="border-b border-rule px-2 py-1">Label</th>
                <th scope="col" className="border-b border-rule px-2 py-1">Type</th>
                <th scope="col" className="border-b border-rule px-2 py-1 text-right">Missing</th>
                {v.canEdit && <th scope="col" className="border-b border-rule px-2 py-1"><span className="sr-only">Edit</span></th>}
              </tr>
            </thead>
            <tbody>
              {d.columns.map((c) => (
                <tr key={c.name}>
                  <td className="border-b border-rule/60 px-2 py-1 font-mono text-xs">{c.name}</td>
                  <td className="border-b border-rule/60 px-2 py-1">{c.label}</td>
                  <td className="border-b border-rule/60 px-2 py-1">{c.type}</td>
                  <td className="border-b border-rule/60 px-2 py-1 text-right tabular-nums">{c.missing}</td>
                  {v.canEdit && (
                    <td className="border-b border-rule/60 px-2 py-1">
                      <details>
                        <summary className="cursor-pointer text-xs text-graphite">Edit</summary>
                        <ActionForm action={toolkitAction} submitLabel="Save variable" variant="quiet" className="mt-2 grid gap-2">
                          <input type="hidden" name="projectId" value={projectId} />
                          <input type="hidden" name="datasetId" value={d.id} />
                          <input type="hidden" name="intent" value="column" />
                          <input type="hidden" name="name" value={c.name} />
                          <label className="text-xs" htmlFor={`lbl-${c.name}`}>Label</label>
                          <input id={`lbl-${c.name}`} name="label" className="input" defaultValue={c.label} maxLength={200} />
                          <label className="text-xs" htmlFor={`typ-${c.name}`}>Type</label>
                          <select id={`typ-${c.name}`} name="type" className="input" defaultValue={c.type}>
                            <option value="numeric">numeric</option>
                            <option value="categorical">categorical</option>
                            <option value="text">text</option>
                          </select>
                          <label className="text-xs" htmlFor={`mis-${c.name}`}>Missing-value codes (comma-separated)</label>
                          <input id={`mis-${c.name}`} name="missingCodes" className="input" placeholder="-99, 999" />
                        </ActionForm>
                      </details>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {d.steps.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-graphite">Cleaning steps ({d.steps.length})</summary>
            <ol className="mt-2 list-decimal pl-6">
              {d.steps.map((s, i) => (
                <li key={i}>
                  {String(s.step).replace(/_/g, " ")} — {String(s.variable)}
                  {Array.isArray(s.codes) ? `: ${(s.codes as string[]).join(", ")}` : ""} ({String(s.at).slice(0, 16).replace("T", " ")})
                </li>
              ))}
            </ol>
          </details>
        )}
      </Section>

      <Section title="First rows">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-xs">
            <thead>
              <tr>{d.columns.map((c) => <th key={c.name} scope="col" className="border-b border-rule px-2 py-1 text-left font-mono">{c.name}</th>)}</tr>
            </thead>
            <tbody>
              {preview.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j} className="border-b border-rule/60 px-2 py-1">{c === null ? <span className="text-graphite">·</span> : String(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {v.canEdit && (
        <Section title="Run an analysis" description="Calculations are deterministic and run on the stored data. Rows with a missing value in a chosen variable are left out of that analysis (listwise deletion).">
          {!v.advanced && <div className="mb-3"><PlanNotice>Correlation, t-tests, ANOVA and regression are included in higher plans.</PlanNotice></div>}
          <AnalysisForm projectId={projectId} datasetId={d.id} columns={d.columns} advanced={v.advanced} />
        </Section>
      )}

      <Section title="Saved analyses">
        {results.length === 0 ? (
          <p className="text-sm text-graphite">No analyses yet.</p>
        ) : (
          <ul className="grid gap-4">
            {results.map((a) => (
              <li key={a.id} className="rounded-md border border-rule bg-sheet p-4">
                <p className="font-semibold">{ANALYSIS_LABELS[a.kind] ?? a.kind}</p>
                <p className="mb-3 text-xs text-graphite">{a.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC{a.notes ? ` · ${a.notes}` : ""}</p>
                <AnalysisResult kind={a.kind} result={a.result} />
                <details className="mt-3 text-xs text-graphite">
                  <summary className="cursor-pointer">Method and assumptions</summary>
                  <p className="mt-1 whitespace-pre-line">{a.method}</p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
