"use server";

import { AppError, isAppError, logger } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type FormState, handle, str } from "../form";
import { documentService } from "../services";
import { requireSession } from "../session";

const path = (projectId: string, documentId?: string) => `/app/projects/${projectId}/documents${documentId ? `/${documentId}` : ""}`;

export async function createDocumentAction(_: FormState, form: FormData): Promise<FormState> {
  let target = "";
  const r = await handle(async () => {
    const s = await requireSession();
    const projectId = str(form, "projectId");
    const meta: Record<string, string> = {};
    for (const k of ["author", "degree", "institution", "department", "supervisor"]) if (str(form, k)) meta[k] = str(form, k);
    const doc = await (await documentService()).create(s.user.id, projectId, { templateKey: str(form, "templateKey"), title: str(form, "title"), meta });
    target = path(projectId, doc.id);
  });
  if (target) redirect(target);
  return r;
}

export type SaveResult = { ok: true; version: number; savedAt: string } | { ok: false; error: string; code: string };

/** Editor save (also used by autosave). Optimistic concurrency: a stale version is refused, never overwritten. */
export async function saveSectionAction(input: { sectionId: string; content: string; version: number }): Promise<SaveResult> {
  try {
    const s = await requireSession();
    const row = await (await documentService()).saveSection(s.user.id, input.sectionId, { content: input.content, version: input.version });
    return { ok: true, version: row.version, savedAt: row.updatedAt.toISOString() };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.message, code: err.code };
    logger.error("document.save_failed", { error: err instanceof Error ? err.stack : String(err) });
    return { ok: false, error: "Saving failed. Your text is still here; try again.", code: "INTERNAL" };
  }
}

const num = (v: string) => (v.trim() === "" ? null : Number(v));

export async function documentAction(_: FormState, form: FormData): Promise<FormState> {
  let target = "";
  const r = await handle(async () => {
    const s = await requireSession();
    const uid = s.user.id;
    const projectId = str(form, "projectId");
    const documentId = str(form, "documentId");
    const docs = await documentService();
    const done = (msg: string) => {
      revalidatePath(path(projectId, documentId), "layout");
      return { success: msg };
    };
    switch (str(form, "intent")) {
      case "details":
        await docs.updateDetails(uid, documentId, {
          title: str(form, "title"),
          status: str(form, "status") || undefined,
          meta: Object.fromEntries(["author", "subtitle", "degree", "documentLabel", "department", "institution", "supervisor", "date"].map((k) => [k, str(form, k)])),
        });
        return done("Details saved.");
      case "spec": {
        const m = (k: string) => Number(str(form, k));
        const v = await docs.updateSpec(
          uid,
          documentId,
          {
            page: { size: str(form, "pageSize") as "A4", marginsMm: { top: m("marginTop"), bottom: m("marginBottom"), left: m("marginLeft"), right: m("marginRight") } },
            font: { family: str(form, "fontFamily"), sizePt: m("fontSize") },
            headingFont: str(form, "headingFont") || str(form, "fontFamily"),
            lineSpacing: m("lineSpacing"),
            paragraph: { spaceBeforePt: m("spaceBefore"), spaceAfterPt: m("spaceAfter"), firstLineIndentMm: m("firstLineIndent") },
            headingNumbering: form.get("headingNumbering") === "on",
            titlePage: form.get("titlePage") === "on",
            pageNumbers: { position: str(form, "pageNumberPosition") as "bottom-center", prelims: str(form, "prelims") as "roman" },
            header: str(form, "header"),
            footer: str(form, "footer"),
            citationStyle: str(form, "citationStyle") as "apa7",
            captions: { table: str(form, "tableCaption") as "above", figure: str(form, "figureCaption") as "below" },
            limits: { minWords: num(str(form, "minWords")), maxWords: num(str(form, "maxWords")), maxPages: num(str(form, "maxPages")), abstractMaxWords: num(str(form, "abstractMaxWords")) },
          },
          str(form, "note"),
        );
        return done(`Saved as specification version ${v}.`);
      }
      case "add_section":
        await docs.addSection(uid, documentId, { title: str(form, "title"), kind: str(form, "kind") });
        return done("Section added.");
      case "rename_section":
        await docs.renameSection(uid, str(form, "sectionId"), str(form, "title"), form.has("wordLimit") ? num(str(form, "wordLimit")) : undefined);
        return done("Section updated.");
      case "remove_section":
        await docs.removeSection(uid, str(form, "sectionId"));
        return done("Section removed.");
      case "move_section":
        await docs.moveSection(uid, str(form, "sectionId"), str(form, "direction") === "up" ? "up" : "down");
        return done("Moved.");
      case "comment":
        await docs.addComment(uid, documentId, { sectionId: str(form, "sectionId") || null, parentId: str(form, "parentId") || null, quote: str(form, "quote"), body: str(form, "body") });
        return done("Comment added.");
      case "resolve":
        await docs.resolveComment(uid, str(form, "commentId"), str(form, "resolved") !== "false");
        return done("Updated.");
      case "link_evidence":
        await docs.linkEvidence(uid, str(form, "sectionId"), str(form, "evidenceId"), true);
        return done("Evidence linked to this section.");
      case "unlink_evidence":
        await docs.linkEvidence(uid, str(form, "sectionId"), str(form, "evidenceId"), false);
        return done("Evidence unlinked.");
      case "save_version": {
        const v = await docs.saveVersion(uid, documentId, str(form, "label"));
        return done(`Saved as version ${v.number}.`);
      }
      case "restore": {
        const n = await docs.restoreVersion(uid, str(form, "versionId"));
        return done(`Restored version ${n}. The text you had before is saved as a version too.`);
      }
      case "export": {
        const format = str(form, "format") === "pdf" ? "pdf" : "docx";
        await docs.requestExport(uid, documentId, format);
        return done(`${format.toUpperCase()} export started. It appears below when ready.`);
      }
      case "delete":
        await docs.remove(uid, documentId);
        target = path(projectId);
        return;
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
  if (target) redirect(target);
  return r;
}
