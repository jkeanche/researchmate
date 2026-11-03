import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Notice, Tag } from "@/components/plan-ui";
import { SectionEditor } from "@/components/section-editor";
import { formatDateTime } from "@/lib/format";
import { documentAction } from "@/server/actions/documents";
import { loadDocument, SECTION_KIND } from "@/server/documents";
import { documentService, fileService, literatureService } from "@/server/services";

export const metadata = { title: "Write" };

export default async function WritePage({ params, searchParams }: { params: Promise<{ projectId: string; documentId: string }>; searchParams: Promise<{ s?: string }> }) {
  const { projectId, documentId } = await params;
  const { s: selectedKey } = await searchParams;
  const d = await loadDocument(projectId, documentId);
  const uid = d.session.user.id;
  const docs = await documentService();
  const [preview, comments, linked, refs, evidence, projectFiles] = await Promise.all([
    docs.preview(uid, documentId),
    docs.comments(uid, documentId),
    docs.sectionEvidence(uid, documentId),
    literatureService().list(uid, projectId),
    literatureService().listEvidence(uid, projectId),
    d.can("project.files.read") ? fileService().then((f) => f.list(uid, d.project.organizationId, { projectId })) : Promise.resolve([]),
  ]);
  const editable = d.sections.filter((s) => !["title", "toc", "references"].includes(s.kind));
  const selected = d.sections.find((s) => s.key === selectedKey) ?? editable[0] ?? d.sections[0]!;
  const words = new Map(preview.model.sections.map((s) => [s.section.id, s.words]));
  const base = `/app/projects/${projectId}/documents/${documentId}`;
  const hidden = (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="documentId" value={documentId} />
    </>
  );
  const sectionComments = comments.filter((c) => c.c.sectionId === selected.id && !c.c.parentId);
  const replies = (id: string) => comments.filter((c) => c.c.parentId === id);
  const linkedHere = linked.filter((l) => l.sectionId === selected.id);
  const generated = ["title", "toc", "references"].includes(selected.kind);
  const fails = preview.checks.filter((c) => c.status === "fail").length;

  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_1fr_18rem]">
      <nav aria-label="Sections" className="lg:sticky lg:top-4 lg:self-start">
        <ol className="grid gap-0.5 text-sm">
          {d.sections.map((s) => {
            const w = words.get(s.id) ?? 0;
            const over = s.wordLimit && w > s.wordLimit;
            return (
              <li key={s.id}>
                <Link href={`${base}?s=${s.key}`} aria-current={s.id === selected.id ? "true" : undefined} className={`flex items-center justify-between gap-2 rounded px-2 py-1 no-underline ${s.id === selected.id ? "bg-ink text-paper" : "text-ink hover:bg-rule-soft"}`}>
                  <span className="truncate">{s.title}{s.required && !["title", "toc", "references"].includes(s.kind) && !s.content.trim() ? " •" : ""}</span>
                  {!["title", "toc", "references"].includes(s.kind) && <span className={`shrink-0 text-xs tabular-nums ${over ? "font-semibold text-margin" : "opacity-70"}`}>{w}</span>}
                </Link>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 px-2 text-xs text-graphite">
          Main text: {preview.model.words.body.toLocaleString("en")} words
          {preview.spec.limits.maxWords ? ` of ${preview.spec.limits.maxWords.toLocaleString("en")}` : ""}. • = required, still empty.
        </p>
        <p className="mt-2 px-2 text-xs">
          <Link href={`${base}/audit`}>{fails ? `${fails} check${fails === 1 ? "" : "s"} failing` : "All content checks pass"}</Link>
        </p>
      </nav>

      <section aria-labelledby="sec-title" className="min-w-0">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="sec-title" className="font-serif text-xl">{selected.title}</h3>
          <span className="text-xs text-graphite">{SECTION_KIND[selected.kind]}{selected.required ? " · required" : " · optional"}</span>
        </div>
        {selected.guidance && <p className="mb-3 text-sm text-graphite">{selected.guidance}</p>}
        {generated ? (
          <Notice>
            {selected.kind === "title" ? "The title page is generated from the document's details (Specification tab)." : selected.kind === "toc" ? "The table of contents is generated from the headings when you export." : "The reference list is generated from the sources you cite, in the document's citation style."}{" "}
            <Link href={`${base}/preview`}>See the preview</Link>.
          </Notice>
        ) : (
          <SectionEditor
            key={selected.id}
            sectionId={selected.id}
            initialContent={selected.content}
            initialVersion={selected.version}
            wordLimit={selected.wordLimit}
            canEdit={d.canEdit}
            refs={refs.map((r) => ({ key: r.citationKey, title: r.title, year: r.year }))}
            images={projectFiles.filter((f) => f.mimeType === "image/png" || f.mimeType === "image/jpeg").map((f) => ({ id: f.id, name: f.originalName }))}
            quotes={linkedHere.map((l) => ({ key: l.key, page: l.e.page, passage: l.e.passage }))}
          />
        )}
      </section>

      <aside className="grid content-start gap-6">
        {!generated && (
          <section aria-labelledby="ev-h">
            <h3 id="ev-h" className="mb-2 font-sans text-sm font-semibold">Evidence for this section</h3>
            {linkedHere.length === 0 && <p className="text-xs text-graphite">None linked.</p>}
            <ul className="grid gap-2 text-xs">
              {linkedHere.map((l) => (
                <li key={l.e.id} className="rounded border border-rule-soft bg-sheet p-2">
                  “{l.e.passage.slice(0, 160)}{l.e.passage.length > 160 ? "…" : ""}” {l.key && <code>[@{l.key}]</code>}
                  {d.canEdit && (
                    <ActionForm action={documentAction} submitLabel="Unlink" variant="quiet" className="mt-1 flex">
                      {hidden}
                      <input type="hidden" name="intent" value="unlink_evidence" />
                      <input type="hidden" name="sectionId" value={selected.id} />
                      <input type="hidden" name="evidenceId" value={l.e.id} />
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
            {d.canEdit && evidence.length > 0 && (
              <ActionForm action={documentAction} submitLabel="Link" variant="quiet" className="mt-2 grid gap-2">
                {hidden}
                <input type="hidden" name="intent" value="link_evidence" />
                <input type="hidden" name="sectionId" value={selected.id} />
                <div className="field">
                  <label htmlFor="link-ev" className="text-xs">Link evidence</label>
                  <select id="link-ev" name="evidenceId" className="input text-xs" required>
                    <option value="">Choose…</option>
                    {evidence.filter((e) => !linkedHere.some((l) => l.e.id === e.e.id) && e.e.reviewStatus !== "rejected").map((e) => (
                      <option key={e.e.id} value={e.e.id}>{e.citationKey ? `@${e.citationKey}: ` : ""}{e.e.passage.slice(0, 60)}</option>
                    ))}
                  </select>
                </div>
              </ActionForm>
            )}
          </section>
        )}

        <section aria-labelledby="cm-h">
          <h3 id="cm-h" className="mb-2 font-sans text-sm font-semibold">Comments</h3>
          {sectionComments.length === 0 && <p className="text-xs text-graphite">No comments on this section.</p>}
          <ul className="grid gap-2 text-sm">
            {sectionComments.map(({ c, author }) => (
              <li key={c.id} className={`rounded border p-2 ${c.resolvedAt ? "border-rule-soft opacity-70" : "border-rule bg-sheet"}`}>
                {c.quote && <p className="mb-1 border-l-2 border-amber pl-2 text-xs text-graphite">“{c.quote}”</p>}
                <p>{c.body}</p>
                <p className="mt-1 text-xs text-graphite">{author ?? "Former member"} · {formatDateTime(c.createdAt)} {c.resolvedAt && <Tag tone="done">Resolved</Tag>}</p>
                {replies(c.id).map((r) => (
                  <div key={r.c.id} className="mt-2 border-l border-rule pl-2">
                    <p>{r.c.body}</p>
                    <p className="text-xs text-graphite">{r.author ?? "Former member"} · {formatDateTime(r.c.createdAt)}</p>
                  </div>
                ))}
                {d.canComment && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <ActionForm action={documentAction} submitLabel="Reply" variant="quiet" resetOnSuccess className="grid w-full gap-1">
                      {hidden}
                      <input type="hidden" name="intent" value="comment" />
                      <input type="hidden" name="parentId" value={c.id} />
                      <label htmlFor={`reply-${c.id}`} className="sr-only">Reply</label>
                      <textarea id={`reply-${c.id}`} name="body" className="input min-h-10 text-sm" required maxLength={5000} />
                    </ActionForm>
                    <ActionForm action={documentAction} submitLabel={c.resolvedAt ? "Reopen" : "Resolve"} variant="quiet" className="flex">
                      {hidden}
                      <input type="hidden" name="intent" value="resolve" />
                      <input type="hidden" name="commentId" value={c.id} />
                      <input type="hidden" name="resolved" value={c.resolvedAt ? "false" : "true"} />
                    </ActionForm>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {d.canComment && (
            <ActionForm action={documentAction} submitLabel="Comment" variant="quiet" resetOnSuccess className="mt-3 grid gap-2">
              {hidden}
              <input type="hidden" name="intent" value="comment" />
              <input type="hidden" name="sectionId" value={selected.id} />
              <div className="field">
                <label htmlFor="cm-quote" className="text-xs">Text you're commenting on (optional)</label>
                <input id="cm-quote" name="quote" className="input text-sm" maxLength={1000} />
              </div>
              <div className="field">
                <label htmlFor="cm-body" className="text-xs">Comment</label>
                <textarea id="cm-body" name="body" className="input min-h-16 text-sm" required maxLength={5000} />
              </div>
            </ActionForm>
          )}
        </section>
      </aside>
    </div>
  );
}
