import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { Notice, PlanNotice, Stat, Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { collaborationAction } from "@/server/actions/collaboration";
import { loadProject } from "@/server/plan";
import { collaborationService, db, documentService } from "@/server/services";
import { getEntitlements, tierOf } from "@researchmate/entitlements";
import { REVIEW_STATUS, TASK_STATUS } from "@/lib/review-labels";

export const metadata = { title: "Reviews" };


export default async function ReviewsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { session, can, archived, project } = await loadProject(projectId);
  const uid = session.user.id;
  const c = await collaborationService();
  const [list, timing, supervisors, docs, revisions, ent] = await Promise.all([
    c.list(uid, projectId),
    c.timing(uid, projectId),
    c.supervisors(uid, projectId),
    can("project.update") || can("project.review") ? (await documentService()).list(uid, projectId) : Promise.resolve([]),
    c.revisions(uid, projectId),
    getEntitlements(db(), project.organizationId),
  ]);
  const tier = tierOf(ent, "collaboration.supervisor");
  const canSubmit = can("project.update") && !archived && tier !== "none";
  const base = `/app/projects/${projectId}/reviews`;
  const openTasks = revisions.filter((r) => r.t.status === "open" || r.t.status === "reopened");

  return (
    <>
      <div className="mb-8 grid gap-3 sm:grid-cols-4">
        <Stat label="Waiting for a supervisor" value={timing.awaiting} note={timing.awaiting ? `longest ${timing.longestOpenDays} days` : "nothing waiting"} tone={timing.longestOpenDays > 14 ? "warn" : undefined} />
        <Stat label="Supervisor waiting time" value={`${timing.supervisorWaitingDays} d`} note={timing.averageTurnaroundDays != null ? `average turnaround ${timing.averageTurnaroundDays} d` : "no decisions yet"} />
        <Stat label="Revision time" value={`${timing.revisionDays} d`} note="from changes requested to resubmission" />
        <Stat label="Open revision tasks" value={timing.openRevisionTasks} tone={timing.openRevisionTasks ? "warn" : "good"} />
      </div>

      {tier === "none" && <div className="mb-6"><PlanNotice>Supervisor collaboration is not included in the {ent.planName} plan.</PlanNotice></div>}

      <Section title={`Submissions (${list.length})`}>
        {list.length === 0 && <p className="text-sm text-graphite">Nothing submitted yet.</p>}
        <ul className="grid gap-2">
          {list.map(({ r, title, submitter, waitingDays }) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-sheet px-4 py-3 text-sm">
              <span>
                <Link href={`${base}/${r.id}`} className="font-semibold">{title}</Link> <span className="text-graphite">· round {r.round} · {submitter ?? "Former member"} · {formatDate(r.createdAt)}{waitingDays != null ? ` · ${r.decidedAt ? "decided after" : "waiting"} ${Math.round(waitingDays * 10) / 10} days` : ""}{r.dueDate && !r.decidedAt ? ` · due ${formatDate(r.dueDate)}` : ""}</span>
              </span>
              <Tag tone={REVIEW_STATUS[r.status]![1]}>{REVIEW_STATUS[r.status]![0]}</Tag>
            </li>
          ))}
        </ul>
      </Section>

      {canSubmit && (
        <Section title="Submit a document for review" description="A snapshot of the document is sent; you can keep editing without changing what your supervisor sees.">
          {supervisors.length === 0 ? (
            <Notice>Invite a supervisor on the <Link href={`/app/projects/${projectId}/team`}>Team</Link> tab first.</Notice>
          ) : docs.length === 0 ? (
            <Notice>Create a document on the <Link href={`/app/projects/${projectId}/documents`}>Documents</Link> tab first.</Notice>
          ) : (
            <ActionForm action={collaborationAction} submitLabel="Submit for review" className="grid max-w-2xl gap-4">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="intent" value="submit" />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="field">
                  <label htmlFor="sub-doc">Document</label>
                  <select id="sub-doc" name="documentId" className="input" required>
                    {docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="sub-rev">Reviewer</label>
                  <select id="sub-rev" name="reviewerUserId" className="input">
                    <option value="">Any supervisor</option>
                    {supervisors.filter((s) => s.userId !== uid).map((s) => <option key={s.userId} value={s.userId}>{s.name ?? s.email}</option>)}
                  </select>
                </div>
                <Field id="sub-due" label="Feedback wanted by (optional)" name="dueDate" type="date" />
                <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name="attachPdf" /> Attach a PDF rendered from this version</label>
              </div>
              <div className="field">
                <label htmlFor="sub-msg">Message</label>
                <textarea id="sub-msg" name="message" className="input min-h-16" maxLength={2000} placeholder="What would you like feedback on?" />
              </div>
            </ActionForm>
          )}
        </Section>
      )}

      <Section title={`Revision tasks (${openTasks.length} open)`}>
        {revisions.length === 0 ? (
          <p className="text-sm text-graphite">None yet. They come from supervisor feedback.</p>
        ) : (
          <ul className="grid gap-2 text-sm">
            {revisions.map(({ t, document, round }) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-sheet px-4 py-2">
                <span>
                  {t.reviewRequestId ? <Link href={`${base}/${t.reviewRequestId}`}>{t.title}</Link> : t.title} <span className="text-graphite">· {document ?? "Project"}{round ? `, round ${round}` : ""}{t.source === "ai" ? " · drafted with AI" : ""}</span>
                </span>
                <Tag tone={TASK_STATUS[t.status]![1]}>{TASK_STATUS[t.status]![0]}</Tag>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
