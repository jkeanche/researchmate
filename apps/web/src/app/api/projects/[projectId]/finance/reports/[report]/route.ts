import { buildReport, renderReport, REPORTS, type ReportFormat, type ReportKey } from "@researchmate/finance";
import { AppError } from "@researchmate/shared";
import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, sessionFromRequest } from "@/server/http";
import { financeService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects/:id/finance/reports/:report?format=csv|xlsx|pdf */
export async function GET(req: NextRequest, { params }: { params: Promise<{ projectId: string; report: string }> }) {
  try {
    const session = await sessionFromRequest(req);
    const { projectId, report } = await params;
    const format = (req.nextUrl.searchParams.get("format") ?? "pdf") as ReportFormat;
    if (!(report in REPORTS) || !["csv", "xlsx", "pdf"].includes(format) || !/^[0-9a-f-]{36}$/i.test(projectId)) throw new AppError("NOT_FOUND", "Report not found.");
    const table = await buildReport(financeService(), session.user.id, projectId, report as ReportKey);
    const out = await renderReport(table, format);
    const name = `${report.replace(/_/g, "-")}-${new Date().toISOString().slice(0, 10)}.${out.extension}`;
    return new NextResponse(new Uint8Array(out.body), {
      headers: {
        "Content-Type": out.contentType,
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
