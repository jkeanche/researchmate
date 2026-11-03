import { AppError } from "@researchmate/shared";
import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, sessionFromRequest } from "@/server/http";
import { literatureService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects/:id/references/export?format=bibtex|ris */
export async function GET(req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const session = await sessionFromRequest(req);
    const { projectId } = await params;
    const format = req.nextUrl.searchParams.get("format") ?? "bibtex";
    if (!["bibtex", "ris"].includes(format) || !/^[0-9a-f-]{36}$/i.test(projectId)) throw new AppError("NOT_FOUND", "Not found.");
    const text = await literatureService().exportText(session.user.id, projectId, format as "bibtex" | "ris");
    return new NextResponse(text, {
      headers: {
        "Content-Type": format === "ris" ? "application/x-research-info-systems; charset=utf-8" : "application/x-bibtex; charset=utf-8",
        "Content-Disposition": `attachment; filename="references-${new Date().toISOString().slice(0, 10)}.${format === "ris" ? "ris" : "bib"}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
