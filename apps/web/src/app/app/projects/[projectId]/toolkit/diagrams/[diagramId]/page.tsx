import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { DiagramEditor } from "@/components/diagram-editor";
import { toolkitAction } from "@/server/actions/toolkit";
import { toolkitService } from "@/server/services";
import { loadToolkit } from "@/server/toolkit";

export const metadata = { title: "Diagram" };

export default async function DiagramPage({ params }: { params: Promise<{ projectId: string; diagramId: string }> }) {
  const { projectId, diagramId } = await params;
  const v = await loadToolkit(projectId);
  const d = (await (await toolkitService()).listDiagrams(v.session.user.id, projectId)).find((x) => x.id === diagramId);
  if (!d) notFound();
  return (
    <>
      <DiagramEditor projectId={projectId} diagram={{ id: d.id, title: d.title, source: d.source, revision: d.revision }} canEdit={v.canEdit} />
      {v.canEdit && (
        <div className="no-print mt-8 border-t border-rule pt-4">
          <ActionForm action={toolkitAction} submitLabel="Delete diagram" variant="danger" className="flex">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="intent" value="diagram_delete" />
            <input type="hidden" name="diagramId" value={d.id} />
          </ActionForm>
        </div>
      )}
    </>
  );
}
