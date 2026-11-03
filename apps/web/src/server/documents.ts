import { isAppError } from "@researchmate/shared";
import { notFound } from "next/navigation";
import { cache } from "react";
import { loadProject } from "./plan";
import { documentService } from "./services";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loads a document for a page; "not found / no access" becomes a 404. */
export const loadDocument = cache(async (projectId: string, documentId: string) => {
  const p = await loadProject(projectId);
  if (!UUID.test(documentId)) notFound();
  try {
    const docs = await documentService();
    const view = await docs.get(p.session.user.id, documentId);
    if (view.document.projectId !== projectId) notFound();
    return { ...p, ...view, canEdit: view.canEdit && !p.archived, canComment: view.canComment && !p.archived };
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
});

export const DOC_STATUS: Record<string, string> = { draft: "Draft", in_review: "In review", final: "Final" };
export const SECTION_KIND: Record<string, string> = { title: "Title page", front: "Preliminary", toc: "Contents (generated)", body: "Main text", references: "References (generated)", appendix: "Appendix" };
