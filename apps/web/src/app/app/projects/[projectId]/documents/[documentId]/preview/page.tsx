import { DocPreview } from "@/components/doc-preview";
import { Notice } from "@/components/plan-ui";
import { loadDocument } from "@/server/documents";
import { documentService } from "@/server/services";

export const metadata = { title: "Preview" };

export default async function PreviewPage({ params }: { params: Promise<{ projectId: string; documentId: string }> }) {
  const { projectId, documentId } = await params;
  const d = await loadDocument(projectId, documentId);
  const { model } = await (await documentService()).preview(d.session.user.id, documentId);
  return (
    <>
      <div className="mb-4 max-w-3xl">
        <Notice>A reading view of the structure, numbering and citations. Page layout (margins, spacing, page numbers) is applied when you export; the PDF export is checked page by page.</Notice>
      </div>
      <DocPreview model={model} title={d.document.title} meta={d.document.meta} figureUrl={(id) => `/api/files/${id}/download`} />
    </>
  );
}
