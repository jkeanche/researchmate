import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { createDocumentAction } from "@/server/actions/documents";
import { DOC_STATUS } from "@/server/documents";
import { loadProject } from "@/server/plan";
import { documentService } from "@/server/services";

export const metadata = { title: "Documents" };

export default async function DocumentsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { session, can, archived, project } = await loadProject(projectId);
  const docs = await documentService();
  const [list, templates, gen] = await Promise.all([docs.list(session.user.id, projectId), docs.templates(), docs.generationTier(project.organizationId)]);
  const canEdit = can("project.update") && !archived;
  return (
    <>
      <p className="mb-6 max-w-3xl text-sm text-graphite">
        Write in structured sections with citations from your library. Each document follows a specification (layout, limits, citation style) taken from a template, and every export is checked against it: word and page limits, margins, headings, numbering, tables and figures. {gen.tier === "none" && `Exporting to DOCX and PDF is not included in the ${gen.planName} plan.`}
      </p>
      <Section title={`Documents (${list.length})`}>
        {list.length === 0 && <p className="text-sm text-graphite">No documents yet.</p>}
        <ul className="grid gap-3">
          {list.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-sheet p-4">
              <div>
                <Link href={`/app/projects/${projectId}/documents/${d.id}`} className="font-semibold">{d.title}</Link>
                <p className="text-sm text-graphite">{templates.find((t) => t.key === d.templateKey)?.name ?? d.documentType.replace(/_/g, " ")} · updated {formatDateTime(d.updatedAt)}</p>
              </div>
              <Tag tone={d.status === "final" ? "done" : d.status === "in_review" ? "awaiting_approval" : "todo"}>{DOC_STATUS[d.status]}</Tag>
            </li>
          ))}
        </ul>
      </Section>
      {canEdit && (
        <Section title="New document">
          <ActionForm action={createDocumentAction} submitLabel="Create document" className="grid max-w-2xl gap-4">
            <input type="hidden" name="projectId" value={projectId} />
            <Field id="nd-title" label="Title" name="title" required minLength={2} maxLength={300} defaultValue={list.length ? "" : project.title} />
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-semibold">Template</legend>
              {templates.map((t, i) => (
                <label key={t.id} className="flex items-start gap-2 rounded border border-rule bg-sheet p-3 text-sm">
                  <input type="radio" name="templateKey" value={t.key} defaultChecked={i === 0} className="mt-1" />
                  <span>
                    <span className="font-semibold">{t.name}</span>
                    <span className="block text-graphite">{t.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="nd-author" label="Author" name="author" maxLength={300} />
              <Field id="nd-degree" label="Degree (for theses)" name="degree" maxLength={300} placeholder="e.g. Master of Science in Economics" />
              <Field id="nd-inst" label="Institution" name="institution" maxLength={300} />
              <Field id="nd-sup" label="Supervisor" name="supervisor" maxLength={300} />
            </div>
          </ActionForm>
        </Section>
      )}
    </>
  );
}
