import { PROVIDERS, type ProviderKey } from "@researchmate/literature";
import { isAppError } from "@researchmate/shared";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { PlanNotice, Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { literatureAction } from "@/server/actions/literature";
import { loadLiterature, signRecord } from "@/server/literature";
import { literatureService } from "@/server/services";
import { WebResearch } from "@/components/web-research";

export const metadata = { title: "Find sources" };

const ABOUT: Record<ProviderKey, string> = {
  crossref: "DOIs for journals, books and conference papers across all fields",
  openalex: "Open index of scholarly works, with abstracts and open-access links",
  semantic_scholar: "Computer science, biomedicine and more, with abstracts",
  pubmed: "Biomedical and life sciences (NCBI)",
  europe_pmc: "Life sciences, including preprints and open-access full text",
  arxiv: "Preprints in physics, mathematics, computer science and related fields",
};

export default async function SearchPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ q?: string; provider?: string; cursor?: string }> }) {
  const { projectId } = await params;
  const sp = await searchParams;
  const v = await loadLiterature(projectId);
  const web = <WebResearch userId={v.session.user.id} projectId={projectId} organizationId={v.project.organizationId} canEdit={v.canEdit} />;
  if (!v.web)
    return (
      <>
        <PlanNotice>Scholarly search is not included in the {v.planName} plan. You can still import BibTeX or RIS files on the Library tab.</PlanNotice>
        {web}
      </>
    );
  const q = (sp.q ?? "").slice(0, 300);
  const provider = (sp.provider && sp.provider in PROVIDERS ? sp.provider : "openalex") as ProviderKey;
  let results: Awaited<ReturnType<ReturnType<typeof literatureService>["search"]>> | null = null;
  let error = "";
  if (q.trim().length >= 2) {
    try {
      results = await literatureService().search(v.session.user.id, projectId, provider, q, sp.cursor ?? null);
    } catch (err) {
      error = isAppError(err) ? err.message : "The search failed. Try again.";
    }
  }
  const hidden = <input type="hidden" name="projectId" value={projectId} />;

  return (
    <>
      <Section title="Search scholarly databases" description="Results come straight from the provider. Adding one records the provider and the retrieval time; you can then check it against the DOI registry.">
        <form className="grid max-w-3xl gap-3 sm:grid-cols-[1fr_14rem_auto] sm:items-end" role="search">
          <div className="field">
            <label htmlFor="s-q">Search terms</label>
            <input id="s-q" name="q" className="input" defaultValue={q} required minLength={2} placeholder="e.g. mobile money household savings" />
          </div>
          <div className="field">
            <label htmlFor="s-provider">Database</label>
            <select id="s-provider" name="provider" className="input" defaultValue={provider}>
              {Object.entries(PROVIDERS).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="submit">Search</button>
        </form>
        <p className="mt-2 text-xs text-graphite">{PROVIDERS[provider]}: {ABOUT[provider]}.</p>
      </Section>

      {error && <p role="alert" className="mb-6 rounded-md border border-margin/30 bg-margin-wash px-3 py-2 text-sm text-margin">{error}</p>}

      {results && (
        <Section title={`Results${results.total != null ? ` (${results.total.toLocaleString("en")} found)` : ""}`}>
          {results.records.length === 0 && <p className="text-sm text-graphite">Nothing found. Try other terms or another database.</p>}
          <ul className="grid gap-3">
            {results.records.map((r) => {
              const signed = signRecord(projectId, r);
              const names = r.authors.map((a) => a.family ?? a.literal ?? "").filter(Boolean);
              return (
                <li key={`${r.provider}:${r.externalId}`} className="rounded-md border border-rule bg-sheet p-4 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 max-w-3xl">
                      <p className="font-semibold">{r.title}</p>
                      <p className="text-graphite">
                        {names.length > 3 ? `${names.slice(0, 3).join(", ")} et al.` : names.join(", ") || "No author listed"} · {r.year ?? "n.d."}
                        {r.venue ? ` · ${r.venue}` : ""}
                      </p>
                      <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-graphite">
                        {r.doi && <span>doi:{r.doi}</span>}
                        <span>{r.access === "abstract" ? "Abstract available" : "Bibliographic details only"}</span>
                        {r.openAccessUrl && (
                          <a href={r.openAccessUrl} rel="noopener noreferrer" target="_blank">Open-access copy</a>
                        )}
                      </p>
                      {r.abstract && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-graphite">Abstract</summary>
                          <p className="mt-1 whitespace-pre-line">{r.abstract}</p>
                        </details>
                      )}
                    </div>
                    {r.inLibrary ? (
                      <Tag tone="done">In library</Tag>
                    ) : v.canEdit ? (
                      <ActionForm action={literatureAction} submitLabel="Add to library" variant="quiet" className="grid gap-2">
                        {hidden}
                        <input type="hidden" name="intent" value="add_search" />
                        <input type="hidden" name="record" value={signed.record} />
                        <input type="hidden" name="sig" value={signed.sig} />
                      </ActionForm>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {results.nextCursor && (
            <p className="mt-4">
              <Link href={`?${new URLSearchParams({ q, provider, cursor: results.nextCursor })}`}>More results</Link>
            </p>
          )}
        </Section>
      )}
          {web}
    </>
  );
}
