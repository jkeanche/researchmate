import Link from "next/link";
import { DocumentNav } from "@/components/document-nav";
import { Tag } from "@/components/plan-ui";
import { DOC_STATUS, loadDocument } from "@/server/documents";

export default async function DocumentLayout({ children, params }: { children: React.ReactNode; params: Promise<{ projectId: string; documentId: string }> }) {
  const { projectId, documentId } = await params;
  const d = await loadDocument(projectId, documentId);
  const base = `/app/projects/${projectId}/documents/${documentId}`;
  return (
    <>
      <div className="mb-4">
        <p className="text-sm"><Link href={`/app/projects/${projectId}/documents`} className="text-graphite">Documents</Link></p>
        <h2 className="mt-1 flex flex-wrap items-center gap-3 font-serif text-2xl">
          {d.document.title} <Tag tone={d.document.status === "final" ? "done" : d.document.status === "in_review" ? "awaiting_approval" : "todo"}>{DOC_STATUS[d.document.status]}</Tag>
        </h2>
      </div>
      <DocumentNav base={base} />
      {children}
    </>
  );
}
