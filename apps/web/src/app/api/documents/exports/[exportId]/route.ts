import { Readable } from "node:stream";
import { AppError } from "@researchmate/shared";
import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, sessionFromRequest } from "@/server/http";
import { documentService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/documents/exports/:id — streams a finished DOCX/PDF export to a project member. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ exportId: string }> }) {
  try {
    const session = await sessionFromRequest(req);
    const { exportId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(exportId)) throw new AppError("NOT_FOUND", "Export not found.");
    const x = await (await documentService()).openExport(session.user.id, exportId);
    const ascii = x.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    return new NextResponse(Readable.toWeb(x.stream) as ReadableStream, {
      headers: {
        "Content-Type": x.contentType,
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(x.filename)}`,
        ...(x.size ? { "Content-Length": String(x.size) } : {}),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
