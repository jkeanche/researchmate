"use server";

import { AppError } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { type FormState, handle, str } from "../form";
import { verifyRecord } from "../literature";
import { literatureService } from "../services";
import { requireSession } from "../session";

const fields = (form: FormData, keys: string[]) => Object.fromEntries(keys.map((k) => [k, str(form, k)]));

/** All reference-library, evidence and matrix changes. Permission and plan checks happen in LiteratureService. */
export async function literatureAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const uid = s.user.id;
    const projectId = str(form, "projectId");
    const lit = literatureService();
    const done = (msg: string) => {
      revalidatePath(`/app/projects/${projectId}/literature`, "layout");
      return { success: msg };
    };
    switch (str(form, "intent")) {
      case "add_manual": {
        const r = await lit.addManual(uid, projectId, fields(form, ["type", "title", "authors", "year", "containerTitle", "volume", "issue", "pages", "publisher", "doi", "url"]) as never);
        return done(`Added as [@${r.citationKey}]. It is unverified until checked against the DOI registry.`);
      }
      case "import": {
        const file = form.get("file");
        let text = str(form, "text");
        let format = str(form, "format");
        if (file instanceof File && file.size > 0) {
          if (file.size > 1_000_000) throw new AppError("VALIDATION", "Import files can be up to 1 MB.");
          text = await file.text();
          if (!format || format === "auto") format = /\.ris$/i.test(file.name) ? "ris" : "bibtex";
        }
        if (!text.trim()) throw new AppError("VALIDATION", "Choose a .bib or .ris file, or paste the entries.");
        if (!format || format === "auto") format = /^\s*TY {2}- /m.test(text) ? "ris" : "bibtex";
        const r = await lit.importText(uid, projectId, format as "bibtex" | "ris", text);
        return done(`Imported ${r.added} reference${r.added === 1 ? "" : "s"}${r.duplicates ? `; skipped ${r.duplicates} already in the library` : ""}${r.errors.length ? `; ${r.errors.length} entr${r.errors.length === 1 ? "y" : "ies"} could not be read` : ""}.`);
      }
      case "add_search": {
        const record = verifyRecord(projectId, str(form, "record"), str(form, "sig"));
        const r = await lit.addFromSearch(uid, projectId, record);
        return done(r ? `Added as [@${r.citationKey}].` : "Already in the library.");
      }
      case "verify": {
        const r = await lit.verify(uid, str(form, "referenceId"));
        if (r.status === "verification_failed") return (revalidatePath(`/app/projects/${projectId}/literature`, "layout"), { error: `Verification failed. ${r.issues.join(" ")}` });
        return done("Matches the DOI registry.");
      }
      case "attach": {
        await lit.attachFullText(uid, str(form, "referenceId"), str(form, "fileId"));
        return done("Full text attached. Mark it reviewed once you have read it.");
      }
      case "reviewed":
        await lit.markReviewed(uid, str(form, "referenceId"));
        return done("Marked as reviewed.");
      case "remove":
        await lit.remove(uid, str(form, "referenceId"));
        return done("Reference removed.");
      case "add_theme":
        await lit.addTheme(uid, projectId, str(form, "name"), str(form, "description"));
        return done("Theme added.");
      case "add_evidence":
        await lit.addEvidence(uid, projectId, fields(form, ["passage", "claim", "referenceId", "fileId", "page", "researchQuestionId", "themeId", "notes"]));
        return done("Evidence recorded.");
      case "evidence_status": {
        const patch: Record<string, unknown> = {};
        if (str(form, "verificationStatus")) patch.verificationStatus = str(form, "verificationStatus");
        if (str(form, "themeId") || form.has("themeId")) patch.themeId = str(form, "themeId");
        await lit.updateEvidence(uid, str(form, "evidenceId"), patch);
        return done("Saved.");
      }
      case "delete_evidence":
        await lit.deleteEvidence(uid, str(form, "evidenceId"));
        return done("Evidence deleted.");
      case "save_matrix":
        await lit.saveMatrixEntry(uid, str(form, "referenceId"), fields(form, ["objective", "methodology", "population", "findings", "limitations", "researchGap", "basis"]));
        return done("Matrix row saved.");
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
}
