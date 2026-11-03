import { AppError } from "@researchmate/shared";
import { buildCodebookXlsx, buildDeck, buildStatusReport, buildSurveyDocx, type DeckKind } from "@researchmate/toolkit";
import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, sessionFromRequest } from "@/server/http";
import { toolkitService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;
const MIME = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "export";

/**
 * GET /api/projects/:id/toolkit/:output
 *   deck-proposal | deck-progress | deck-defense  (advanced tier)
 *   status-report                                  (advanced tier)
 *   dataset?id=…        CSV of a cleaned dataset
 *   survey-docx?id=…, codebook?id=…
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ projectId: string; output: string }> }) {
  try {
    const session = await sessionFromRequest(req);
    const uid = session.user.id;
    const { projectId, output } = await params;
    if (!UUID.test(projectId)) throw new AppError("NOT_FOUND", "Not found.");
    const tk = await toolkitService();
    const id = req.nextUrl.searchParams.get("id") ?? "";
    let body: Buffer | string;
    let type: keyof typeof MIME;
    let name: string;
    if (output.startsWith("deck-") || output === "status-report") {
      // Generated outputs are an advanced-tier feature.
      const { tier, planName } = await tk.access(uid, projectId, "read");
      if (tier !== "advanced") throw new AppError("FEATURE_NOT_ENTITLED", `Generated presentations and reports are not included in the ${planName} plan.`, { feature: "toolkit" });
      const data = await tk.projectData(uid, projectId);
      if (output === "status-report") {
        body = await buildStatusReport(data);
        type = "docx";
        name = `${slug(data.project.title)}-status-${data.today}`;
      } else {
        const kind = output.slice(5) as DeckKind;
        if (!["proposal", "progress", "defense"].includes(kind)) throw new AppError("NOT_FOUND", "Not found.");
        body = await buildDeck(data, kind);
        type = "pptx";
        name = `${slug(data.project.title)}-${kind}`;
      }
    } else if (output === "dataset") {
      if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Not found.");
      const d = await tk.dataset(uid, id);
      if (d.projectId !== projectId) throw new AppError("NOT_FOUND", "Not found.");
      body = await tk.datasetCsv(uid, id);
      type = "csv";
      name = slug(d.name);
    } else if (output === "survey-docx" || output === "codebook") {
      if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Not found.");
      const s = await tk.survey(uid, id);
      if (s.projectId !== projectId) throw new AppError("NOT_FOUND", "Not found.");
      if (output === "codebook") {
        body = await buildCodebookXlsx(s, tk.codebook(s));
        type = "xlsx";
        name = `${slug(s.title)}-codebook`;
      } else {
        body = await buildSurveyDocx(s);
        type = "docx";
        name = slug(s.title);
      }
    } else throw new AppError("NOT_FOUND", "Not found.");
    return new NextResponse(body as BodyInit, {
      headers: { "Content-Type": MIME[type], "Content-Disposition": `attachment; filename="${name}.${type}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
