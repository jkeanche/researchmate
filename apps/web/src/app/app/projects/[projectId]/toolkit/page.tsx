import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { EmptyState, Section } from "@/components/ui";
import { toolkitAction } from "@/server/actions/toolkit";
import { fileService, toolkitService } from "@/server/services";
import { loadToolkit } from "@/server/toolkit";

export const metadata = { title: "Data and analysis" };

const TABULAR = new Set(["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);

export default async function ToolkitPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const v = await loadToolkit(projectId);
  const uid = v.session.user.id;
  const [sets, projectFiles] = await Promise.all([
    (await toolkitService()).listDatasets(uid, projectId),
    v.canEdit && v.can("project.files.read") ? fileService().then((s) => s.list(uid, v.project.organizationId, { projectId })) : Promise.resolve([]),
  ]);
  const tabular = projectFiles.filter((f) => TABULAR.has(f.mimeType) || /\.csv$/i.test(f.originalName));
  return (
    <>
      <Section title="Datasets" description="Import a CSV or Excel file from the project's files. The first row must hold the variable names. Calculations run on the stored copy, and every analysis records its method.">
        {sets.length === 0 ? (
          <EmptyState title="No datasets yet" body="Upload a CSV or XLSX file on the Files page, then import it here." />
        ) : (
          <ul className="grid gap-2">
            {sets.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-rule bg-sheet px-4 py-3 text-sm">
                <Link href={`/app/projects/${projectId}/toolkit/datasets/${d.id}`} className="font-semibold">{d.name}</Link>
                <span className="text-graphite">{d.rowCount.toLocaleString("en")} rows · {d.columns.length} variables{d.sheet ? ` · sheet “${d.sheet}”` : ""} · imported {d.createdAt.toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {v.canEdit && (
        <Section title="Import a dataset">
          {tabular.length === 0 ? (
            <p className="text-sm text-graphite">No CSV or XLSX files in this project yet. <Link href={`/app/projects/${projectId}`}>Upload one on the project overview</Link> first.</p>
          ) : (
            <ActionForm action={toolkitAction} submitLabel="Import" pendingLabel="Importing…" className="grid max-w-xl gap-3">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="intent" value="import" />
              <div className="field">
                <label htmlFor="ds-file">File</label>
                <select id="ds-file" name="fileId" className="input" required>
                  {tabular.map((f) => (
                    <option key={f.id} value={f.id}>{f.originalName}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ds-name">Dataset name (optional)</label>
                <input id="ds-name" name="name" className="input" maxLength={200} />
              </div>
              <div className="field">
                <label htmlFor="ds-sheet">Worksheet (Excel only; defaults to the first)</label>
                <input id="ds-sheet" name="sheet" className="input" maxLength={100} />
              </div>
            </ActionForm>
          )}
        </Section>
      )}
    </>
  );
}
