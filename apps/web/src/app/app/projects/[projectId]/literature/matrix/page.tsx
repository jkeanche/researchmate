import { ActionForm } from "@/components/action-form";
import { Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { literatureAction } from "@/server/actions/literature";
import { ACCESS_LABELS, loadLiterature } from "@/server/literature";
import { literatureService } from "@/server/services";

export const metadata = { title: "Literature matrix" };

const COLS = [
  ["objective", "Objective"],
  ["methodology", "Method"],
  ["population", "Population / setting"],
  ["findings", "Findings"],
  ["limitations", "Limitations"],
  ["researchGap", "Gap"],
] as const;
const BASIS = { metadata: "Bibliographic details", abstract: "Abstract", full_text: "Full text" } as const;
const RANK = { metadata: 0, abstract: 1, full_text: 2 } as const;

export default async function MatrixPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadLiterature(projectId);
  const rows = await literatureService().matrix(v.session.user.id, projectId);
  const filled = rows.filter((r) => r.entry);

  return (
    <>
      <p className="mb-6 max-w-3xl text-sm text-graphite">
        One row per source. The <strong>basis</strong> says what each row was written from; it can't be more than the content held, so a row for a source with only its abstract is marked “Abstract”. The Literature Review Agent drafts from these rows and your evidence.
      </p>

      <Section title={`Matrix (${filled.length} of ${rows.length} sources)`}>
        {filled.length === 0 ? (
          <p className="text-sm text-graphite">No rows yet. Fill one in for each source below.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] border-collapse text-left text-sm">
              <caption className="sr-only">Literature matrix</caption>
              <thead>
                <tr className="border-b border-rule">
                  <th scope="col" className="py-2 pr-3">Source</th>
                  {COLS.map(([, l]) => <th key={l} scope="col" className="py-2 pr-3">{l}</th>)}
                  <th scope="col" className="py-2">Basis</th>
                </tr>
              </thead>
              <tbody>
                {filled.map(({ reference: r, entry: e }) => (
                  <tr key={r.id} className="border-b border-rule-soft align-top">
                    <th scope="row" className="py-2 pr-3 font-normal"><code className="text-xs">[@{r.citationKey}]</code><br />{r.title.slice(0, 80)}</th>
                    {COLS.map(([k]) => <td key={k} className="py-2 pr-3 whitespace-pre-line">{e![k]}</td>)}
                    <td className="py-2"><Tag tone={e!.basis === "full_text" ? "done" : "todo"}>{BASIS[e!.basis as keyof typeof BASIS]}</Tag></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {v.canEdit && rows.length > 0 && (
        <Section title="Edit rows">
          <ul className="grid gap-3">
            {rows.map(({ reference: r, entry: e }) => (
              <li key={r.id} className="rounded-md border border-rule bg-sheet p-3 text-sm">
                <details>
                  <summary className="cursor-pointer">
                    <code className="text-xs">[@{r.citationKey}]</code> {r.title.slice(0, 100)} <span className="text-graphite">· {ACCESS_LABELS[r.accessLevel]}{e ? "" : " · no row yet"}</span>
                  </summary>
                  <ActionForm action={literatureAction} submitLabel="Save row" className="mt-3 grid gap-3">
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="intent" value="save_matrix" />
                    <input type="hidden" name="referenceId" value={r.id} />
                    <div className="grid gap-3 md:grid-cols-2">
                      {COLS.map(([k, l]) => (
                        <div key={k} className="field">
                          <label htmlFor={`m-${r.id}-${k}`}>{l}</label>
                          <textarea id={`m-${r.id}-${k}`} name={k} className="input min-h-14" defaultValue={e?.[k] ?? ""} maxLength={k === "findings" ? 5000 : 3000} />
                        </div>
                      ))}
                    </div>
                    <div className="field max-w-xs">
                      <label htmlFor={`m-${r.id}-basis`}>Written from</label>
                      <select id={`m-${r.id}-basis`} name="basis" className="input" defaultValue={e?.basis ?? (r.accessLevel === "full_text" ? "full_text" : r.accessLevel)}>
                        {(Object.keys(BASIS) as (keyof typeof BASIS)[]).filter((b) => RANK[b] <= RANK[r.accessLevel as keyof typeof RANK]).map((b) => (
                          <option key={b} value={b}>{BASIS[b]}</option>
                        ))}
                      </select>
                    </div>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
