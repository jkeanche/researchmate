import { getEntitlements, limitOf } from "@researchmate/entitlements";
import { CITATION_STYLE_LABELS, PROJECT_STATUSES, RESEARCH_TYPE_LABELS, STATUS_LABELS } from "@researchmate/research";
import { isAppError, env } from "@researchmate/shared";
import { ACCEPT_ATTRIBUTE } from "@researchmate/storage";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { ConfirmAction, FileUploader } from "@/components/client-bits";
import { FileList } from "@/components/file-list";
import { ProjectFields } from "@/components/project-fields";
import { PageHeader, ProgressRule, Section, StatusTag } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { archiveProjectAction, updateProjectAction } from "@/server/actions/workspace";
import { db, fileService, projectService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Project" };

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const session = await requireSession();
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) notFound();

  let loaded;
  try {
    loaded = await projectService().get(session.user.id, projectId);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const { project: p, access } = loaded;
  const can = (perm: string) => access.permissions.has(perm as never);
  const archived = p.status === "archived";

  const [files, ent] = await Promise.all([
    fileService().then((s) => s.list(session.user.id, p.organizationId, { projectId: p.id })),
    getEntitlements(db(), p.organizationId),
  ]);
  const maxFile = Math.min(limitOf(ent, "files.max_size_bytes") ?? Infinity, env().MAX_UPLOAD_SIZE_MB * 1024 * 1024);

  const facts: [string, string][] = [
    ["Research type", RESEARCH_TYPE_LABELS[p.researchType as keyof typeof RESEARCH_TYPE_LABELS]],
    ["Academic level", p.academicLevel ?? "—"],
    ["Discipline", p.discipline ?? "—"],
    ["Institution", [p.institution, p.department].filter(Boolean).join(", ") || "—"],
    ["Citation style", CITATION_STYLE_LABELS[p.citationStyle as keyof typeof CITATION_STYLE_LABELS]],
    ["Target length", [p.targetWordCount ? `${p.targetWordCount.toLocaleString()} words` : null, p.targetPageCount ? `${p.targetPageCount} pages` : null].filter(Boolean).join(", ") || "—"],
    ["Schedule", p.startDate || p.expectedCompletionDate ? `${formatDate(p.startDate)} to ${formatDate(p.expectedCompletionDate)}` : "—"],
  ];

  return (
    <>
      <PageHeader
        title={p.title}
        description={<span className="inline-flex flex-wrap items-center gap-3"><StatusTag status={p.status} /><ProgressRule value={p.progressPercent} label="Progress" /></span>}
        actions={
          can("project.archive") ? (
            <ConfirmAction
              action={archiveProjectAction}
              fields={{ projectId: p.id, intent: archived ? "restore" : "archive" }}
              label={archived ? "Restore project" : "Archive project"}
              variant="quiet"
              confirmText={archived ? "Restore this project so it can be edited again?" : "Archive this project? It becomes read-only. Archived projects still count toward your plan's project limit."}
            />
          ) : null
        }
      />

      {archived && (
        <p className="mb-8 rounded-md border border-rule bg-rule-soft px-4 py-3 text-sm">This project is archived and read-only.</p>
      )}

      <Section title="Overview">
        {p.description ? <p className="mb-5 max-w-2xl whitespace-pre-line">{p.description}</p> : null}
        <dl className="grid max-w-3xl gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          {facts.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[8.5rem_1fr] gap-2">
              <dt className="text-graphite">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {p.methodology ? (
          <div className="mt-5 max-w-2xl text-sm">
            <p className="text-graphite">Methodology</p>
            <p className="mt-1 whitespace-pre-line">{p.methodology}</p>
          </div>
        ) : null}
      </Section>

      <Section title="Files" description="Readings, datasets, drafts and other material for this project.">
        {can("project.files.write") && !archived ? (
          <div className="mb-6">
            <FileUploader organizationId={p.organizationId} projectId={p.id} accept={ACCEPT_ATTRIBUTE} maxBytes={maxFile} />
          </div>
        ) : null}
        <FileList rows={files} canDelete={() => can("project.files.delete") && !archived} />
      </Section>

      {can("project.update") && !archived && (
        <Section title="Edit project">
          <div className="max-w-2xl">
            <ActionForm action={updateProjectAction} submitLabel="Save changes" pendingLabel="Saving…" className="grid gap-6">
              <input type="hidden" name="projectId" value={p.id} />
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="field">
                  <label htmlFor="f-status">Status</label>
                  <select id="f-status" name="status" className="input" defaultValue={p.status}>
                    {PROJECT_STATUSES.filter((s) => s !== "archived").map((s) => (
                      <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="f-progressPercent">Progress (%)</label>
                  <input id="f-progressPercent" name="progressPercent" type="number" min={0} max={100} step={5} className="input" defaultValue={p.progressPercent} />
                  <span className="hint">Set manually for now; it will follow your tasks once planning is added.</span>
                </div>
              </div>
              <ProjectFields d={p} />
            </ActionForm>
          </div>
        </Section>
      )}
    </>
  );
}
