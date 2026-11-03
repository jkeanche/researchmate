"use server";

import { AppError } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type FormState, handle, str } from "../form";
import { toolkitService } from "../services";
import { requireSession } from "../session";

const list = (form: FormData, key: string) => form.getAll(key).map(String).filter(Boolean);

/** Dataset, analysis, diagram and questionnaire changes. ToolkitService enforces permissions and plan tiers. */
export async function toolkitAction(_: FormState, form: FormData): Promise<FormState> {
  let go = "";
  const result = await handle(async () => {
    const s = await requireSession();
    const uid = s.user.id;
    const projectId = str(form, "projectId");
    const tk = await toolkitService();
    const base = `/app/projects/${projectId}/toolkit`;
    const done = (msg: string) => {
      revalidatePath(base, "layout");
      return { success: msg };
    };
    switch (str(form, "intent")) {
      case "import": {
        const d = await tk.importDataset(uid, projectId, { fileId: str(form, "fileId"), name: str(form, "name"), sheet: str(form, "sheet") || undefined });
        go = `${base}/datasets/${d.id}`;
        return done(`Imported ${d.rowCount} rows.`);
      }
      case "column": {
        const codes = str(form, "missingCodes").split(",").map((c) => c.trim()).filter(Boolean);
        await tk.updateColumn(uid, str(form, "datasetId"), str(form, "name"), { label: str(form, "label"), type: (str(form, "type") || undefined) as never, missingCodes: codes });
        return done("Variable updated.");
      }
      case "analyse": {
        const kind = str(form, "kind");
        const spec: Record<string, unknown> = {
          variables: list(form, "variables"),
          variable: str(form, "variable"),
          row: str(form, "row"),
          column: str(form, "column"),
          x: str(form, "x"),
          y: str(form, "y"),
          method: str(form, "method"),
          outcome: str(form, "outcome"),
          predictors: list(form, "predictors"),
          group: str(form, "group"),
        };
        for (const k of Object.keys(spec)) if (spec[k] === "" || (Array.isArray(spec[k]) && !(spec[k] as unknown[]).length)) delete spec[k];
        await tk.analyse(uid, str(form, "datasetId"), kind, spec, str(form, "notes"));
        return done("Analysis saved.");
      }
      case "diagram_create": {
        const d = await tk.createDiagram(uid, projectId, str(form, "template"), str(form, "title"));
        go = `${base}/diagrams/${d.id}`;
        return done("Diagram created.");
      }
      case "diagram_delete":
        await tk.deleteDiagram(uid, str(form, "diagramId"));
        go = `${base}/diagrams`;
        return done("Diagram deleted.");
      case "survey_create": {
        const sv = await tk.createSurvey(uid, projectId, str(form, "title"));
        go = `${base}/surveys/${sv.id}`;
        return done("Questionnaire created.");
      }
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
  if (go && !result.error) redirect(go);
  return result;
}

/** Called from the client editors (JSON payloads, optimistic revision). */
export async function saveDiagramAction(input: { projectId: string; diagramId: string; title: string; source: string; revision: number }): Promise<FormState & { revision?: number }> {
  return handle(async () => {
    const s = await requireSession();
    const row = await (await toolkitService()).saveDiagram(s.user.id, input.diagramId, input);
    revalidatePath(`/app/projects/${input.projectId}/toolkit/diagrams`);
    return { success: "Saved.", data: { revision: row.revision } };
  });
}

export async function saveSurveyAction(input: { projectId: string; surveyId: string; title: string; introduction: string; consent: string; questions: unknown[]; revision: number }): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    if (!Array.isArray(input.questions)) throw new AppError("VALIDATION", "Invalid questions.");
    const row = await (await toolkitService()).saveSurvey(s.user.id, input.surveyId, input);
    revalidatePath(`/app/projects/${input.projectId}/toolkit/surveys`);
    return { success: "Saved.", data: { revision: row.revision } };
  });
}
