import { isAppError } from "@researchmate/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { DocPreview } from "@/components/doc-preview";
import { Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import { REVIEW_STATUS, SEVERITY, TASK_STATUS } from "@/lib/review-labels";
import { collaborationAction } from "@/server/actions/collaboration";
import { loadProject } from "@/server/plan";
import { collaborationService, documentService } from "@/server/services";

export const metadata = { title: "Review" };

export default async function ReviewPage({ params }: { params: Promise<{ projectId: string; requestId: string }> }) {
  const { projectId, requestId } = await params;
  const { session, archived } = await loadProject(projectId);
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) notFound();
  const c = await collaborationService();
  let view;
  try {
    view = await c.get(session.user.id, requestId);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (view.request.projectId !== projectId) notFound();
  const { request: r, document: doc, feedback, comments, tasks, names } = view;
  const preview = await (await documentService()).previewVersion(session.user.id, r.versionId);
  const exp = r.exportId ? (await (await documentService()).exports(session.user.id, doc.id)).find((e) => e.x.id === r.exportId) : undefined;
  const canReview = view.canReview && !archived;
  const canEdit = view.canEdit && !archived;
  const canVerify = view.canVerify && !archived;
  const hidden = (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="requestId" value={requestId} />
    </>
  );
  const mySummary = feedback.find((f) => f.f.authorUserId === session.user.id)?.f.summary ?? "";
  const sections = preview.version.snapshot.sections.filter((s) => !["title", "toc", "references"].includes(s.kind));
  const [statusLabel, statusTone] = REVIEW_STATUS[r.status]!;

  return (
    <>
      <p className="mb-2 text-sm"><Link href={`/app/projects/${projectId}/reviews`} className="text-graphite">Reviews</Link></p>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl">{doc.title} <span className="text-graphite">· round {r.round}</span></h2>
          <p className="mt-1 text-sm text-graphite">
            Submitted by {names.get(r.submittedByUserId ?? "") ?? "a former member"} on {formatDateTime(r.createdAt)} · version {preview.version.number} · {preview.model.words.body.toLocaleString("en")} words
            {r.reviewerUserId ? ` · for ${names.get(r.reviewerUserId)}` : " · any supervisor"}
            {r.dueDate ? ` · feedback wanted by ${formatDate(r.dueDate)}` : ""}
          </p>
          {r.message && <blockquote className="mt-2 max-w-2xl border-l-2 border-rule pl-3 text-sm">{r.message}</blockquote>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={statusTone}>{statusLabel}</Tag>
          {exp?.x.status === "succeeded" && <a className="btn btn-quiet" href={`/api/documents/exports/${exp.x.id}`}>Download PDF</a>}
          {exp && exp.x.status !== "succeeded" && <Tag tone={exp.x.status === "failed" ? "blocked" : "in_progress"}>{exp.x.status === "failed" ? "PDF failed" : "PDF rendering…"}</Tag>}
        </div>
      </div>
      {r.decidedAt && (
        <p className={`mb-6 rounded-md border px-4 py-3 text-sm ${r.status === "approved" ? "border-green/30 bg-green-wash text-green-dark" : "border-margin/30 bg-margin-wash text-margin"}`}>
          {r.status === "approved" ? "Approved" : "Changes requested"} by {names.get(r.decidedByUserId ?? "")} on {formatDateTime(r.decidedAt)}.{r.decisionNote ? ` “${r.decisionNote}”` : ""}
        </p>
      )}

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          <DocPreview model={preview.model} title={preview.version.snapshot.title} meta={preview.version.snapshot.meta} figureUrl={(id) => `/api/files/${id}/download`} />
        </div>

        <aside className="grid content-start gap-8">
          {canReview && (
            <section aria-labelledby="give-h" className="grid gap-4">
              <h3 id="give-h" className="font-serif text-xl">Your feedback</h3>
              <ActionForm action={collaborationAction} submitLabel="Add comment" resetOnSuccess className="grid gap-2">
                {hidden}
                <input type="hidden" name="intent" value="comment" />
                <div className="grid grid-cols-2 gap-2">
                  <div className="field">
                    <label htmlFor="fc-sec">Section</label>
                    <select id="fc-sec" name="sectionKey" className="input">
                      <option value="">Whole document</option>
                      {sections.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="fc-sev">Importance</label>
                    <select id="fc-sev" name="severity" className="input" defaultValue="minor">
                      <option value="minor">Minor</option>
                      <option value="major">Major</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>
                </div>
                <Field id="fc-quote" label="Passage (optional)" name="quote" maxLength={1000} />
                <div className="field">
                  <label htmlFor="fc-body">Comment</label>
                  <textarea id="fc-body" name="body" className="input min-h-20" required maxLength={5000} />
                </div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="createTask" defaultChecked /> Make it a revision task</label>
              </ActionForm>
              <ActionForm action={collaborationAction} submitLabel="Save summary" variant="quiet" className="grid gap-2">
                {hidden}
                <input type="hidden" name="intent" value="summary" />
                <div className="field">
                  <label htmlFor="fc-sum">Overall feedback</label>
                  <textarea id="fc-sum" name="summary" className="input min-h-24" defaultValue={mySummary} maxLength={10000} />
                </div>
              </ActionForm>
              <div className="rounded-md border border-rule bg-sheet p-3">
                <p className="mb-2 text-sm font-semibold">Decision</p>
                <ActionForm action={collaborationAction} submitLabel="Request changes" variant="quiet" className="grid gap-2">
                  {hidden}
                  <input type="hidden" name="intent" value="decide" />
                  <input type="hidden" name="decision" value="changes_requested" />
                  <div className="field">
                    <label htmlFor="fc-note">Note to the researcher (optional)</label>
                    <textarea id="fc-note" name="note" className="input min-h-12" maxLength={5000} />
                  </div>
                </ActionForm>
                <ActionForm action={collaborationAction} submitLabel="Approve this version" className="mt-3 grid gap-2">
                  {hidden}
                  <input type="hidden" name="intent" value="decide" />
                  <input type="hidden" name="decision" value="approved" />
                </ActionForm>
              </div>
            </section>
          )}

          <section aria-labelledby="fb-h">
            <h3 id="fb-h" className="mb-2 font-serif text-xl">Feedback</h3>
            {feedback.filter((f) => f.f.summary).map((f) => (
              <div key={f.f.id} className="mb-3 rounded-md border border-rule bg-sheet p-3 text-sm">
                <p className="whitespace-pre-line">{f.f.summary}</p>
                <p className="mt-1 text-xs text-graphite">{f.author ?? "Former supervisor"} · {formatDateTime(f.f.updatedAt)}</p>
              </div>
            ))}
            {comments.length === 0 && !feedback.some((f) => f.f.summary) && <p className="text-sm text-graphite">No feedback yet.</p>}
            <ul className="grid gap-2 text-sm">
              {comments.map(({ c: fc, author }) => (
                <li key={fc.id} className="rounded-md border border-rule bg-sheet p-3">
                  <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-graphite">
                    <Tag tone={SEVERITY[fc.severity]![1]}>{SEVERITY[fc.severity]![0]}</Tag> {fc.sectionTitle || "Whole document"} · {author ?? "Former supervisor"}
                  </p>
                  {fc.quote && <p className="mb-1 border-l-2 border-amber pl-2 text-xs text-graphite">“{fc.quote}”</p>}
                  <p className="whitespace-pre-line">{fc.body}</p>
                </li>
              ))}
            </ul>
            {canEdit && (comments.length > 0 || feedback.some((f) => f.f.summary)) && (
              <p className="mt-3 text-xs text-graphite">
                Tip: the Supervisor Feedback Agent on the <Link href={`/app/projects/${projectId}/assistant`}>AI assistant</Link> tab can draft revision tasks from this feedback for you to accept.
              </p>
            )}
          </section>

          <section aria-labelledby="rt-h">
            <h3 id="rt-h" className="mb-2 font-serif text-xl">Revision tasks</h3>
            {tasks.length === 0 && <p className="text-sm text-graphite">None.</p>}
            <ul className="grid gap-2 text-sm">
              {tasks.map((t) => {
                const [label, tone] = TASK_STATUS[t.status]!;
                return (
                  <li key={t.id} className="rounded-md border border-rule bg-sheet p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold">{t.title}</p>
                      <Tag tone={tone}>{label}</Tag>
                    </div>
                    {t.description && t.description !== t.title && <p className="mt-1 whitespace-pre-line text-graphite">{t.description}</p>}
                    {t.response && <p className="mt-2 whitespace-pre-line border-l-2 border-green pl-2">{t.response}</p>}
                    {t.source === "ai" && <p className="mt-1 text-xs text-graphite">Drafted by the Supervisor Feedback Agent, accepted by the researcher.</p>}
                    {canEdit && (t.status === "open" || t.status === "reopened") && (
                      <ActionForm action={collaborationAction} submitLabel="Send response" variant="quiet" resetOnSuccess className="mt-2 grid gap-2">
                        {hidden}
                        <input type="hidden" name="intent" value="respond" />
                        <input type="hidden" name="taskId" value={t.id} />
                        <div className="field">
                          <label htmlFor={`rs-${t.id}`}>What you changed</label>
                          <textarea id={`rs-${t.id}`} name="response" className="input min-h-12" maxLength={5000} />
                        </div>
                        <div className="field">
                          <label htmlFor={`rss-${t.id}`} className="sr-only">Outcome</label>
                          <select id={`rss-${t.id}`} name="status" className="input">
                            <option value="addressed">Addressed</option>
                            <option value="declined">Won't change (explain why)</option>
                          </select>
                        </div>
                      </ActionForm>
                    )}
                    {canVerify && (t.status === "addressed" || t.status === "declined") && t.assigneeUserId !== session.user.id && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <ActionForm action={collaborationAction} submitLabel="Verify" variant="quiet" className="flex">
                          {hidden}
                          <input type="hidden" name="intent" value="verify" />
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="accept" value="true" />
                        </ActionForm>
                        <ActionForm action={collaborationAction} submitLabel="Reopen" variant="quiet" className="flex flex-1 items-end gap-2">
                          {hidden}
                          <input type="hidden" name="intent" value="verify" />
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="accept" value="false" />
                          <label htmlFor={`rn-${t.id}`} className="sr-only">Why reopen</label>
                          <input id={`rn-${t.id}`} name="note" className="input flex-1" placeholder="Why?" maxLength={1000} />
                        </ActionForm>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {(canEdit || canVerify) && r.status !== "withdrawn" && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-graphite">Add a revision task</summary>
                <ActionForm action={collaborationAction} submitLabel="Add task" variant="quiet" resetOnSuccess className="mt-2 grid gap-2">
                  {hidden}
                  <input type="hidden" name="intent" value="add_task" />
                  <Field id="nt-title" label="Task" name="title" required minLength={3} maxLength={200} />
                  <div className="field">
                    <label htmlFor="nt-sec">Section</label>
                    <select id="nt-sec" name="sectionKey" className="input">
                      <option value="">—</option>
                      {sections.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
                    </select>
                  </div>
                </ActionForm>
              </details>
            )}
          </section>

          {canEdit && (r.status === "submitted" || r.status === "in_review") && (
            <Section title="Withdraw">
              <ActionForm action={collaborationAction} submitLabel="Withdraw submission" variant="danger" className="grid gap-2">
                {hidden}
                <input type="hidden" name="intent" value="withdraw" />
                <p className="text-sm text-graphite">Use this to send a newer version instead.</p>
              </ActionForm>
            </Section>
          )}
        </aside>
      </div>
    </>
  );
}
