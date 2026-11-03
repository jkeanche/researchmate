import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { literatureAction } from "@/server/actions/literature";
import { loadLiterature } from "@/server/literature";
import { contentService, literatureService } from "@/server/services";

export const metadata = { title: "Evidence" };

const VER_TONE: Record<string, string> = { unverified: "todo", verified: "done", disputed: "blocked" };
const VER_LABEL: Record<string, string> = { unverified: "Not yet checked", verified: "Checked against source", disputed: "Disputed" };

export default async function EvidencePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ theme?: string; question?: string }> }) {
  const { projectId } = await params;
  const sp = await searchParams;
  const v = await loadLiterature(projectId);
  const uid = v.session.user.id;
  const [all, themes, refs, content] = await Promise.all([literatureService().listEvidence(uid, projectId), literatureService().themes(uid, projectId), literatureService().list(uid, projectId), contentService().list(uid, projectId)]);
  const rows = all.filter((r) => (!sp.theme || r.e.themeId === sp.theme) && (!sp.question || r.e.researchQuestionId === sp.question) && r.e.reviewStatus !== "rejected");
  const hidden = <input type="hidden" name="projectId" value={projectId} />;
  const base = `/app/projects/${projectId}/literature/evidence`;

  return (
    <>
      <p className="mb-6 max-w-3xl text-sm text-graphite">
        Each piece of evidence links to its source and, where possible, the page. Quotes found by the Evidence Extraction Agent were matched word for word against the attached document before you accepted them; mark them checked once you have confirmed the context.
      </p>

      <Section title={`Evidence (${rows.length})`}>
        <div className="mb-4 flex flex-wrap gap-2 text-sm">
          <span className="text-graphite">Theme:</span>
          <Link href={base} aria-current={!sp.theme && !sp.question ? "true" : undefined}>All</Link>
          {themes.map((t) => (
            <Link key={t.id} href={`${base}?theme=${t.id}`} className={sp.theme === t.id ? "font-semibold" : ""}>{t.name}</Link>
          ))}
          {content.questions.length > 0 && <span className="ml-4 text-graphite">Question:</span>}
          {content.questions.map((q, i) => (
            <Link key={q.id} href={`${base}?question=${q.id}`} title={q.text} className={sp.question === q.id ? "font-semibold" : ""}>RQ{i + 1}</Link>
          ))}
        </div>
        {rows.length === 0 && <p className="text-sm text-graphite">No evidence recorded{sp.theme || sp.question ? " for this filter" : " yet"}.</p>}
        <ul className="grid gap-3">
          {rows.map(({ e, citationKey, theme, question }) => (
            <li key={e.id} className="rounded-md border border-rule bg-sheet p-4 text-sm">
              <blockquote className="border-l-2 border-green pl-3 font-serif text-[0.9375rem]">“{e.passage}”</blockquote>
              {e.claim && <p className="mt-2"><span className="text-graphite">Supports: </span>{e.claim}</p>}
              <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-graphite">
                {citationKey ? <code>[@{citationKey}{e.page ? `, p. ${e.page}` : ""}]</code> : <span>From a project file{e.page ? `, p. ${e.page}` : ""}</span>}
                {theme && <span>Theme: {theme}</span>}
                {question && <span title={question}>Question: {question.length > 60 ? `${question.slice(0, 60)}…` : question}</span>}
                <span>{e.extractionMethod === "ai" ? "Found by AI, accepted by a person" : "Recorded by hand"}</span>
                <Tag tone={VER_TONE[e.verificationStatus]!}>{VER_LABEL[e.verificationStatus]}</Tag>
              </p>
              {v.canEdit && (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  {e.verificationStatus !== "verified" && (
                    <ActionForm action={literatureAction} submitLabel="Mark checked" variant="quiet" className="grid gap-2">
                      {hidden}
                      <input type="hidden" name="intent" value="evidence_status" />
                      <input type="hidden" name="evidenceId" value={e.id} />
                      <input type="hidden" name="verificationStatus" value="verified" />
                    </ActionForm>
                  )}
                  {e.verificationStatus !== "disputed" && (
                    <ActionForm action={literatureAction} submitLabel="Dispute" variant="quiet" className="grid gap-2">
                      {hidden}
                      <input type="hidden" name="intent" value="evidence_status" />
                      <input type="hidden" name="evidenceId" value={e.id} />
                      <input type="hidden" name="verificationStatus" value="disputed" />
                    </ActionForm>
                  )}
                  {themes.length > 0 && (
                    <ActionForm action={literatureAction} submitLabel="Set theme" variant="quiet" className="flex items-end gap-2">
                      {hidden}
                      <input type="hidden" name="intent" value="evidence_status" />
                      <input type="hidden" name="evidenceId" value={e.id} />
                      <div className="field">
                        <label htmlFor={`ev-theme-${e.id}`} className="sr-only">Theme</label>
                        <select id={`ev-theme-${e.id}`} name="themeId" className="input" defaultValue={e.themeId ?? ""}>
                          <option value="">No theme</option>
                          {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </div>
                    </ActionForm>
                  )}
                  <ActionForm action={literatureAction} submitLabel="Delete" variant="danger" className="grid gap-2">
                    {hidden}
                    <input type="hidden" name="intent" value="delete_evidence" />
                    <input type="hidden" name="evidenceId" value={e.id} />
                  </ActionForm>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>

      {v.canEdit && (
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <Section title="Record evidence">
            {refs.length === 0 ? (
              <p className="text-sm text-graphite">Add sources to the library first, so evidence can be traced to them.</p>
            ) : (
              <ActionForm action={literatureAction} submitLabel="Record evidence" resetOnSuccess>
                {hidden}
                <input type="hidden" name="intent" value="add_evidence" />
                <div className="field">
                  <label htmlFor="ev-passage">Quote or passage</label>
                  <textarea id="ev-passage" name="passage" className="input min-h-20" required maxLength={5000} />
                </div>
                <div className="field">
                  <label htmlFor="ev-claim">What it supports</label>
                  <textarea id="ev-claim" name="claim" className="input min-h-14" maxLength={2000} />
                </div>
                <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
                  <div className="field">
                    <label htmlFor="ev-ref">Source</label>
                    <select id="ev-ref" name="referenceId" className="input" required>
                      <option value="">Choose…</option>
                      {refs.map((r) => <option key={r.id} value={r.id}>[@{r.citationKey}] {r.title.slice(0, 80)}</option>)}
                    </select>
                  </div>
                  <Field id="ev-page" label="Page" name="page" inputMode="numeric" maxLength={6} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="field">
                    <label htmlFor="ev-question">Research question</label>
                    <select id="ev-question" name="researchQuestionId" className="input">
                      <option value="">—</option>
                      {content.questions.map((q, i) => <option key={q.id} value={q.id}>RQ{i + 1}: {q.text.slice(0, 70)}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="ev-themesel">Theme</label>
                    <select id="ev-themesel" name="themeId" className="input">
                      <option value="">—</option>
                      {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                </div>
              </ActionForm>
            )}
          </Section>
          <Section title="Themes" description="Group evidence for the literature review.">
            {themes.length > 0 && (
              <ul className="mb-4 grid gap-1 text-sm">
                {themes.map((t) => <li key={t.id}>{t.name} <span className="text-graphite">({all.filter((r) => r.e.themeId === t.id).length})</span></li>)}
              </ul>
            )}
            <ActionForm action={literatureAction} submitLabel="Add theme" variant="quiet" resetOnSuccess>
              {hidden}
              <input type="hidden" name="intent" value="add_theme" />
              <Field id="theme-name" label="Theme" name="name" required minLength={2} maxLength={120} />
            </ActionForm>
          </Section>
        </div>
      )}
    </>
  );
}
