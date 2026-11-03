import { CITATION_STYLES, type CslItem, formatBibliography, type StyleKey } from "@researchmate/citations";
import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { literatureAction } from "@/server/actions/literature";
import { ACCESS_LABELS, loadLiterature, VERIFICATION_LABELS, VERIFICATION_TONE } from "@/server/literature";
import { fileService, literatureService } from "@/server/services";

export const metadata = { title: "Library" };

const TYPES: [string, string][] = [
  ["article-journal", "Journal article"],
  ["book", "Book"],
  ["chapter", "Book chapter"],
  ["paper-conference", "Conference paper"],
  ["report", "Report"],
  ["thesis", "Thesis"],
  ["webpage", "Web page"],
  ["dataset", "Dataset"],
];

const authorsOf = (csl: CslItem) => {
  const a = (csl.author ?? []).map((n) => n.family ?? n.literal ?? "").filter(Boolean);
  return a.length > 3 ? `${a.slice(0, 3).join(", ")} et al.` : a.join(", ");
};

export default async function LibraryPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ q?: string; style?: string }> }) {
  const { projectId } = await params;
  const sp = await searchParams;
  const v = await loadLiterature(projectId);
  const uid = v.session.user.id;
  const q = (sp.q ?? "").slice(0, 200);
  const style = (sp.style && sp.style in CITATION_STYLES ? sp.style : "apa7") as StyleKey;
  const [refs, dups, projectFiles] = await Promise.all([
    literatureService().list(uid, projectId, q),
    q ? Promise.resolve([]) : literatureService().duplicates(uid, projectId),
    v.canEdit ? fileService().then((s) => s.list(uid, v.project.organizationId, { projectId })) : Promise.resolve([]),
  ]);
  const hidden = <input type="hidden" name="projectId" value={projectId} />;
  let bibliography: string[] = [];
  let bibError = "";
  if (refs.length) {
    try {
      bibliography = formatBibliography(style, refs.map((r) => ({ ...(r.csl as CslItem), id: r.citationKey })));
    } catch {
      bibError = "The bibliography could not be formatted.";
    }
  }
  const counts = refs.reduce<Record<string, number>>((m, r) => ((m[r.verificationStatus] = (m[r.verificationStatus] ?? 0) + 1), m), {});

  return (
    <>
      <p className="mb-6 max-w-3xl text-sm text-graphite">
        Every source records where it came from and what has been checked. <strong>Verified</strong> means the details match the DOI registry; <strong>reviewed</strong> means someone on the project has read the attached full text. AI tools only cite sources in this library.
      </p>

      <Section
        title={`Sources (${refs.length})`}
        aside={
          <span className="flex flex-wrap gap-3 text-sm">
            <a href={`/api/projects/${projectId}/references/export?format=bibtex`} aria-label="Export library as BibTeX">Export BibTeX</a>
            <a href={`/api/projects/${projectId}/references/export?format=ris`} aria-label="Export library as RIS">Export RIS</a>
          </span>
        }
      >
        <form className="mb-4 flex flex-wrap items-end gap-2" role="search">
          <div className="field min-w-64 flex-1">
            <label htmlFor="lib-q">Search the library</label>
            <input id="lib-q" name="q" className="input" defaultValue={q} placeholder="Title, author, abstract…" />
          </div>
          <button className="btn btn-quiet" type="submit">Search</button>
          {q && <Link href={`/app/projects/${projectId}/literature`} className="text-sm">Clear</Link>}
        </form>
        {Object.keys(counts).length > 0 && (
          <p className="mb-3 flex flex-wrap gap-2 text-xs text-graphite">
            {Object.entries(counts).map(([k, n]) => (
              <Tag key={k} tone={VERIFICATION_TONE[k]!}>{VERIFICATION_LABELS[k]}: {n}</Tag>
            ))}
          </p>
        )}
        {refs.length === 0 && <p className="text-sm text-graphite">{q ? "No sources match." : "No sources yet. Find them on the Find sources tab, import a BibTeX or RIS file, or add one by hand."}</p>}
        <ul className="grid gap-3">
          {refs.map((r) => {
            const csl = r.csl as CslItem;
            return (
              <li key={r.id} className="rounded-md border border-rule bg-sheet p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold">{r.title}</p>
                    <p className="text-graphite">
                      {authorsOf(csl) || "No author"} · {r.year ?? "n.d."}
                      {csl["container-title"] ? ` · ${csl["container-title"]}` : ""}
                    </p>
                    <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-graphite">
                      <code>[@{r.citationKey}]</code>
                      {r.doi && (
                        <a href={`https://doi.org/${r.doi}`} rel="noopener noreferrer" target="_blank">doi:{r.doi}</a>
                      )}
                      <span>{ACCESS_LABELS[r.accessLevel]}</span>
                      <span>Source: {r.sourceProvider}</span>
                    </p>
                  </div>
                  <Tag tone={VERIFICATION_TONE[r.verificationStatus]!}>{VERIFICATION_LABELS[r.verificationStatus]}</Tag>
                </div>
                {v.canEdit && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-graphite">Manage</summary>
                    <div className="mt-3 flex flex-wrap items-end gap-4">
                      {r.doi && (
                        <ActionForm action={literatureAction} submitLabel="Check against DOI registry" pendingLabel="Checking…" variant="quiet" className="grid gap-2">
                          {hidden}
                          <input type="hidden" name="intent" value="verify" />
                          <input type="hidden" name="referenceId" value={r.id} />
                        </ActionForm>
                      )}
                      <ActionForm action={literatureAction} submitLabel="Attach full text" variant="quiet" className="flex flex-wrap items-end gap-2">
                        {hidden}
                        <input type="hidden" name="intent" value="attach" />
                        <input type="hidden" name="referenceId" value={r.id} />
                        <div className="field">
                          <label htmlFor={`att-${r.id}`}>Project file</label>
                          <select id={`att-${r.id}`} name="fileId" className="input" defaultValue={r.fileId ?? ""} required>
                            <option value="">Choose a file…</option>
                            {projectFiles.map((f) => (
                              <option key={f.id} value={f.id}>{f.originalName}</option>
                            ))}
                          </select>
                        </div>
                      </ActionForm>
                      {r.accessLevel === "full_text" && r.verificationStatus !== "full_text_reviewed" && (
                        <ActionForm action={literatureAction} submitLabel="I have read the full text" variant="quiet" className="grid gap-2">
                          {hidden}
                          <input type="hidden" name="intent" value="reviewed" />
                          <input type="hidden" name="referenceId" value={r.id} />
                        </ActionForm>
                      )}
                      <ActionForm action={literatureAction} submitLabel="Remove" variant="danger" className="grid gap-2">
                        {hidden}
                        <input type="hidden" name="intent" value="remove" />
                        <input type="hidden" name="referenceId" value={r.id} />
                      </ActionForm>
                    </div>
                    {projectFiles.length === 0 && <p className="mt-2 text-xs text-graphite">Upload the PDF on the project Overview to attach it here.</p>}
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      {dups.length > 0 && (
        <Section title="Possible duplicates" description="Same DOI or the same title. Remove the copy you don't need.">
          <ul className="grid gap-2 text-sm">
            {dups.map((g) => (
              <li key={g.map((r) => r.id).join()} className="rounded-md border border-amber/30 bg-amber-wash px-3 py-2">
                {g.map((r) => `[@${r.citationKey}] ${r.title} (${r.year ?? "n.d."})`).join("  ·  ")}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {refs.length > 0 && (
        <Section title="Bibliography preview">
          <form className="mb-3 flex items-end gap-2">
            {q && <input type="hidden" name="q" value={q} />}
            <div className="field">
              <label htmlFor="lib-style">Style</label>
              <select id="lib-style" name="style" className="input" defaultValue={style}>
                {Object.entries(CITATION_STYLES).map(([k, s]) => (
                  <option key={k} value={k}>{s.name}</option>
                ))}
              </select>
            </div>
            <button className="btn btn-quiet" type="submit">Show</button>
          </form>
          {bibError ? <p className="text-sm text-margin">{bibError}</p> : (
            <ol className="grid max-w-3xl gap-2 font-serif text-[0.9375rem]" aria-label={`Bibliography in ${CITATION_STYLES[style].name}`}>
              {bibliography.map((b, i) => (
                <li key={i} className="pl-6 -indent-6">{b}</li>
              ))}
            </ol>
          )}
        </Section>
      )}

      {v.canEdit && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Import" description="BibTeX (.bib) or RIS (.ris), up to 1 MB. Sources already in the library are skipped.">
            <ActionForm action={literatureAction} submitLabel="Import" resetOnSuccess>
              {hidden}
              <input type="hidden" name="intent" value="import" />
              <div className="field">
                <label htmlFor="imp-file">File</label>
                <input id="imp-file" name="file" type="file" accept=".bib,.ris,.txt,text/plain" className="input" />
              </div>
              <div className="field">
                <label htmlFor="imp-text">Or paste entries</label>
                <textarea id="imp-text" name="text" className="input min-h-24 font-mono text-xs" />
              </div>
              <div className="field">
                <label htmlFor="imp-format">Format</label>
                <select id="imp-format" name="format" className="input" defaultValue="auto">
                  <option value="auto">Detect</option>
                  <option value="bibtex">BibTeX</option>
                  <option value="ris">RIS</option>
                </select>
              </div>
            </ActionForm>
          </Section>

          <Section title="Add a source by hand" description="Manual entries start unverified. Add a DOI so they can be checked.">
            <ActionForm action={literatureAction} submitLabel="Add source" resetOnSuccess>
              {hidden}
              <input type="hidden" name="intent" value="add_manual" />
              <div className="field">
                <label htmlFor="man-type">Type</label>
                <select id="man-type" name="type" className="input">
                  {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <Field id="man-title" label="Title" name="title" required maxLength={1000} />
              <Field id="man-authors" label="Authors" name="authors" hint="Family, Given; separate people with semicolons" maxLength={2000} />
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="man-year" label="Year" name="year" inputMode="numeric" maxLength={4} />
                <Field id="man-volume" label="Volume" name="volume" maxLength={40} />
                <Field id="man-pages" label="Pages" name="pages" maxLength={40} />
              </div>
              <Field id="man-container" label="Journal or book" name="containerTitle" maxLength={500} />
              <Field id="man-doi" label="DOI" name="doi" maxLength={300} placeholder="10.xxxx/…" />
              <Field id="man-url" label="URL" name="url" type="url" maxLength={2000} />
            </ActionForm>
          </Section>
        </div>
      )}
    </>
  );
}
